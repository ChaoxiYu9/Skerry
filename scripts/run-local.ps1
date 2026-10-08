param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Command,
    [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
    [string[]]$Arguments
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$cacheRoot = Join-Path $projectRoot ".project-cache"

New-Item -ItemType Directory -Force -Path `
    $cacheRoot, `
    (Join-Path $cacheRoot "cargo-home"), `
    (Join-Path $cacheRoot "pnpm-store"), `
    (Join-Path $cacheRoot "pnpm-cache"), `
    (Join-Path $cacheRoot "vite") | Out-Null

$env:CARGO_HOME = Join-Path $cacheRoot "cargo-home"
$env:CARGO_TARGET_DIR = Join-Path $projectRoot "src-tauri\target"
$env:npm_config_store_dir = Join-Path $cacheRoot "pnpm-store"
$env:npm_config_cache = Join-Path $cacheRoot "pnpm-cache"
$env:VITE_CACHE_DIR = Join-Path $cacheRoot "vite"
$env:RUST_MIN_STACK = "33554432"
if (-not $env:CARGO_BUILD_JOBS) { $env:CARGO_BUILD_JOBS = "4" }

Set-Location -LiteralPath $projectRoot

if ($Command -eq "tauri") {
    & pnpm tauri @Arguments
} else {
    & pnpm run $Command @Arguments
}
exit $LASTEXITCODE
