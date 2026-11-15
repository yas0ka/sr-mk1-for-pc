"""SR-MK1 for PC — テプラ PRO SR-MK1 を Windows から使うラベルアプリ (非公式)

    python app/main.py           起動
    python app/main.py --debug   開発者ツール付きで起動
"""
from __future__ import annotations

import sys
from pathlib import Path

# 配布版 (PyInstaller) では同梱ファイルが sys._MEIPASS の下に展開される
ROOT = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(ROOT))          # tepra パッケージを読めるようにする
sys.path.insert(0, str(ROOT / "app"))

import webview  # noqa: E402

from support import log, setup_logging  # noqa: E402
from tepra.config import APP_DIR, Config, migrate_old_data  # noqa: E402
from version import APP_NAME, VERSION  # noqa: E402


WEBVIEW2_URL = "https://developer.microsoft.com/microsoft-edge/webview2/"
_WEBVIEW2_GUID = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"


def message_box(text: str, yes_no: bool = False) -> bool:
    """Windows の標準のメッセージボックス (画面がまだ出せないとき用)。yes_no なら「はい」で True。"""
    import ctypes
    flags = (0x04 | 0x30) if yes_no else 0x10      # MB_YESNO|MB_ICONWARNING / MB_ICONERROR
    return ctypes.windll.user32.MessageBoxW(None, text, APP_NAME, flags) == 6


def has_webview2() -> bool:
    """画面の表示に使う Microsoft Edge WebView2 ランタイムが入っているか。"""
    import winreg
    places = [(winreg.HKEY_LOCAL_MACHINE, rf"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{_WEBVIEW2_GUID}"),
              (winreg.HKEY_LOCAL_MACHINE, rf"SOFTWARE\Microsoft\EdgeUpdate\Clients\{_WEBVIEW2_GUID}"),
              (winreg.HKEY_CURRENT_USER, rf"Software\Microsoft\EdgeUpdate\Clients\{_WEBVIEW2_GUID}")]
    for root, path in places:
        try:
            with winreg.OpenKey(root, path) as k:
                pv = winreg.QueryValueEx(k, "pv")[0]
                if pv and pv != "0.0.0.0":
                    return True
        except OSError:
            continue
    return False


def main() -> None:
    moved = migrate_old_data()
    setup_logging()
    log.info("起動 %s %s", APP_NAME, VERSION)
    if not has_webview2():
        log.error("WebView2 ランタイムが見つかりません")
        if message_box("画面の表示に必要な「Microsoft Edge WebView2 ランタイム」が、このパソコンに入っていません。\n\n"
                       "マイクロソフトのページを開いて、「エバーグリーン ブートストラップ」をダウンロードして"
                       "インストールしてから、もう一度起動してください。\n\nページを開きますか？", yes_no=True):
            import webbrowser
            webbrowser.open(WEBVIEW2_URL)
        return
    if moved:
        log.info("開発中の保存場所から設定と履歴を写しました")

    from api import Api
    api = Api(Config.load())
    window = webview.create_window(
        APP_NAME,
        str(ROOT / "app" / "web" / "index.html"),
        js_api=api,
        width=1180, height=800, min_size=(900, 600),
    )
    api._set_window(window)
    window.events.closed += api.shutdown
    # private_mode=False: 作りかけのラベルや設定 (localStorage) を次回の起動に残す
    webview.start(debug="--debug" in sys.argv, private_mode=False,
                  storage_path=str(APP_DIR / "webview"))
    log.info("終了")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log.exception("起動できませんでした")
        if getattr(sys, "frozen", False):   # 配布版はコンソールがないので、画面で知らせる
            from support import LOG_DIR
            message_box(f"起動できませんでした。\n\n{type(e).__name__}: {e}\n\n詳しい記録: {LOG_DIR}")
        raise
