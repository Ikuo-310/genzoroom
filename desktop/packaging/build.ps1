param(
    [string]$PythonPath,
    [switch]$Smoke
)
$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
if (-not $PythonPath) { $PythonPath = Join-Path $repository '.venv/Scripts/python.exe' }
$PythonPath = (Resolve-Path $PythonPath).Path
$outputRoot = Join-Path $PSScriptRoot 'out'
$run = Join-Path $outputRoot ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8))
$packagePython = Join-Path $PSScriptRoot '.venv/Scripts/python.exe'

function Invoke-Checked([string]$Executable, [string[]]$Arguments) {
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Build command failed ($LASTEXITCODE): $Executable" }
}

# Restore build-only environment even if freezing or Cargo fails.
$variables = @('VITE_GENZOROOM_CHANNEL','VITE_GENZOROOM_VERSION','VITE_GENZOROOM_COMMIT','TAURI_CONFIG','CARGO_TARGET_DIR')
$previous = @{}
foreach ($name in $variables) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
Push-Location $repository
try {
    $commit = (& git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Git identity unavailable' }
    Invoke-Checked 'uv' @('venv','--allow-existing','--python',$PythonPath,(Join-Path $PSScriptRoot '.venv'))
    Invoke-Checked 'uv' @('pip','sync','--python',$packagePython,'--require-hashes',(Join-Path $PSScriptRoot 'runtime.lock'),(Join-Path $PSScriptRoot 'build.lock'))
    $env:VITE_GENZOROOM_CHANNEL = 'validation'
    $env:VITE_GENZOROOM_VERSION = '0.0.0-validation'
    $env:VITE_GENZOROOM_COMMIT = $commit
    Push-Location (Join-Path $repository 'frontend')
    try { Invoke-Checked 'npm' @('ci'); Invoke-Checked 'npm' @('run','build') } finally { Pop-Location }
    Invoke-Checked $packagePython @((Join-Path $PSScriptRoot 'package_backend.py'),'--output',$run,'--commit',$commit)
    $backend = Join-Path $run 'dist/genzoroom-backend'
    Invoke-Checked $packagePython @((Join-Path $PSScriptRoot 'verify_bundle.py'),$backend,'--frontend',(Join-Path $repository 'frontend/dist'))
    Invoke-Checked (Join-Path $backend 'genzoroom-backend.exe') @('--check-runtime')
    $stage = Join-Path $outputRoot 'staged'
    # Only disposable staging is replaced; completed builds and user data are never cleaned here.
    if ([IO.Path]::GetFullPath($stage) -ne [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'out/staged'))) { throw 'Invalid staging path' }
    if (Test-Path $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    Copy-Item -LiteralPath $backend -Destination (Join-Path $stage 'backend') -Recurse
    $env:TAURI_CONFIG = Get-Content (Join-Path $repository 'desktop/tauri.bundle.conf.json') -Raw
    $env:CARGO_TARGET_DIR = Join-Path $repository 'desktop/target/distribution'
    $tauriOutput = Join-Path $env:CARGO_TARGET_DIR 'x86_64-pc-windows-msvc/release'
    $resourceBackend = Join-Path $tauriOutput 'backend'
    # Cargo resources are otherwise additive across builds; obsolete DLLs must not survive updates.
    if ([IO.Path]::GetFullPath($resourceBackend) -ne [IO.Path]::GetFullPath((Join-Path $repository 'desktop/target/distribution/x86_64-pc-windows-msvc/release/backend'))) { throw 'Invalid resource output path' }
    if (Test-Path $resourceBackend) { Remove-Item -LiteralPath $resourceBackend -Recurse -Force }
    # Rerun this package's build script even when Cargo's source timestamps are unchanged.
    Invoke-Checked 'cargo' @('clean','--manifest-path',(Join-Path $repository 'desktop/Cargo.toml'),'--package','genzoroom-desktop','--release','--target','x86_64-pc-windows-msvc')
    $features = if ($Smoke) { 'bundled-backend,webview-smoke' } else { 'bundled-backend' }
    Invoke-Checked 'cargo' @('build','--locked','--manifest-path',(Join-Path $repository 'desktop/Cargo.toml'),'--release','--target','x86_64-pc-windows-msvc','--features',$features)
    # Validate Tauri's resources output, not a separate copy that could hide a broken merge config.
    Invoke-Checked $packagePython @((Join-Path $PSScriptRoot 'verify_bundle.py'),$resourceBackend,'--host',(Join-Path $tauriOutput 'genzoroom-desktop.exe'))
    $application = Join-Path $run 'application'
    New-Item -ItemType Directory -Path $application | Out-Null
    Copy-Item -LiteralPath (Join-Path $env:CARGO_TARGET_DIR 'x86_64-pc-windows-msvc/release/genzoroom-desktop.exe') -Destination $application
    Copy-Item -LiteralPath $resourceBackend -Destination (Join-Path $application 'backend') -Recurse
    Invoke-Checked $packagePython @((Join-Path $PSScriptRoot 'verify_bundle.py'),(Join-Path $application 'backend'))
    $manifest = Get-Content (Join-Path $backend 'build-manifest.json') -Raw | ConvertFrom-Json
    $tools = @{ node=(Invoke-Checked 'node' @('--version')); npm=(Invoke-Checked 'npm' @('--version'));
                rust=(Invoke-Checked 'rustc' @('--version')); cargo=(Invoke-Checked 'cargo' @('--version')); uv=(Invoke-Checked 'uv' @('--version')) }
    @{ formatVersion=1; application=$application; smoke=[bool]$Smoke; manifest=$manifest; tools=$tools;
       hostSha256=(Get-FileHash -LiteralPath (Join-Path $application 'genzoroom-desktop.exe') -Algorithm SHA256).Hash } |
        ConvertTo-Json -Depth 15 | Set-Content -LiteralPath (Join-Path $run 'distribution-complete.json') -Encoding utf8
    Write-Output "GenzoRoom distribution completed: $application"
} finally {
    Pop-Location
    foreach ($name in $variables) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
}
