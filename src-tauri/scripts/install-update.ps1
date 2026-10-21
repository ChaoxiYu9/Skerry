param(
    [Parameter(Mandatory = $true)][int]$ParentProcessId,
    [Parameter(Mandatory = $true)][string]$InstallerPath,
    [Parameter(Mandatory = $true)][string]$ApplicationPath
)

$ErrorActionPreference = 'Stop'
$logPath = Join-Path $env:TEMP 'skerry_updates\install-update.log'

function Write-UpdateLog([string]$message) {
    $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -LiteralPath $logPath -Value "[$timestamp] $message" -Encoding UTF8
}

try {
    $logDirectory = Split-Path -Parent $logPath
    New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
    Write-UpdateLog "Waiting for Skerry process $ParentProcessId to exit."

    $deadline = (Get-Date).AddSeconds(120)
    while (Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue) {
        if ((Get-Date) -ge $deadline) {
            throw 'Timed out while waiting for Skerry to exit.'
        }
        Start-Sleep -Milliseconds 250
    }

    if (-not (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) {
        throw "Installer does not exist: $InstallerPath"
    }

    $extension = [IO.Path]::GetExtension($InstallerPath).ToLowerInvariant()
    if ($extension -eq '.msi') {
        $quotedInstaller = '"' + $InstallerPath.Replace('"', '""') + '"'
        $process = Start-Process -FilePath "$env:SystemRoot\System32\msiexec.exe" `
            -ArgumentList "/i $quotedInstaller /qn /norestart" -PassThru -Wait
    } elseif ($extension -eq '.exe' -and $InstallerPath.ToLowerInvariant().EndsWith('-setup.exe')) {
        # Tauri's Windows NSIS bundle uses /S for a silent per-user upgrade.
        $process = Start-Process -FilePath $InstallerPath -ArgumentList '/S' -PassThru -Wait
    } else {
        throw "Unsupported installer format: $extension"
    }

    if ($process.ExitCode -ne 0 -and $process.ExitCode -ne 3010) {
        throw "Installer exited with code $($process.ExitCode)."
    }

    Write-UpdateLog "Installer completed with exit code $($process.ExitCode). Restarting $ApplicationPath."
    Start-Sleep -Milliseconds 500
    Start-Process -FilePath $ApplicationPath
} catch {
    try {
        Write-UpdateLog "Update failed: $($_.Exception.Message)"
        if (Test-Path -LiteralPath $ApplicationPath -PathType Leaf) {
            Start-Process -FilePath $ApplicationPath
        }
    } catch {
        # Keep the helper silent; the log remains available under %TEMP%\skerry_updates.
    }
    exit 1
}
