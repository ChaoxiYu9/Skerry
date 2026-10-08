Add-Type -AssemblyName System.Drawing

$sourcePath = Join-Path $PSScriptRoot "..\..\Skerry_V2.png"
$source = [System.Drawing.Image]::FromFile($sourcePath)
try {
    $outputs = @(
        @{ Path = (Join-Path $PSScriptRoot "..\public\images\skerry.png"); Size = 256 },
        @{ Path = (Join-Path $PSScriptRoot "..\skerry-v2-icon-source.png"); Size = 1024 }
    )

    foreach ($output in $outputs) {
        $size = [int]$output.Size
        $bitmap = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        try {
            $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
            try {
                $graphics.Clear([System.Drawing.Color]::Transparent)
                $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
                $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
                $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
                $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

                $padding = [Math]::Max(2, [Math]::Round($size * 0.025))
                $available = $size - ($padding * 2)
                $scale = [Math]::Min($available / [double]$source.Width, $available / [double]$source.Height)
                $width = [Math]::Round($source.Width * $scale)
                $height = [Math]::Round($source.Height * $scale)
                $x = [Math]::Floor(($size - $width) / 2)
                $y = [Math]::Floor(($size - $height) / 2)

                $path = New-Object System.Drawing.Drawing2D.GraphicsPath
                try {
                    $path.AddEllipse($padding, $padding, $size - ($padding * 2), $size - ($padding * 2))
                    $graphics.SetClip($path)
                    $graphics.DrawImage($source, $x, $y, $width, $height)
                } finally {
                    $path.Dispose()
                }
            } finally {
                $graphics.Dispose()
            }
            $bitmap.Save($output.Path, [System.Drawing.Imaging.ImageFormat]::Png)
        } finally {
            $bitmap.Dispose()
        }
    }
} finally {
    $source.Dispose()
}
