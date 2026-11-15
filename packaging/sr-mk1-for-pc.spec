# PyInstaller の設定 (1 フォルダ形式)。packaging/build.ps1 から使う。
#   dist/SR-MK1 for PC/SR-MK1 for PC.exe と _internal/ (Python 本体・ライブラリ・画面のファイル) ができる
import sys
from pathlib import Path

from PyInstaller.utils.win32.versioninfo import (FixedFileInfo, StringFileInfo, StringStruct, StringTable,
                                                 VarFileInfo, VarStruct, VSVersionInfo)

ROOT = Path(SPECPATH).parent
sys.path.insert(0, str(ROOT / "app"))
from version import APP_NAME, VERSION  # noqa: E402

nums = tuple(int(x) for x in VERSION.split(".")) + (0,) * (4 - len(VERSION.split(".")))
version_info = VSVersionInfo(
    ffi=FixedFileInfo(filevers=nums, prodvers=nums),
    kids=[
        StringFileInfo([StringTable("041104B0", [
            StringStruct("FileDescription", f"{APP_NAME} (テプラ PRO SR-MK1 対応・非公式)"),
            StringStruct("ProductName", APP_NAME),
            StringStruct("FileVersion", VERSION),
            StringStruct("ProductVersion", VERSION),
            StringStruct("OriginalFilename", f"{APP_NAME}.exe"),
        ])]),
        VarFileInfo([VarStruct("Translation", [0x0411, 1200])]),
    ],
)

a = Analysis(
    [str(ROOT / "app" / "main.py")],
    pathex=[str(ROOT), str(ROOT / "app")],
    datas=[(str(ROOT / "app" / "web"), "app/web")],
    hiddenimports=["api", "support", "version"],
    # 使わない画面の仕組み (pywebview は WebView2 = edgechromium だけを使う)
    excludes=["tkinter", "PyQt5", "PyQt6", "PySide2", "PySide6", "qtpy", "gi", "cefpython3",
              "numpy", "matplotlib"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, [],
    exclude_binaries=True,
    name=APP_NAME,
    icon=str(ROOT / "packaging" / "app.ico"),
    console=False,
    version=version_info,
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, name=APP_NAME, upx=False)
