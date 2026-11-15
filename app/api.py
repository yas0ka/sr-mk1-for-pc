"""画面 (JavaScript) から呼ばれる Python 側の API。

pywebview の js_api として公開し、JS からは window.pywebview.api.<メソッド>() で呼ぶ。
各メソッドは別スレッドで呼ばれるので、プリンタ接続はロックで守る。
(先頭が _ の属性は JS に公開されない)
"""
from __future__ import annotations

import base64
import io
import json
import logging
import os
import platform
import re
import threading
import time
import uuid
import webbrowser
import winreg
from pathlib import Path

from PIL import Image

from support import LOG_DIR, friendly_error, log, mask_address, paired_devices, recent_log
from tepra import protocol as P
from tepra import render
from tepra.config import APP_DIR, Calibration, Config
from tepra.printer import print_pages
from tepra.transport import Connection, PrinterError
from version import APP_NAME, REPO_URL, VERSION

HISTORY_PATH = APP_DIR / "history.json"
HISTORY_MAX = 50
HISTORY_PAGES_MAX_BYTES = 600_000   # これより大きい印刷は「もう一度印刷」用の画像を残さない
RULER_MM = 100                      # 寸法補正用の目盛りラベル (0〜100mm、両端の余白 5mm)
RULER_MARGIN_MM = 5.0


def decode_png(data_url: str) -> Image.Image:
    b64 = data_url.split(",", 1)[1]
    return Image.open(io.BytesIO(base64.b64decode(b64))).convert("L")


class PrinterService:
    """プリンタとの接続を保ち、状態取得と印刷ジョブを扱う。"""

    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.lock = threading.Lock()
        self.conn: Connection | None = None
        self.state = {"connected": False, "busy": False, "message": "未接続"}
        self.last_raw: bytes | None = None
        self.job: dict | None = None
        self.on_job_done = lambda job: None

    # ---------- 接続 ----------
    def _ensure(self) -> Connection:
        if not self.cfg.address:
            raise RuntimeError("プリンタがまだ選ばれていません。「設定」からプリンタを選んでください。")
        if self.conn is None:
            log.info("接続: %s", mask_address(self.cfg.address))
            self.conn = Connection(self.cfg.address, self.cfg.channel, timeout=8)
        return self.conn

    def _drop(self) -> None:
        if self.conn is not None:
            try:
                self.conn.close()
            except OSError:
                pass
            self.conn = None

    def _status_dict(self, s: P.Status) -> dict:
        tape = s.tape
        self.last_raw = s.raw
        return {
            "connected": True, "busy": False, "configured": True,
            "st": s.st, "er": s.er, "error": s.is_error,
            "tape_code": s.tape_code if tape else None,
            "tape_name": tape[0] if tape else None,
            "dots": tape[1] if tape else None,
            "cable": s.is_cable_tape,
            "message": s.advice() if s.is_error else s.describe(),
            "detail": s.describe(),
        }

    def status(self) -> dict:
        if not self.cfg.address:
            return {"connected": False, "busy": False, "configured": False,
                    "message": "プリンタがまだ選ばれていません"}
        # 印刷中などでロックが取れないときは前回の状態を返す (画面を固まらせない)
        if not self.lock.acquire(blocking=False):
            return {**self.state, "busy": True}
        try:
            s = self._ensure().request_status()
            self.state = self._status_dict(s)
        except Exception as e:  # 電源オフ・圏外など
            if self.state.get("connected"):
                log.info("接続が切れました: %r", e)
            self._drop()
            self.state = {"connected": False, "busy": False, "configured": True, "message": friendly_error(e)}
        finally:
            self.lock.release()
        return self.state

    def select(self, address: str, name: str) -> dict:
        """指定のプリンタにつないでみて、つながったら設定に保存する。"""
        if self.job and self.job["state"] in ("running", "paused"):
            return {"ok": False, "message": "印刷中はプリンタを変えられません。印刷を終えるか中止してください。"}
        address = (address or "").strip().upper()
        if not re.fullmatch(r"[0-9A-F]{2}(:[0-9A-F]{2}){5}", address):
            return {"ok": False, "message": "Bluetooth アドレスの形が正しくありません。"}
        with self.lock:
            self._drop()
            try:
                log.info("プリンタを確認: %s (%s)", name, mask_address(address))
                conn = Connection(address, self.cfg.channel, timeout=10)
                try:
                    s = conn.request_status()
                except Exception:
                    conn.close()
                    raise
            except Exception as e:
                log.warning("つながりませんでした: %r", e)
                return {"ok": False, "message": friendly_error(e)}
            self.conn = conn
            self.cfg.address, self.cfg.printer_name = address, name or "SR-MK1"
            self.cfg.save()
            self.state = self._status_dict(s)
        return {"ok": True, "status": self.state}

    def current_dots(self) -> int:
        """今入っているテープの印字ドット数 (テスト印刷用)。"""
        with self.lock:
            try:
                s = self._ensure().request_status()
            except Exception:
                self._drop()
                raise
            self.state = self._status_dict(s)
        if s.is_error:
            raise PrinterError(s)
        if not s.tape:
            raise RuntimeError("テープが入っていないか、このアプリでは使えないテープです。")
        return s.tape[1]

    # ---------- 印刷ジョブ ----------
    # pages: [{"png": dataURL, "margin": mm}, ...]  1 ページ = 1 ラベル
    # 1 ラベルずつ印刷し終わるのを待つので、途中で止まっても「どこまで出たか」が分かる。
    def start_job(self, pages: list[dict], density: int, meta: dict) -> dict:
        try:
            imgs = [(decode_png(p["png"]), float(p.get("margin", 2.0))) for p in pages]
        except Exception as e:
            log.exception("画像を読み込めません")
            return {"ok": False, "message": f"画像を読み込めません: {e}"}
        return self.start_images(imgs, density, meta, pages=pages)

    def start_images(self, imgs: list[tuple[Image.Image, float]], density: int, meta: dict,
                     pages: list[dict] | None = None, calibrate: bool = True) -> dict:
        """imgs: [(ラベル画像, 前後の余白 mm)]。calibrate=False は寸法補正用の目盛りラベル。"""
        if self.job and self.job["state"] in ("running", "paused"):
            return {"ok": False, "message": "前の印刷が終わっていません (中止するか、続きから印刷してください)"}
        self.job = {
            "id": uuid.uuid4().hex[:8], "state": "running", "done": 0, "total": len(imgs),
            "message": "印刷を始めます", "cancel": False,
            "_imgs": imgs, "_pages": pages or [], "_calibrate": calibrate,
            "density": int(density), "meta": meta or {},
        }
        log.info("印刷開始: %d 枚", len(imgs))
        threading.Thread(target=self._run_job, daemon=True).start()
        return {"ok": True, "message": f"{len(imgs)} 枚の印刷を始めました"}

    def resume_job(self) -> dict:
        j = self.job
        if not j or j["state"] != "paused":
            return {"ok": False, "message": "続きから印刷できるものはありません"}
        j.update(state="running", cancel=False, message="続きから印刷します")
        threading.Thread(target=self._run_job, daemon=True).start()
        return {"ok": True, "message": "続きから印刷します"}

    def cancel_job(self) -> dict:
        j = self.job
        if not j or j["state"] not in ("running", "paused"):
            return {"ok": False, "message": "印刷中のものはありません"}
        if j["state"] == "paused":
            j.update(state="canceled", message=f"中止しました ({j['done']}/{j['total']} 枚印刷済み)")
        else:
            j["cancel"] = True
            j["message"] = "今のラベルを印刷したら止めます"
        return {"ok": True, "message": j["message"]}

    def job_info(self) -> dict | None:
        j = self.job
        if not j:
            return None
        return {k: v for k, v in j.items() if not k.startswith("_") and k != "meta"}

    def _run_job(self) -> None:
        j = self.job
        while j["done"] < j["total"]:
            if j["cancel"]:
                j.update(state="canceled", message=f"中止しました ({j['done']}/{j['total']} 枚印刷済み)")
                return
            img, margin = j["_imgs"][j["done"]]
            n = j["done"] + 1
            j["message"] = f"{n}/{j['total']} 枚目を印刷中"
            with self.lock:
                try:
                    conn = self._ensure()
                    s = conn.request_status()
                    self.state = self._status_dict(s)
                    if s.is_error:
                        raise PrinterError(s)
                    if not s.tape or s.tape[1] != img.height:
                        have = s.tape[0] if s.tape else "テープなし"
                        raise RuntimeError(f"テープの幅がラベルと合いません (プリンタに入っているのは {have})。"
                                           f"テープを替えるか、ラベルを作り直してください。")
                    calib = self.cfg.calibration if j["_calibrate"] else Calibration()
                    rows = render.to_rows(img, margin, calib)
                    done = print_pages(conn, [rows], s.tape[1], density=j["density"], log=lambda m: None)
                    self.state = self._status_dict(done)
                except Exception as e:
                    log.exception("%d 枚目で止まりました", n)
                    self._drop()
                    j.update(state="paused",
                             message=f"{n} 枚目で止まりました。{friendly_error(e)} 直したら「続きから印刷」を押してください。")
                    return
            j["done"] = n
        j.update(state="done", message=f"{j['total']} 枚印刷しました")
        log.info("印刷完了: %d 枚", j["total"])
        if j["meta"].get("no_history"):
            return
        try:
            self.on_job_done(j)
        except Exception:
            log.exception("履歴に残せませんでした")

    def close(self) -> None:
        if self.job and self.job["state"] == "running":
            self.job["cancel"] = True
        with self.lock:
            self._drop()


# ---------- 印刷履歴 ----------
class History:
    def __init__(self, path: Path = HISTORY_PATH):
        self.path = path
        self.lock = threading.Lock()

    def _load(self) -> list[dict]:
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, UnicodeDecodeError):
            return []

    def _save(self, items: list[dict]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(items, ensure_ascii=False), encoding="utf-8")
        tmp.replace(self.path)

    def add(self, job: dict) -> None:
        meta = job.get("meta") or {}
        pages = job.get("_pages") or []
        size = sum(len(p.get("png", "")) for p in pages)
        entry = {
            "id": uuid.uuid4().hex[:10],
            "time": time.strftime("%Y-%m-%d %H:%M"),
            "title": meta.get("title") or "ラベル",
            "count": job["total"],
            "thumb": meta.get("thumb"),
            "doc": meta.get("doc"),
            "pages": pages if pages and size <= HISTORY_PAGES_MAX_BYTES else None,
            "density": job.get("density", 0),
        }
        with self.lock:
            items = [entry] + self._load()
            self._save(items[:HISTORY_MAX])

    def list(self) -> list[dict]:
        with self.lock:
            return [{k: v for k, v in e.items() if k not in ("pages",)} | {"canReprint": bool(e.get("pages"))}
                    for e in self._load()]

    def get(self, entry_id: str) -> dict | None:
        with self.lock:
            return next((e for e in self._load() if e["id"] == entry_id), None)

    def delete(self, entry_id: str) -> None:
        with self.lock:
            self._save([e for e in self._load() if e["id"] != entry_id])


_STYLE_WORDS = {"regular", "bold", "italic", "oblique", "light", "semilight", "semibold", "demibold",
                "medium", "black", "heavy", "thin", "extralight", "ultralight", "extrabold",
                "ultrabold", "condensed", "narrow", "book", "roman", "normal",
                "イタリック", "ボールド", "太字", "斜体"}


def list_font_families() -> list[str]:
    """Windows のレジストリからフォントのファミリー名の候補を集める。

    名前には "Meiryo & Meiryo UI (TrueType)" や "Arial Bold (TrueType)" のような形で入っているので、
    & で分け、末尾の (TrueType) とスタイル名を落とす。実際に使えるかは画面側で確かめる。
    """
    names: set[str] = set()
    keys = [(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts"),
            (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts")]
    for root, path in keys:
        try:
            with winreg.OpenKey(root, path) as k:
                i = 0
                while True:
                    try:
                        name, _, _ = winreg.EnumValue(k, i)
                    except OSError:
                        break
                    i += 1
                    for part in re.split(r"[&;]", name):
                        part = re.sub(r"\((TrueType|OpenType|All res)\)", "", part)
                        words = part.strip().split()
                        while words and words[-1].lower() in _STYLE_WORDS:
                            words.pop()
                        family = " ".join(words)
                        # "Courier 10,12,15 (120)" のようなビットマップフォントは使えないので除く
                        if family and not re.search(r"\d+,\d+|\(\d+\)", family):
                            names.add(family)
        except OSError:
            continue
    return sorted(names, key=str.lower)


FILE_TYPES = ("ラベルファイル (*.json)", "すべてのファイル (*.*)")


class Api:
    def __init__(self, cfg: Config):
        self._cfg = cfg
        self._printer = PrinterService(cfg)
        self._history = History()
        self._printer.on_job_done = self._history.add
        self._window = None

    def _set_window(self, window) -> None:
        self._window = window

    # --- プリンタ ---
    def get_status(self) -> dict:
        return self._printer.status()

    def get_tapes(self) -> list[dict]:
        return [{"code": c, "name": n, "dots": d} for c, (n, d) in P.TAPES.items()]

    def get_fonts(self) -> list[str]:
        return list_font_families()

    def get_settings(self) -> dict:
        c = self._cfg
        return {"screen_scale": c.screen_scale, "address": c.address, "printer_name": c.printer_name,
                "calibration": {"feed_scale": c.calibration.feed_scale,
                                "front_shift_mm": c.calibration.front_shift_mm},
                "app_name": APP_NAME, "version": VERSION, "repo_url": REPO_URL}

    def set_screen_scale(self, value: float) -> dict:
        self._cfg.screen_scale = float(value)
        self._cfg.save()
        return self.get_settings()

    # --- 最初の設定 / プリンタ ---
    def find_printers(self) -> dict:
        return paired_devices()

    def select_printer(self, address: str, name: str = "") -> dict:
        return self._printer.select(address, name)

    def print_test(self) -> dict:
        try:
            dots = self._printer.current_dots()
        except Exception as e:
            return {"ok": False, "message": friendly_error(e)}
        img = render.text_label(f"{APP_NAME}  印刷テスト OK", dots, frame=True)
        return self._printer.start_images([(img, 2.0)], 0, {"no_history": True})

    # --- 寸法の補正 ---
    def print_ruler(self, calibrated: bool = False) -> dict:
        try:
            dots = self._printer.current_dots()
        except Exception as e:
            return {"ok": False, "message": friendly_error(e)}
        img = render.ruler_label(dots, RULER_MM)
        return self._printer.start_images([(img, RULER_MARGIN_MM)], 0, {"no_history": True},
                                          calibrate=bool(calibrated))

    def set_calibration(self, scale_mm: float, front_mm: float, back_mm: float) -> dict:
        """目盛りラベルの実測 (0〜100 の長さ、左端〜0、100〜右端) から補正値を決める。"""
        try:
            scale_mm, front_mm, back_mm = float(scale_mm), float(front_mm), float(back_mm)
        except (TypeError, ValueError):
            return {"ok": False, "message": "数字を入れてください。"}
        if not 90 <= scale_mm <= 110:
            return {"ok": False, "message": "0〜100 の長さは 90〜110mm の範囲で入れてください (定規の当て方を確かめてください)。"}
        if not (0 <= front_mm <= 15 and 0 <= back_mm <= 15):
            return {"ok": False, "message": "余白は 0〜15mm の範囲で入れてください。"}
        self._cfg.calibration = Calibration(feed_scale=round(scale_mm / RULER_MM, 4),
                                            front_shift_mm=round((back_mm - front_mm) / 2, 2))
        self._cfg.save()
        log.info("寸法補正: %s", self._cfg.calibration)
        return {"ok": True, **self.get_settings()}

    def reset_calibration(self) -> dict:
        self._cfg.calibration = Calibration()
        self._cfg.save()
        log.info("寸法補正を元に戻しました")
        return {"ok": True, **self.get_settings()}

    # --- 印刷 ---
    def print_pages(self, pages: list[dict], density: int, meta: dict | None = None) -> dict:
        """pages: [{png: 360dpi・高さ = テープの印字ドット数の PNG (dataURL), margin: 前後の余白 mm}]"""
        return self._printer.start_job(pages, int(density), meta or {})

    def get_job(self) -> dict | None:
        return self._printer.job_info()

    def cancel_job(self) -> dict:
        return self._printer.cancel_job()

    def resume_job(self) -> dict:
        return self._printer.resume_job()

    # 互換: フェーズ 1 の 1 枚印刷
    def print_label(self, png_data_url: str, margin_mm: float, copies: int, density: int) -> dict:
        copies = max(1, min(int(copies), 99))
        return self.print_pages([{"png": png_data_url, "margin": margin_mm}] * copies, density)

    # --- 履歴 ---
    def get_history(self) -> list[dict]:
        return self._history.list()

    def reprint_history(self, entry_id: str) -> dict:
        e = self._history.get(entry_id)
        if not e or not e.get("pages"):
            return {"ok": False, "message": "この履歴は画像を残していないので、ラベルに読み込んでから印刷してください"}
        return self._printer.start_job(e["pages"], e.get("density", 0),
                                       {"title": e["title"], "thumb": e.get("thumb"), "doc": e.get("doc")})

    def get_history_doc(self, entry_id: str) -> dict | None:
        e = self._history.get(entry_id)
        return e.get("doc") if e else None

    def delete_history(self, entry_id: str) -> list[dict]:
        self._history.delete(entry_id)
        return self._history.list()

    # --- ファイル ---
    def save_file(self, content: str, path: str | None = None, suggested: str = "ラベル.json") -> dict:
        import webview
        if not path:
            res = self._window.create_file_dialog(webview.FileDialog.SAVE, save_filename=suggested,
                                                  file_types=FILE_TYPES)
            if not res:
                return {"ok": False, "canceled": True}
            path = res if isinstance(res, str) else res[0]
        try:
            Path(path).write_text(content, encoding="utf-8")
        except OSError as e:
            return {"ok": False, "message": f"保存できませんでした: {e}"}
        return {"ok": True, "path": path, "name": Path(path).name}

    def open_file(self) -> dict:
        import webview
        res = self._window.create_file_dialog(webview.FileDialog.OPEN, file_types=FILE_TYPES)
        if not res:
            return {"ok": False, "canceled": True}
        path = res if isinstance(res, str) else res[0]
        try:
            content = Path(path).read_text(encoding="utf-8")
        except OSError as e:
            return {"ok": False, "message": f"開けませんでした: {e}"}
        return {"ok": True, "path": path, "name": Path(path).name, "content": content}

    # --- 困ったとき / このアプリについて ---
    def get_diagnostics(self) -> str:
        from importlib.metadata import PackageNotFoundError, version
        try:
            wv = version("pywebview")
        except PackageNotFoundError:
            wv = "?"
        c, st = self._cfg, self._printer.state
        raw = self._printer.last_raw
        return "\n".join([
            f"{APP_NAME} {VERSION}",
            f"Windows: {platform.platform()}",
            f"Python: {platform.python_version()} / pywebview {wv}",
            f"プリンタ: {c.printer_name or '(未設定)'} {mask_address(c.address)}",
            f"状態: {'接続中' if st.get('connected') else '未接続'} / {st.get('detail') or st.get('message')}",
            f"最後のステータス: {raw.hex(' ') if raw else 'なし'}",
            f"寸法補正: 送り倍率 {c.calibration.feed_scale} / 前寄り {c.calibration.front_shift_mm}mm",
            f"印刷: {(self._printer.job_info() or {}).get('message', 'なし')}",
            "", "--- ログ (最近のもの) ---", recent_log(),
        ])

    def open_logs_folder(self) -> None:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        os.startfile(LOG_DIR)

    def open_bluetooth_settings(self) -> None:
        os.startfile("ms-settings:bluetooth")

    def open_notice(self, kind: str) -> dict:
        """LICENSE.txt / THIRD_PARTY_NOTICES.txt を開く (配布版は exe と同じフォルダ、開発中はリポジトリの一番上)。"""
        import sys
        name = {"license": "LICENSE.txt", "third_party": "THIRD_PARTY_NOTICES.txt"}.get(kind)
        if not name:
            return {"ok": False}
        for d in (Path(sys.executable).parent, Path(__file__).resolve().parent.parent):
            if (d / name).exists():
                os.startfile(d / name)
                return {"ok": True}
        return {"ok": False, "message": f"{name} が見つかりません"}

    def open_url(self, url: str) -> None:
        if isinstance(url, str) and url.startswith("https://"):
            webbrowser.open(url)

    def log_client(self, level: str, message: str) -> None:
        log.log(logging.ERROR if level == "error" else logging.INFO, "[画面] %s", str(message)[:2000])

    def shutdown(self) -> None:
        self._printer.close()
