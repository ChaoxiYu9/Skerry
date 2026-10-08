param(
    [ValidateSet("Debug", "Release")]
    [string]$Configuration = "Release"
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$outputDirectory = Join-Path $projectRoot "native/Skerry.Native/bin/x64/$Configuration/net8.0-windows10.0.22621.0"
$servicePath = Join-Path $outputDirectory "skerry-native-service.exe"

if (-not (Test-Path -LiteralPath $servicePath)) {
    & (Join-Path $PSScriptRoot "build-native.ps1") -Configuration $Configuration
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}

$process = Start-Process -FilePath $servicePath -WorkingDirectory $outputDirectory -PassThru
try {
    $deadline = [DateTime]::UtcNow.AddSeconds(12)
    $connected = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        try {
            $probe = [System.IO.Pipes.NamedPipeClientStream]::new(
                ".",
                "skerry-native-ipc",
                [System.IO.Pipes.PipeDirection]::InOut,
                [System.IO.Pipes.PipeOptions]::Asynchronous)
            $probe.Connect(300)
            $probe.Dispose()
            $connected = $true
            break
        } catch {
            Start-Sleep -Milliseconds 250
        }
    }
    if (-not $connected) {
        throw "Named pipe did not become available."
    }

    function Invoke-SkerryNativeIpc([string]$Method, $Payload = $null) {
        $pipe = [System.IO.Pipes.NamedPipeClientStream]::new(
            ".",
            "skerry-native-ipc",
            [System.IO.Pipes.PipeDirection]::InOut,
            [System.IO.Pipes.PipeOptions]::Asynchronous)
        try {
            $pipe.Connect(2000)
            $request = @{ method = $Method; payload = $Payload } | ConvertTo-Json -Compress -Depth 12
            $bytes = [Text.Encoding]::UTF8.GetBytes($request + [char]10)
            $pipe.Write($bytes, 0, $bytes.Length)
            $pipe.Flush()
            $reader = [IO.StreamReader]::new($pipe, [Text.Encoding]::UTF8, $false, 4096, $true)
            $line = $reader.ReadLine()
            if ([string]::IsNullOrWhiteSpace($line)) {
                throw "IPC response was empty for method $Method."
            }

            $response = $line | ConvertFrom-Json
            if (-not $response.ok) {
                throw "IPC method $Method failed: $($response.error)"
            }
            return $response.data
        } finally {
            $pipe.Dispose()
        }
    }

    $ping = Invoke-SkerryNativeIpc "ping"
    if (-not $ping.pong) {
        throw "Ping response did not contain pong=true."
    }

    $appInfo = Invoke-SkerryNativeIpc "appInfo"
    $games = Invoke-SkerryNativeIpc "games.list" @{ limit = 3 }

    [pscustomobject]@{
        configuration = $Configuration
        service = $servicePath
        serviceName = $appInfo.name
        version = $appInfo.version
        pipe = $appInfo.pipe
        sampledGames = @($games).Count
        firstGame = if (@($games).Count -gt 0) { @($games)[0].title } else { $null }
    } | ConvertTo-Json -Depth 4
} finally {
    if ($process -and -not $process.HasExited) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
}
