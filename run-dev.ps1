[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repository = [System.IO.Path]::GetFullPath($PSScriptRoot)
$frontend = Join-Path $repository 'frontend'
$frontendDist = Join-Path $frontend 'dist'
$desktop = Join-Path $repository 'desktop'
$desktopAssets = Join-Path $desktop 'assets'
$python = Join-Path $repository '.venv\Scripts\python.exe'
$mutex = $null
$ownsMutex = $false

function Invoke-Checked {
    param([string]$Executable, [string[]]$Arguments, [string]$WorkingDirectory)

    Push-Location $WorkingDirectory
    try {
        & $Executable @Arguments
        $result = $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
    if ($result -ne 0) {
        throw "Command failed with exit code ${result}: $Executable $($Arguments -join ' ')"
    }
}

function Get-RelativeFilePath {
    param([string]$BasePath, [string]$FilePath)

    $separator = [System.IO.Path]::DirectorySeparatorChar
    $base = [System.IO.Path]::GetFullPath($BasePath).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + $separator
    $file = [System.IO.Path]::GetFullPath($FilePath)
    if (-not $file.StartsWith($base, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "File is outside the expected asset directory: $FilePath"
    }
    return $file.Substring($base.Length)
}

try {
    $mutex = [System.Threading.Mutex]::new($false, 'Local\GenzoRoom.RunDev.Build')
    try { $ownsMutex = $mutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { throw 'Another run-dev.ps1 build or launch is already active.' }

    $running = @(Get-Process -Name 'genzoroom-desktop' -ErrorAction SilentlyContinue)
    if ($running.Count -gt 0) {
        throw 'GenzoRoom is already running. Close it before rebuilding or launching the development version.'
    }

    foreach ($tool in @('node.exe', 'npm.cmd', 'cargo.exe', 'rustc.exe')) {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "Required tool not found on PATH: $tool" }
    }
    if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
        throw "Repository Python environment is missing: $python"
    }

    $nodeVersion = (& node.exe --version).TrimStart('v')
    if ($LASTEXITCODE -ne 0 -or [version]$nodeVersion -lt [version]'22.12') {
        throw 'Node.js 22.12 or newer is required by the Frontend.'
    }
    $rustHost = (& rustc.exe -vV | Where-Object { $_ -like 'host: *' }) -replace '^host: ', ''
    if ($LASTEXITCODE -ne 0 -or $rustHost -ne 'x86_64-pc-windows-msvc') {
        throw "Rust stable MSVC toolchain is required; detected host: $rustHost"
    }

    Write-Host 'Building the latest Frontend source...'
    Invoke-Checked 'npm.cmd' @('run', 'build') $frontend

    $index = Join-Path $frontendDist 'index.html'
    if (-not (Test-Path -LiteralPath $index -PathType Leaf)) { throw 'Frontend build did not produce dist/index.html.' }
    if (-not (Test-Path -LiteralPath $desktopAssets -PathType Container)) {
        New-Item -ItemType Directory -Path $desktopAssets | Out-Null
    }

    Write-Host 'Syncing the built Frontend into Tauri desktop/assets...'
    & robocopy.exe $frontendDist $desktopAssets /MIR /COPY:DAT /DCOPY:DAT /R:2 /W:1 /NFL /NDL /NJH /NJS /NP
    $copyResult = $LASTEXITCODE
    if ($copyResult -ge 8) { throw "Frontend asset sync failed with robocopy exit code $copyResult." }

    $sourceFiles = @(Get-ChildItem -LiteralPath $frontendDist -File -Recurse | ForEach-Object {
        Get-RelativeFilePath $frontendDist $_.FullName
    } | Sort-Object)
    $assetFiles = @(Get-ChildItem -LiteralPath $desktopAssets -File -Recurse | ForEach-Object {
        Get-RelativeFilePath $desktopAssets $_.FullName
    } | Sort-Object)
    if (Compare-Object -ReferenceObject $sourceFiles -DifferenceObject $assetFiles) {
        throw 'Tauri assets do not exactly match the latest Frontend build output.'
    }
    foreach ($relativePath in $sourceFiles) {
        $sourceHash = (Get-FileHash -LiteralPath (Join-Path $frontendDist $relativePath) -Algorithm SHA256).Hash
        $assetHash = (Get-FileHash -LiteralPath (Join-Path $desktopAssets $relativePath) -Algorithm SHA256).Hash
        if ($sourceHash -ne $assetHash) { throw "Tauri asset verification failed: $relativePath" }
    }

    Write-Host 'Building and launching the latest Windows Desktop source...'
    Invoke-Checked 'cargo.exe' @('run', '--locked', '--manifest-path', (Join-Path $desktop 'Cargo.toml')) $repository
}
catch {
    Write-Error $_
    exit 1
}
finally {
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
}
