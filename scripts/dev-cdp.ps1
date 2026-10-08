# scripts/dev-cdp.ps1
$nodeBin = "C:\Users\Cxiy\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin"
$pnpm = "C:\Users\Cxiy\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd"
$cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
$env:PATH = "$nodeBin;$cargoBin;$env:PATH"
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"
$env:WEBVIEW2_USER_DATA_FOLDER="$env:TEMP\skerry-webview2-cdp"
& $pnpm tauri dev
