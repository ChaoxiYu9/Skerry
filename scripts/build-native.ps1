param(
    [ValidateSet("Debug", "Release")]
    [string]$Configuration = "Debug"
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$cargoManifest = Join-Path $projectRoot "src-tauri/Cargo.toml"
$nativeProject = Join-Path $projectRoot "native/Skerry.Native/Skerry.Native.csproj"

Set-Location -LiteralPath $projectRoot

Write-Host "Building native Rust service ($Configuration)..."
if ($Configuration -eq "Release") {
    & cargo build --manifest-path $cargoManifest --no-default-features --features native-service --bin skerry-native-service --release
} else {
    & cargo build --manifest-path $cargoManifest --no-default-features --features native-service --bin skerry-native-service
}
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

Write-Host "Building native WinUI application ($Configuration)..."
& dotnet build $nativeProject -c $Configuration -p:Platform=x64 --no-restore
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

$outputDirectory = Join-Path $projectRoot "native/Skerry.Native/bin/x64/$Configuration/net8.0-windows10.0.22621.0"
$generatedWebViewArtifacts = Get-ChildItem -LiteralPath $outputDirectory -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "*WebView2*" }
foreach ($artifact in $generatedWebViewArtifacts) {
    Remove-Item -LiteralPath $artifact.FullName -Force
}

$application = Join-Path $outputDirectory "Skerry.Native.exe"
$service = Join-Path $outputDirectory "skerry-native-service.exe"
if (-not (Test-Path -LiteralPath $application)) {
    throw "Native application output was not produced: $application"
}
if (-not (Test-Path -LiteralPath $service)) {
    throw "Native service was not copied to the application output: $service"
}

$webViewArtifacts = Get-ChildItem -LiteralPath $outputDirectory -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "*WebView2*" }
if ($webViewArtifacts) {
    throw "Native output still contains WebView2 artifacts: $($webViewArtifacts.FullName -join ', ')"
}

Write-Host "Native build complete: $outputDirectory"
