param(
    [ValidateSet("Debug", "Release")]
    [string]$Configuration = "Release"
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$outputDirectory = Join-Path $projectRoot "native/Skerry.Native/bin/x64/$Configuration/net8.0-windows10.0.22621.0"
$application = Join-Path $outputDirectory "Skerry.Native.exe"
$service = Join-Path $outputDirectory "skerry-native-service.exe"
$startupLog = Join-Path $outputDirectory "Skerry.Native.startup.log"
$serviceLog = Join-Path $outputDirectory "skerry-native-service.log"

function Stop-NativeProcess([string]$Name) {
    Get-Process -Name $Name -ErrorAction SilentlyContinue |
        Stop-Process -Force -ErrorAction SilentlyContinue
}

function Invoke-SkerryNativeIpc([string]$Method, $Payload = $null) {
    $pipe = [System.IO.Pipes.NamedPipeClientStream]::new(
        ".", "skerry-native-ipc", [System.IO.Pipes.PipeDirection]::InOut,
        [System.IO.Pipes.PipeOptions]::Asynchronous)
    try {
        $pipe.Connect(2000)
        $request = @{ method = $Method; payload = $Payload } | ConvertTo-Json -Compress -Depth 12
        $bytes = [Text.Encoding]::UTF8.GetBytes($request + [char]10)
        $pipe.Write($bytes, 0, $bytes.Length)
        $pipe.Flush()
        $reader = [IO.StreamReader]::new($pipe, [Text.Encoding]::UTF8, $false, 4096, $true)
        $line = $reader.ReadLine()
        if ([string]::IsNullOrWhiteSpace($line)) { throw "IPC response was empty for method $Method." }
        $response = $line | ConvertFrom-Json
        if (-not $response.ok) { throw "IPC method $Method failed: $($response.error)" }
        return $response.data
    }
    finally { $pipe.Dispose() }
}

if (-not (Test-Path -LiteralPath $application) -or -not (Test-Path -LiteralPath $service)) {
    & (Join-Path $PSScriptRoot "build-native.ps1") -Configuration $Configuration
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Stop-NativeProcess "Skerry.Native"
Stop-NativeProcess "skerry-native-service"
Remove-Item -LiteralPath $startupLog, $serviceLog -Force -ErrorAction SilentlyContinue

$process = $null
$failure = $null
try {
    $process = Start-Process -FilePath $application -WorkingDirectory $outputDirectory -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    $pipeReady = $false
    $homeLoaded = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($process.HasExited) { throw "Skerry.Native.exe exited before native UI became ready (code $($process.ExitCode))." }
        if (Test-Path -LiteralPath $startupLog) {
            $log = Get-Content -Raw -LiteralPath $startupLog
            $homeLoaded = $log.Contains("HomePage.Loaded.end")
        }
        if (-not $pipeReady) {
            try {
                $probe = [System.IO.Pipes.NamedPipeClientStream]::new(
                    ".", "skerry-native-ipc", [System.IO.Pipes.PipeDirection]::InOut,
                    [System.IO.Pipes.PipeOptions]::Asynchronous)
                $probe.Connect(300)
                $probe.Dispose()
                $pipeReady = $true
            }
            catch { Start-Sleep -Milliseconds 150 }
        }
        if ($pipeReady -and $homeLoaded) { break }
        Start-Sleep -Milliseconds 150
    }
    if (-not $pipeReady) { throw "Named pipe did not become available within 20 seconds." }
    if (-not $homeLoaded) { throw "HomePage did not finish loading within 20 seconds." }

    $webViewModules = @($process.Modules | Where-Object { $_.ModuleName -match "WebView|Edge" })
    if ($webViewModules.Count -gt 0) {
        throw "Native UI loaded WebView/Edge modules: $($webViewModules.ModuleName -join ', ')"
    }

    $appInfo = Invoke-SkerryNativeIpc "appInfo"
    $games = Invoke-SkerryNativeIpc "games.list" @{ limit = 3 }
    if (-not $appInfo.name) { throw "appInfo returned no service name." }
    [pscustomobject]@{
        configuration = $Configuration
        application = $application
        service = $service
        serviceName = $appInfo.name
        version = $appInfo.version
        pipe = $appInfo.pipe
        sampledGames = @($games).Count
        firstGame = if (@($games).Count -gt 0) { @($games)[0].title } else { $null }
        homeLoaded = $homeLoaded
        loadedWebViewModules = $webViewModules.Count
    } | ConvertTo-Json -Depth 4
}
catch { $failure = $_ }
finally {
    if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
    Stop-NativeProcess "skerry-native-service"
    Start-Sleep -Milliseconds 500
}

$diagnosticLogs = @($startupLog, $serviceLog) | Where-Object { Test-Path -LiteralPath $_ }
$diagnosticErrors = foreach ($path in $diagnosticLogs) {
    Select-String -LiteralPath $path -Pattern "UnhandledException|failed|panic|ERROR|error:" -CaseSensitive:$false
}
if ($diagnosticErrors) {
    $details = $diagnosticErrors | ForEach-Object { "$($_.Path):$($_.LineNumber): $($_.Line)" }
    $message = "Native UI smoke found diagnostic errors: " + ($details -join "; ")
    if ($failure) { throw ($failure.ToString() + " | " + $message) }
    throw $message
}
if ($failure) { throw $failure }
