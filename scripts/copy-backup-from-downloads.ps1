param(
  [string]$DownloadsDir = (Join-Path $env:USERPROFILE "Downloads"),
  [string]$ProjectDataFile = (Join-Path $PSScriptRoot "..\data\mj-history-backup.json")
)

$latest = Get-ChildItem -Path $DownloadsDir -Filter "mj-history-backup.json" -File -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

if (-not $latest) {
  Write-Error "未在 $DownloadsDir 找到 mj-history-backup.json，请先在扩展中点击「导出历史备份」。"
  exit 1
}

$dest = [System.IO.Path]::GetFullPath($ProjectDataFile)
New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
Copy-Item -Path $latest.FullName -Destination $dest -Force

$json = Get-Content $dest -Raw -Encoding UTF8 | ConvertFrom-Json
$dl = @($json.downloadHistory).Count
$pr = @($json.promptHistory).Count
Write-Host "已复制: $($latest.FullName)"
Write-Host " -> $dest"
Write-Host "下载记录: $dl 条, 查询记录: $pr 条, 导出时间: $($json.exportedAt)"
