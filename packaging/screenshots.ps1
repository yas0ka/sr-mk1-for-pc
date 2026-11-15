# マニュアル用の画面写真を docs\images に撮る (疑似 API の見本の状態を Edge の headless で表示)
# 使い方 (リポジトリの一番上で):  powershell -ExecutionPolicy Bypass -File packaging\screenshots.ps1
$ErrorActionPreference = "Continue"   # Edge は進み具合を stderr に書くので、止めない
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root "docs\images"
New-Item -ItemType Directory -Force $out | Out-Null
$edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
$port = 8766

$server = Start-Process python -ArgumentList "-m", "http.server", $port, "--bind", "127.0.0.1", "--directory", (Join-Path $root "app\web") -PassThru -WindowStyle Hidden
try {
    Start-Sleep 2
    foreach ($demo in "main", "flag", "setup", "calib") {
        $profile = Join-Path $env:TEMP "sr-mk1-shot-$demo"
        if (Test-Path $profile) { Remove-Item -Recurse -Force $profile }
        $png = Join-Path $out "$demo.png"
        & $edge --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 `
            --user-data-dir="$profile" --window-size=1280,800 --virtual-time-budget=6000 `
            --screenshot="$png" "http://127.0.0.1:$port/?mock&demo=$demo" 2>$null | Out-Null
        Write-Host "$png"
    }
} finally {
    Stop-Process -Id $server.Id -ErrorAction SilentlyContinue
}
