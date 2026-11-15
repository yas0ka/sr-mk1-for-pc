# 配布用のファイルを作る
#   dist\SR-MK1 for PC\                       アプリ本体 (1 フォルダ)
#   dist\SR-MK1-for-PC-<版>-setup.exe         インストーラー
#   dist\SR-MK1-for-PC-<版>-portable.zip      インストールせずに使う版 (展開して exe を起動)
#
# 使い方 (リポジトリの一番上で):  powershell -ExecutionPolicy Bypass -File packaging\build.ps1
# 前もって:  python -m venv .venv ; .venv\Scripts\pip install -r requirements.txt pyinstaller
#           Inno Setup 6 (winget install JRSoftware.InnoSetup)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$py = Join-Path $root ".venv\Scripts\python.exe"
if (-not (Test-Path $py)) { $py = "python" }
$version = & $py -c "import sys; sys.path.insert(0, 'app'); from version import VERSION; print(VERSION)"
$name = "SR-MK1 for PC"
Write-Host "== $name $version =="

# 1. アプリ本体 (先に同梱ソフトのライセンス表示を作り直す)
& $py packaging/third_party.py
if ($LASTEXITCODE) { throw "ライセンス表示を作れませんでした" }
& $py -m PyInstaller --noconfirm --clean --distpath dist --workpath build packaging\sr-mk1-for-pc.spec
if ($LASTEXITCODE) { throw "PyInstaller に失敗しました" }
# exe と同じフォルダに、説明とライセンスを置く
Copy-Item LICENSE.txt, THIRD_PARTY_NOTICES.txt "dist\$name\"
Copy-Item packaging/readme-dist.txt "dist\$name\はじめにお読みください.txt"

# 2. インストーラー
$iscc = @("$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe", "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe") |
    Where-Object { Test-Path $_ } | Select-Object -First 1
if ($iscc) {
    & $iscc /Q "/DAppVersion=$version" packaging\installer.iss
    if ($LASTEXITCODE) { throw "Inno Setup に失敗しました" }
} else {
    Write-Warning "Inno Setup が見つからないので、インストーラーは作りません"
}

# 3. zip (フォルダごと入れる)
$zip = "dist\SR-MK1-for-PC-$version-portable.zip"
if (Test-Path $zip) { Remove-Item $zip }
Compress-Archive -Path "dist\$name" -DestinationPath $zip -CompressionLevel Optimal

Get-ChildItem dist -File | Select-Object Name, @{ n = "MB"; e = { [math]::Round($_.Length / 1MB, 1) } } | Format-Table
