"""ログ、利用者向けのエラー文、ペアリング済みプリンタの検出。"""
from __future__ import annotations

import logging
import logging.handlers
import socket
import sys
import winreg

from tepra.config import APP_DIR
from tepra.transport import PrinterError

LOG_DIR = APP_DIR / "logs"
LOG_PATH = LOG_DIR / "app.log"
log = logging.getLogger("sr-mk1")


def setup_logging() -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    h = logging.handlers.RotatingFileHandler(LOG_PATH, maxBytes=500_000, backupCount=3, encoding="utf-8")
    h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(h)
    # 配布版 (コンソールなし) では stdout / stderr が無いので、書き込みで落ちないようログへ回す
    for name in ("stdout", "stderr"):
        if getattr(sys, name) is None:
            setattr(sys, name, _LogStream(logging.INFO if name == "stdout" else logging.ERROR))


class _LogStream:
    def __init__(self, level: int):
        self.level = level

    def write(self, text: str) -> int:
        if text.strip():
            log.log(self.level, text.rstrip())
        return len(text)

    def flush(self) -> None:
        pass


def recent_log(lines: int = 40) -> str:
    try:
        return "\n".join(LOG_PATH.read_text(encoding="utf-8", errors="replace").splitlines()[-lines:])
    except OSError:
        return "(ログなし)"


# ---------- 利用者向けのエラー文 ----------
NO_REPLY = ("プリンタから返事がありません。SR-MK1 の電源が入っているか、PC の近くにあるか、"
            "スマホのアプリがつながったままになっていないかを確かめてください。")


def friendly_error(e: BaseException) -> str:
    """例外を「何が起きたか + どうすればよいか」の文にする。"""
    if isinstance(e, PrinterError):
        return str(e)
    win = getattr(e, "winerror", None)
    if isinstance(e, (TimeoutError, socket.timeout)) or win in (10060, 10064):
        return NO_REPLY
    if win in (10050, 10051, 10065):
        return ("PC の Bluetooth がオフになっているか、Bluetooth アダプタが見つかりません。"
                "Windows の設定で Bluetooth をオンにしてください。")
    if win == 10061:
        return "プリンタが接続を受け付けませんでした。スマホのアプリがつながっていたら閉じてから、もう一度試してください。"
    if win in (10047, 10049) or isinstance(e, AttributeError) and "AF_BLUETOOTH" in str(e):
        return "この PC では Bluetooth の通信が使えません。Bluetooth アダプタがあるか確かめてください。"
    if isinstance(e, ConnectionError):
        return "プリンタとの接続が切れました。電源と距離を確かめてから、もう一度試してください。"
    if isinstance(e, OSError):
        return f"プリンタにつながりませんでした ({e.strerror or e})。電源と Bluetooth を確かめてください。"
    return f"思わぬエラーが起きました ({type(e).__name__}: {e})"


# ---------- ペアリング済みの Bluetooth 機器 ----------
_BT_DEVICES = r"SYSTEM\CurrentControlSet\Services\BTHPORT\Parameters\Devices"


def paired_devices() -> dict:
    """Windows にペアリングされている Bluetooth 機器を返す。

    {"bluetooth": レジストリが読めたか, "devices": [{address, name, sr_mk1}]}
    """
    out = []
    try:
        root = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, _BT_DEVICES)
    except OSError:
        return {"bluetooth": False, "devices": []}
    with root:
        i = 0
        while True:
            try:
                key = winreg.EnumKey(root, i)
            except OSError:
                break
            i += 1
            if len(key) != 12:
                continue
            address = ":".join(key[j:j + 2] for j in range(0, 12, 2)).upper()
            name = ""
            try:
                with winreg.OpenKey(root, key) as k:
                    raw = winreg.QueryValueEx(k, "Name")[0]
                    if isinstance(raw, bytes):
                        name = raw.split(b"\0", 1)[0].decode("utf-8", errors="replace")
                    else:
                        name = str(raw)
            except OSError:
                pass
            out.append({"address": address, "name": name or "(名前なし)",
                        "sr_mk1": "SR-MK1" in name.upper()})
    out.sort(key=lambda d: (not d["sr_mk1"], d["name"].lower()))
    return {"bluetooth": True, "devices": out}


def mask_address(address: str) -> str:
    """診断情報用: 後ろ半分を隠す (前半はメーカー番号)。"""
    parts = address.split(":")
    return ":".join(parts[:3] + ["**"] * (len(parts) - 3)) if len(parts) == 6 else ("(未設定)" if not address else "**")
