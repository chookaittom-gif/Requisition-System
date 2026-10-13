Add-Type -AssemblyName System.Drawing

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = (Get-Item "$scriptDir\..\..").FullName

$src = "$rootDir\docs\Inventory Dispatch Icon.png"
if (-not (Test-Path $src)) {
    Write-Error "Source image not found: $src"
    exit 1
}

$bmp = [System.Drawing.Bitmap]::FromFile($src)
$resized = New-Object System.Drawing.Bitmap(64, 64)
$g = [System.Drawing.Graphics]::FromImage($resized)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.DrawImage($bmp, 0, 0, 64, 64)
$g.Dispose()

$publicDir = "$rootDir\cloudflare\public"
$icoPath = "$publicDir\favicon.ico"
$pngPath = "$publicDir\favicon.png"

$hIcon = $resized.GetHicon()
$icon = [System.Drawing.Icon]::FromHandle($hIcon)
$fs = [System.IO.File]::Create($icoPath)
$icon.Save($fs)
$fs.Close()

$resized.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)

$resized.Dispose()
$bmp.Dispose()

Write-Host "Generated favicon.ico and favicon.png in $publicDir"
Get-Item $icoPath, $pngPath | Select-Object Name, Length
