$ErrorActionPreference = 'Stop'

# Generates extension icons + store artwork + Partner Center upload zip.
# NOTE: keep this script ASCII-only. PowerShell 5.1 reads BOM-less .ps1 as ANSI,
# so all CJK text is loaded from _locales/zh/messages.json (UTF-8) instead.

$root = 'E:\jingshouyan-workspace\soft-plm\tools\pdf-helper\pdf-coord-edge'
$outDir = Join-Path $root 'store-assets'
$iconsDir = Join-Path $root 'icons'
$publishDir = Join-Path $root 'publish'

New-Item -ItemType Directory -Force -Path $outDir, $iconsDir, $publishDir | Out-Null

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Read-Utf8Json($path) {
  $txt = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
  return $txt | ConvertFrom-Json
}

$zh = Read-Utf8Json (Join-Path $root '_locales\zh\messages.json')
$tileTitle = $zh.tileTitle.message
$tileSub = $zh.tileSubtitle.message

function PointsFromPx([single]$px, $g) { return [single]($px * 72.0 / $g.DpiY) }

function New-RoundedPath($x, $y, $w, $h, $r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  if ($d -gt $w) { $d = $w }
  if ($d -gt $h) { $d = $h }
  $p.AddArc($x, $y, $d, $d, 180, 90) | Out-Null
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90) | Out-Null
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90) | Out-Null
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90) | Out-Null
  $p.CloseFigure()
  return $p
}

# Draws the mark (origin axes at bottom-left + red cursor dot) into an existing bitmap size.
function Paint-Mark($g, $x0, $y0, $size) {
  $axL = $x0 + $size * 0.20
  $axB = $y0 + $size * 0.80
  $axR = $x0 + $size * 0.80
  $axT = $y0 + $size * 0.20
  $w = [Math]::Max(2, $size * 0.055)

  $penWhite = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), $w
  $penWhite.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $penWhite.EndCap = [System.Drawing.Drawing2D.LineCap]::ArrowAnchor

  $g.DrawLine($penWhite, $axL, $axB, $axR, $axB) | Out-Null
  $g.DrawLine($penWhite, $axL, $axB, $axL, $axT) | Out-Null

  $dotBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 77, 79))
  $r = $size * 0.085
  $dx = $x0 + $size * 0.60
  $dy = $y0 + $size * 0.38
  $g.FillEllipse($dotBrush, [single]($dx - $r), [single]($dy - $r), [single]($r * 2), [single]($r * 2)) | Out-Null

  $hair = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 77, 79)), ([Math]::Max(1, $size * 0.012))
  $g.DrawLine($hair, [single]$dx, [single]($dy + $r), [single]$dx, [single]$axB) | Out-Null
  $g.DrawLine($hair, [single]($dx + $r), [single]$dy, [single]$axR, [single]$dy) | Out-Null

  if ($size -ge 28) {
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = [System.Drawing.StringAlignment]::Center
    $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
    $f = New-Object System.Drawing.Font 'Segoe UI', (PointsFromPx ($size * 0.20) $g), ([System.Drawing.FontStyle]::Bold)
    $b = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 126, 226, 171))
    $rect = New-Object System.Drawing.RectangleF ([single]$axL), ([single]$axT), ([single]($size * 0.34)), ([single]($size * 0.22))
    $g.DrawString('pt', $f, $b, $rect, $sf) | Out-Null
  }
}

function New-LogoPng([int]$size, [string]$path) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.Clear([System.Drawing.Color]::Transparent)

  $pad = [Math]::Max(1, [int]($size * 0.04))
  $rect = New-Object System.Drawing.Rectangle $pad, $pad, ($size - 2 * $pad), ($size - 2 * $pad)
  $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, `
      ([System.Drawing.Color]::FromArgb(255, 31, 111, 74)), `
      ([System.Drawing.Color]::FromArgb(255, 18, 62, 44)), 45
  $path2 = New-RoundedPath $rect.X $rect.Y $rect.Width $rect.Height ($size * 0.20)
  $g.FillPath($grad, $path2) | Out-Null

  Paint-Mark $g 0 0 $size
  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "  icon  -> $path"
}

function Fit-Font($g, $text, $family, $style, $startPx, $maxW, $maxH) {
  $px = $startPx
  while ($px -gt 5) {
    $f = New-Object System.Drawing.Font $family, (PointsFromPx $px $g), $style
    $sz = $g.MeasureString($text, $f)
    if ($sz.Width -le $maxW -and $sz.Height -le $maxH) { return $f }
    $f.Dispose()
    $px = $px * 0.92
  }
  return New-Object System.Drawing.Font $family, (PointsFromPx 5 $g), $style
}

function New-TilePng([int]$w, [int]$h, [string]$path, [string]$sub) {
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.Clear([System.Drawing.Color]::FromArgb(255, 22, 24, 28))

  $markSize = [int]($h * 0.62)
  $mx = [int]($w * 0.045)
  $my = [int](($h - $markSize) / 2)

  $logoPath = Join-Path $env:TEMP 'coord-tile-logo.png'
  New-LogoPng 256 $logoPath | Out-Null
  $mark = New-Object System.Drawing.Bitmap $logoPath
  $g.DrawImage($mark, $mx, $my, $markSize, $markSize)
  $mark.Dispose()

  $tx = $mx + $markSize + [int]($w * 0.04)
  $tw = $w - $tx - [int]($w * 0.045)

  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = [System.Drawing.StringAlignment]::Near
  $sf.LineAlignment = [System.Drawing.StringAlignment]::Center

  $bold = [System.Drawing.FontStyle]::Bold
  $reg = [System.Drawing.FontStyle]::Regular
  $bTitle = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $bSub = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 154, 162, 177))

  if ($sub) {
    $fTitle = Fit-Font $g $tileTitle 'Microsoft YaHei' $bold ([int]($h * 0.20)) $tw ([int]($h * 0.40))
    $fSub = Fit-Font $g $sub 'Microsoft YaHei' $reg ([int]($h * 0.105)) $tw ([int]($h * 0.28))
    $rT = New-Object System.Drawing.RectangleF -ArgumentList ([single]$tx), ([single]($h * 0.15)), ([single]$tw), ([single]($h * 0.38))
    $rS = New-Object System.Drawing.RectangleF -ArgumentList ([single]$tx), ([single]($h * 0.55)), ([single]$tw), ([single]($h * 0.30))
    $g.DrawString($tileTitle, $fTitle, $bTitle, $rT, $sf) | Out-Null
    $g.DrawString($sub, $fSub, $bSub, $rS, $sf) | Out-Null
    $fTitle.Dispose(); $fSub.Dispose()
  } else {
    $fTitle = Fit-Font $g $tileTitle 'Microsoft YaHei' $bold ([int]($h * 0.22)) $tw ([int]($h * 0.70))
    $rT = New-Object System.Drawing.RectangleF -ArgumentList ([single]$tx), ([single]($h * 0.15)), ([single]$tw), ([single]($h * 0.70))
    $g.DrawString($tileTitle, $fTitle, $bTitle, $rT, $sf) | Out-Null
    $fTitle.Dispose()
  }
  $bTitle.Dispose(); $bSub.Dispose()

  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "  tile  -> $path"
}

Write-Host 'Generating extension icons...'
foreach ($s in 16, 32, 48, 128) { New-LogoPng $s (Join-Path $iconsDir "icon$s.png") }

Write-Host 'Generating store artwork...'
New-LogoPng 300 (Join-Path $outDir 'store-logo-300.png')
New-TilePng 440 280 (Join-Path $outDir 'promo-small-440x280.png') ''
New-TilePng 1400 560 (Join-Path $outDir 'promo-large-1400x560.png') $tileSub

Write-Host 'Building upload zip...'
$ver = (Read-Utf8Json (Join-Path $root 'manifest.json')).version
$zipPath = Join-Path $publishDir "pdf-coordinate-viewer-$ver.zip"
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }

$files = @(
  'manifest.json', 'background.js',
  'popup.html', 'popup.js',
  'viewer.html', 'viewer.css', 'viewer.js',
  'icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png', 'icons/icon128.png',
  'lib/pdf.min.js', 'lib/pdf.worker.min.js',
  '_locales/zh/messages.json', '_locales/en/messages.json'
)

# .NET Framework's CreateFromDirectory writes backslash entry names, which violates the
# ZIP spec and can break store parsing. Write entries explicitly with forward slashes.
$fs = [System.IO.File]::Open($zipPath, [System.IO.FileMode]::CreateNew)
try {
  $archive = New-Object System.IO.Compression.ZipArchive $fs, ([System.IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($rel in $files) {
      $src = Join-Path $root ($rel -replace '/', '\')
      if (-not (Test-Path -LiteralPath $src)) { throw "missing file in package: $rel" }
      $entry = $archive.CreateEntry($rel, [System.IO.Compression.CompressionLevel]::Optimal)
      $es = $entry.Open()
      try {
        $bytes = [System.IO.File]::ReadAllBytes($src)
        $es.Write($bytes, 0, $bytes.Length)
      } finally {
        $es.Dispose()
      }
    }
  } finally {
    $archive.Dispose()
  }
} finally {
  $fs.Dispose()
}

$check = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
  Write-Host "zip entries ($($check.Entries.Count)):"
  foreach ($e in $check.Entries) { Write-Host ("   {0}  {1}" -f $e.FullName, $e.Length) }
} finally { $check.Dispose() }

$gi = Get-Item -LiteralPath $zipPath
Write-Host ("ZIP -> {0}  ({1:N0} bytes)" -f $gi.FullName, $gi.Length)
