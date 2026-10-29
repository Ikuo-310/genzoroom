param(
    [string]$PythonPath,
    [string]$LightCraftExe,
    [switch]$Smoke,
    [switch]$Release
)
$ErrorActionPreference = 'Stop'
$tauriCliVersion = '2.12.2'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
if (-not $PythonPath) { $PythonPath = Join-Path $repository '.venv/Scripts/python.exe' }
$PythonPath = (Resolve-Path $PythonPath).Path
$metadataArguments = @((Join-Path $PSScriptRoot 'resolve_build_metadata.py'), '--repository', $repository)
if ($Release) { $metadataArguments += '--require-release' }
$metadataJson = & $PythonPath @metadataArguments
if ($LASTEXITCODE -ne 0) { throw 'Build metadata resolution failed' }
$buildMetadata = $metadataJson | ConvertFrom-Json
$distributionChannel = [string]$buildMetadata.channel
$distributionVersion = [string]$buildMetadata.version
$distributionCommit = [string]$buildMetadata.commit
$tauriVersion = [string]$buildMetadata.packageVersion
$outputRoot = Join-Path $PSScriptRoot 'out'
$run = Join-Path $outputRoot ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8))
$packagePython = Join-Path $PSScriptRoot '.venv/Scripts/python.exe'

function Invoke-Checked([string]$Executable, [string[]]$Arguments) {
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Build command failed ($LASTEXITCODE): $Executable" }
}

# LightCraft remains externally configured; an engine selected for this build must have verified provenance.
if (-not $LightCraftExe) { $LightCraftExe = $env:GENZOROOM_LIGHTCRAFT_EXE }
if ($LightCraftExe) {
    Invoke-Checked $PythonPath @((Join-Path $repository 'native/lightcraft/build.py'),'--binary',$LightCraftExe)
}

# Restore build-only environment even if freezing or Cargo fails.
$variables = @('VITE_GENZOROOM_CHANNEL','VITE_GENZOROOM_VERSION','VITE_GENZOROOM_COMMIT','TAURI_CONFIG','CARGO_TARGET_DIR')
$previous = @{}
foreach ($name in $variables) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
Push-Location $repository
try {
    $env:TAURI_CONFIG = $null
    $commit = $distributionCommit
    Invoke-Checked 'uv' @('venv','--allow-existing','--python',$PythonPath,(Join-Path $PSScriptRoot '.venv'))
    Invoke-Checked 'uv' @('pip','sync','--python',$packagePython,'--require-hashes',(Join-Path $PSScriptRoot 'runtime.lock'),(Join-Path $PSScriptRoot 'build.lock'))
    Invoke-Checked $packagePython @((Join-Path $PSScriptRoot 'generate_icons.py'))
    Invoke-Checked $packagePython @((Join-Path $PSScriptRoot 'test_icons.py'))
    $env:VITE_GENZOROOM_CHANNEL = $distributionChannel
    $env:VITE_GENZOROOM_VERSION = $distributionVersion
    $env:VITE_GENZOROOM_COMMIT = $commit
    Push-Location (Join-Path $repository 'frontend')
    try { Invoke-Checked 'npm' @('ci'); Invoke-Checked 'npm' @('run','build') } finally { Pop-Location }
    $desktopAssets = Join-Path $repository 'desktop/assets'
    New-Item -ItemType Directory -Path $desktopAssets -Force | Out-Null
    & robocopy.exe (Join-Path $repository 'frontend/dist') $desktopAssets /MIR /COPY:DAT /DCOPY:DAT /R:2 /W:1 /NFL /NDL /NJH /NJS /NP
    if ($LASTEXITCODE -ge 8) { throw "Tauri Frontend asset sync failed with robocopy exit code $LASTEXITCODE." }
    Invoke-Checked $packagePython @((Join-Path $PSScriptRoot 'package_backend.py'),'--output',$run,'--commit',$commit,
        '--channel',$distributionChannel,'--version',$distributionVersion)
    $backend = Join-Path $run 'dist/genzoroom-backend'
    Invoke-Checked $packagePython @((Join-Path $PSScriptRoot 'verify_bundle.py'),$backend,'--frontend',(Join-Path $repository 'frontend/dist'))
    Invoke-Checked (Join-Path $backend 'genzoroom-backend.exe') @('--check-runtime')
    $stage = Join-Path $outputRoot 'staged'
    # Only disposable staging is replaced; completed builds and user data are never cleaned here.
    if ([IO.Path]::GetFullPath($stage) -ne [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'out/staged'))) { throw 'Invalid staging path' }
    if (Test-Path $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    Copy-Item -LiteralPath $backend -Destination (Join-Path $stage 'backend') -Recurse
    Invoke-Checked $packagePython @((Join-Path $PSScriptRoot 'collect_distribution_materials.py'),'--stage',$stage,'--skip-rust')
    Invoke-Checked $packagePython @((Join-Path $PSScriptRoot 'verify_icons.py'))
    $tauriInstalled = ''
    try { $tauriInstalled = (Invoke-Checked 'cargo' @('tauri','--version') | Out-String).Trim() } catch { }
    if ($tauriInstalled -notmatch [regex]::Escape($tauriCliVersion)) {
        Invoke-Checked 'cargo' @('install','tauri-cli','--version',$tauriCliVersion,'--locked','--force')
        $tauriInstalled = (Invoke-Checked 'cargo' @('tauri','--version') | Out-String).Trim()
    }
    if ($tauriInstalled -notmatch [regex]::Escape($tauriCliVersion)) { throw 'Pinned Tauri CLI version unavailable' }
    $env:CARGO_TARGET_DIR = Join-Path $repository 'desktop/target/distribution'
    $tauriOutput = Join-Path $env:CARGO_TARGET_DIR 'x86_64-pc-windows-msvc/release'
    $resourceBackend = Join-Path $tauriOutput 'backend'
    $resourceDirectories = @($resourceBackend, (Join-Path $tauriOutput 'licenses'), (Join-Path $tauriOutput 'source'))
    $installerDirectory = Join-Path $tauriOutput 'bundle/nsis'
    # Remove only disposable resources and installers from the dedicated distribution target.
    foreach ($resourceDirectory in $resourceDirectories) {
        if ([IO.Path]::GetFullPath($resourceDirectory) -notlike ((Join-Path $repository 'desktop/target/distribution/x86_64-pc-windows-msvc/release') + '*')) { throw 'Invalid resource output path' }
        if (Test-Path $resourceDirectory) { Remove-Item -LiteralPath $resourceDirectory -Recurse -Force }
    }
    if (Test-Path $installerDirectory) { Remove-Item -LiteralPath $installerDirectory -Recurse -Force }
    Invoke-Checked 'cargo' @('clean','--manifest-path',(Join-Path $repository 'desktop/Cargo.toml'),'--package','genzoroom-desktop','--release','--target','x86_64-pc-windows-msvc')
    $features = if ($Smoke) { 'bundled-backend,webview-smoke' } else { 'bundled-backend' }
    # NSIS compares the package SemVer, while app metadata retains Docker's v-prefixed tag.
    $versionConfig = @{ version = $tauriVersion } | ConvertTo-Json -Compress
    Push-Location (Join-Path $repository 'desktop')
    try {
        # Resolve and compile locked Rust crates before collecting their license metadata.
        Invoke-Checked 'cargo' @('tauri','build','--target','x86_64-pc-windows-msvc','--features',$features,'--no-bundle','--config','tauri.bundle.conf.json','--config',$versionConfig,'--','--locked')
    } finally { Pop-Location }
    Invoke-Checked $packagePython @((Join-Path $PSScriptRoot 'collect_distribution_materials.py'),'--stage',$stage)
    # Cargo resources are additive; remove the preliminary build's license staging before final bundling.
    foreach ($resourceDirectory in $resourceDirectories) {
        if (Test-Path $resourceDirectory) { Remove-Item -LiteralPath $resourceDirectory -Recurse -Force }
    }
    Push-Location (Join-Path $repository 'desktop')
    try {
        Invoke-Checked 'cargo' @('tauri','build','--target','x86_64-pc-windows-msvc','--features',$features,'--bundles','nsis','--config','tauri.bundle.conf.json','--config',$versionConfig,'--','--locked')
    } finally { Pop-Location }
    # Validate Tauri's resources output, not a separate copy that could hide a broken merge config.
    Invoke-Checked $packagePython @((Join-Path $PSScriptRoot 'verify_bundle.py'),$resourceBackend,'--host',(Join-Path $tauriOutput 'genzoroom-desktop.exe'))
    foreach ($resourceName in @('licenses','source')) {
        if (-not (Test-Path (Join-Path $tauriOutput $resourceName))) { throw "Tauri resource is missing: $resourceName" }
    }
    $application = Join-Path $run 'application'
    New-Item -ItemType Directory -Path $application | Out-Null
    Copy-Item -LiteralPath (Join-Path $env:CARGO_TARGET_DIR 'x86_64-pc-windows-msvc/release/genzoroom-desktop.exe') -Destination $application
    foreach ($resourceName in @('backend','licenses','source')) {
        Copy-Item -LiteralPath (Join-Path $tauriOutput $resourceName) -Destination (Join-Path $application $resourceName) -Recurse
    }
    Invoke-Checked $packagePython @((Join-Path $PSScriptRoot 'verify_bundle.py'),(Join-Path $application 'backend'))
    Invoke-Checked $packagePython @((Join-Path $PSScriptRoot 'verify_icons.py'),'--host',(Join-Path $application 'genzoroom-desktop.exe'))
    $installer = @(Get-ChildItem -LiteralPath $installerDirectory -File -Filter '*-setup.exe')
    if ($installer.Count -ne 1) { throw 'Expected exactly one NSIS setup executable' }
    $installerCopy = Join-Path $run $installer[0].Name
    Copy-Item -LiteralPath $installer[0].FullName -Destination $installerCopy
    Invoke-Checked $packagePython @((Join-Path $PSScriptRoot 'verify_icons.py'),'--installer',$installerCopy)
    $manifest = Get-Content (Join-Path $backend 'build-manifest.json') -Raw | ConvertFrom-Json
    $tools = @{ node=(Invoke-Checked 'node' @('--version')); npm=(Invoke-Checked 'npm' @('--version'));
                rust=(Invoke-Checked 'rustc' @('--version')); cargo=(Invoke-Checked 'cargo' @('--version')); uv=(Invoke-Checked 'uv' @('--version')); tauri=$tauriInstalled }
    $artifactFiles = @()
    foreach ($root in @($application, $installerCopy)) {
        $isInstaller = Test-Path -LiteralPath $root -PathType Leaf
        $files = if ($isInstaller) { @(Get-Item -LiteralPath $root) } else { @(Get-ChildItem -LiteralPath $root -File -Recurse) }
        foreach ($file in $files) {
            $relative = if ($isInstaller) { Split-Path -Leaf $root } else { [IO.Path]::GetRelativePath($run, $file.FullName) }
            $artifactFiles += @{ path=$relative; bytes=$file.Length; sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash }
        }
    }
    @{ formatVersion=2; product='GenzoRoom'; channel=$distributionChannel; version=$distributionVersion; packageVersion=$tauriVersion; commit=$commit; application=$application; installer=$installerCopy; smoke=[bool]$Smoke; manifest=$manifest; tools=$tools;
       hostSha256=(Get-FileHash -LiteralPath (Join-Path $application 'genzoroom-desktop.exe') -Algorithm SHA256).Hash;
       installerSha256=(Get-FileHash -LiteralPath $installerCopy -Algorithm SHA256).Hash;
       installerBytes=(Get-Item -LiteralPath $installerCopy).Length; artifacts=$artifactFiles } |
        ConvertTo-Json -Depth 15 | Set-Content -LiteralPath (Join-Path $run 'distribution-complete.json') -Encoding utf8
    Write-Output "GenzoRoom application: $application"
    Write-Output "GenzoRoom NSIS installer: $installerCopy"
} finally {
    Pop-Location
    foreach ($name in $variables) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
}
