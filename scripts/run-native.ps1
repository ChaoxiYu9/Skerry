param(
    [ValidateSet("Debug", "Release")]
    [string]$Configuration = "Debug"
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$outputDirectory = Join-Path $projectRoot "native/Skerry.Native/bin/x64/$Configuration/net8.0-windows10.0.22621.0"
$application = Join-Path $outputDirectory "Skerry.Native.exe"
$service = Join-Path $outputDirectory "skerry-native-service.exe"

if (-not (Test-Path -LiteralPath $application) -or -not (Test-Path -LiteralPath $service)) {
    & (Join-Path $PSScriptRoot "build-native.ps1") -Configuration $Configuration
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}

$webViewArtifacts = Get-ChildItem -LiteralPath $outputDirectory -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "*WebView2*" }
if ($webViewArtifacts) {
    Write-Host "Cleaning stale WebView2 artifacts from native output..."
    & (Join-Path $PSScriptRoot "build-native.ps1") -Configuration $Configuration
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}

$webViewArtifacts = Get-ChildItem -LiteralPath $outputDirectory -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "*WebView2*" }
if ($webViewArtifacts) {
    throw "Native output still contains WebView2 artifacts: $($webViewArtifacts.FullName -join ', ')"
}

$process = Start-Process -FilePath $application -WorkingDirectory $outputDirectory -PassThru
Write-Host "Started Skerry.Native.exe (PID $($process.Id))"
