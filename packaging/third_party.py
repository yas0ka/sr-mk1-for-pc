"""配布物に同梱しているソフトウェアのライセンス表示 (THIRD_PARTY_NOTICES.txt) を作る。

ビルド用の環境で実行する:  .venv\\Scripts\\python packaging\\third_party.py
ライセンスの全文は、インストール済みパッケージの dist-info、同梱ライブラリの LICENSE、Python 本体の LICENSE.txt から写す。
"""
from __future__ import annotations

import importlib.metadata as md
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "THIRD_PARTY_NOTICES.txt"
VENDOR = ROOT / "app" / "web" / "vendor"

# (表示名, PyPI の配布名, ライセンス, URL)
PY_PACKAGES = [
    ("pywebview", "pywebview", "BSD 3-Clause License", "https://github.com/r0x0r/pywebview"),
    ("Pillow", "pillow", "MIT-CMU License (同梱のライブラリのライセンスを含む)", "https://python-pillow.github.io/"),
    ("pythonnet", "pythonnet", "MIT License", "https://github.com/pythonnet/pythonnet"),
    ("clr_loader", "clr_loader", "MIT License", "https://github.com/pythonnet/clr-loader"),
    ("bottle", "bottle", "MIT License", "https://bottlepy.org/"),
    ("proxy_tools", "proxy_tools", "MIT License", "https://pypi.org/project/proxy_tools/"),
    ("cffi", "cffi", "MIT License", "https://cffi.readthedocs.io/"),
    ("pycparser", "pycparser", "BSD 3-Clause License", "https://github.com/eliben/pycparser"),
    ("typing_extensions", "typing_extensions", "Python Software Foundation License", "https://github.com/python/typing_extensions"),
    ("setuptools", "setuptools", "MIT License", "https://github.com/pypa/setuptools"),
]


def dist_license(name: str) -> str | None:
    dist = md.distribution(name)
    for f in dist.files or []:
        upper = f.name.upper()
        if upper.startswith(("LICENSE", "LICENCE", "COPYING")) and "dist-info" in str(f.parent).lower():
            return Path(f.locate()).read_text(encoding="utf-8", errors="replace")
    return None


def section(title: str, version: str, license_name: str, url: str, text: str | None) -> str:
    head = f"{title} {version}".strip()
    body = text.strip() if text else f"(配布パッケージに全文が含まれていません。{url} を参照してください)"
    return "\n".join(["=" * 78, head, f"ライセンス: {license_name}", f"URL: {url}", "-" * 78, body, ""])


def main() -> None:
    parts = [
        "SR-MK1 for PC で使っているソフトウェアのライセンス",
        "",
        "SR-MK1 for PC 本体は MIT License です (LICENSE.txt)。",
        "配布物 (インストーラー・zip) には、次のソフトウェアが含まれています。",
        "",
    ]
    parts.append(section("Fabric.js", "6.4.3", "MIT License", "https://fabricjs.com/",
                         (VENDOR / "fabric-LICENSE.txt").read_text(encoding="utf-8")))
    parts.append(section("bwip-js (Barcode Writer in Pure PostScript を含む)", "4.5.1", "MIT License",
                         "https://github.com/metafloor/bwip-js",
                         (VENDOR / "bwip-js-LICENSE.txt").read_text(encoding="utf-8")))
    for title, dist, lic, url in PY_PACKAGES:
        parts.append(section(title, md.version(dist), lic, url, dist_license(dist)))
    parts.append(section("Microsoft.Web.WebView2 (pywebview に同梱の WebView2 SDK)", "1.0.3856.49",
                         "BSD スタイルのライセンス (Microsoft)", "https://www.nuget.org/packages/Microsoft.Web.WebView2",
                         (ROOT / "packaging" / "licenses" / "Microsoft.Web.WebView2-LICENSE.txt").read_text(encoding="utf-8")))
    py_license = Path(sys.base_prefix) / "LICENSE.txt"
    parts.append(section("Python", sys.version.split()[0],
                         "Python Software Foundation License (OpenSSL・libffi・bzip2・xz・zlib などのライセンスを含む)",
                         "https://www.python.org/", py_license.read_text(encoding="utf-8", errors="replace")))
    parts.append(section("PyInstaller (起動用プログラム)", md.version("pyinstaller"),
                         "GPL 2.0 以降 (例外条項つき)", "https://pyinstaller.org/",
                         "PyInstaller の起動用プログラム (bootloader) は、例外条項により、作られたプログラムを\n"
                         "どのようなライセンスでも配布できます。全文は https://github.com/pyinstaller/pyinstaller/blob/develop/COPYING.txt"))
    parts.append(section("Microsoft Visual C++ ランタイム (VCRUNTIME140.dll)", "", "Microsoft の再頒布可能ファイル",
                         "https://learn.microsoft.com/cpp/windows/redistributing-visual-cpp-files",
                         "Python 本体に含まれる再頒布可能なランタイムです。"))
    OUT.write_text("\n".join(parts), encoding="utf-8", newline="\r\n")
    print(OUT, f"{OUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
