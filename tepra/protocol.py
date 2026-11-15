"""SR-MK1 (TEPRA PRO, commandLevel 5) のコマンド生成とステータス解析。

詳細と実機で確認した点は NOTES.md を参照。
"""
from __future__ import annotations

import struct
from dataclasses import dataclass

DPI = 360  # ヘッド方向・送り方向とも公称 360dpi

# テープ幅コード (ステータス TW の下位 4bit) -> (名前, 印字ドット数)
# 12mm / 24mm は実機確認済み。他は解析資料の値。
TAPES: dict[int, tuple[str, int]] = {
    0x0B: ("4mm", 44),
    0x01: ("6mm", 72),
    0x02: ("9mm", 108),
    0x03: ("12mm", 144),
    0x04: ("18mm", 216),
    0x05: ("24mm", 256),  # SR-MK1 の 24mm は 256 (資料の一般値 288 ではない)
}
TAPE_BY_NAME = {name: code for code, (name, _) in TAPES.items()}

ST_NAMES = {0: "Idle", 1: "Feeding", 2: "Printing", 3: "DataSending", 4: "FeedEnd",
            5: "PrintEnd", 16: "DemoPrinting", 17: "DeviceFeeding", 18: "DevicePrinting",
            19: "FirmwareUpdating", 32: "SmallRollWaiting", 34: "WaitingForTapeRemoval",
            255: "Error"}
ER_NAMES = {0: "正常", 1: "カッターエラー", 6: "テープカートリッジなし", 21: "ヘッド過熱",
            32: "本体でキャンセル", 33: "カバーオープン", 34: "電圧低下", 35: "電源オフ",
            36: "テープ排出エラー", 48: "テープ送りエラー", 64: "リボンたるみ", 65: "リボン残少",
            66: "テープエンド", 67: "ラベルカットエラー", 68: "温度エラー", 69: "パラメータ不足"}

# 画面に出す説明 (何が起きたか + どうすればよいか)
ER_ADVICE = {
    1: "カッターがうまく動きませんでした。テープが詰まっていないか確かめてください。",
    6: "テープカートリッジが入っていません。カートリッジをセットしてください。",
    21: "印字ヘッドが熱くなっています。少し待ってから続けてください。",
    32: "プリンタ本体の操作で印刷が取り消されました。",
    33: "プリンタのカバーが開いています。カバーを閉じてください。",
    34: "電源が弱くなっています。電池を替えるか、AC アダプタをつないでください。",
    35: "プリンタの電源が切れました。電源を入れ直してください。",
    36: "テープがうまく出てきませんでした。テープの出口に詰まりがないか確かめてください。",
    48: "テープがうまく送られませんでした。カートリッジを入れ直してください。",
    64: "インクリボンがたるんでいます。カートリッジを入れ直してください。",
    65: "インクリボンが残り少なくなっています。",
    66: "テープがなくなりました。新しいカートリッジに替えてください。",
    67: "ラベルがうまく切れませんでした。テープの出口を確かめてください。",
    68: "プリンタが熱すぎるか冷たすぎます。部屋の温度に慣らしてから使ってください。",
    69: "印刷データの受け渡しに失敗しました。もう一度印刷してください。",
}


def frame(cmd: int, params: bytes = b"") -> bytes:
    """1B 7B <len> <cmd> <params> <chk> 7D"""
    chk = (cmd + sum(params)) & 0xFF
    return bytes([0x1B, 0x7B, 1 + len(params) + 2, cmd]) + params + bytes([chk, 0x7D])


AUTO_STATUS_ON = frame(0x49, b"\x05\x00")
AUTO_STATUS_OFF = frame(0x49, b"\x00\x00")  # 単発ステータス要求と同じバイト列
STATUS_REQUEST = AUTO_STATUS_OFF
PRINT_END = frame(0x40)                     # '@'
FORM_FEED = b"\x0C"
# リセット (1B 7B 03 21 21 7D) は使わない: BT リンクが切れて電源再投入まで戻らない報告がある


def job_env(density: int = 0, cut_each: bool = True) -> bytes:
    """ジョブ環境: @ → { "ST" → C (カット) → D (濃度) → G"""
    cut = frame(0x43, struct.pack("<I", 0x01010101 if cut_each else 0x01010001))
    v = density + 5
    dens = frame(0x44, bytes([v if 0 <= v <= 10 else 0]))
    return frame(0x40) + frame(0x7B, b"\x00\x00ST") + cut + dens + frame(0x47)


def page_env(lines: int, margin: int = 0) -> bytes:
    """ページ環境 (commandLevel 5): L (行数) → T (先頭余白)"""
    return frame(0x4C, struct.pack("<I", lines)) + frame(0x54, struct.pack("<H", margin))


def raster_line(bits: bytes, dots: int) -> bytes:
    return b"\x1B\x2E\x00\x00\x00\x01" + struct.pack("<H", dots) + bits


# ---------- ステータス ----------
STATUS_PREFIX = bytes.fromhex("40424443205354320D0A50003B")  # "@BDC ST2\r\nP\0;"
STATUS_LEN = 92


@dataclass(frozen=True)
class Status:
    st: int   # プリンタ状態
    er: int   # エラー
    tw: int   # テープ幅コード (生値)
    raw: bytes

    @property
    def is_cable_tape(self) -> bool:
        # 0x11 / 0x12 はケーブル表示ラベル用の専用テープ (下位 4bit だけ見ると 6mm / 9mm と誤認する)
        return self.tw in (0x11, 0x12)

    @property
    def tape_code(self) -> int:
        return self.tw & 0x0F

    @property
    def tape(self) -> tuple[str, int] | None:
        if self.is_cable_tape:
            return None   # 印字できるドット数が分からないので未対応
        return TAPES.get(self.tape_code)

    @property
    def is_error(self) -> bool:
        return self.er != 0 or self.st == 255

    def describe(self) -> str:
        if self.is_cable_tape:
            tape = "ケーブル表示ラベル用テープ (未対応)"
        else:
            tape = self.tape[0] if self.tape else ("テープなし" if self.tw == 0 else f"不明(0x{self.tw:02X})")
        return (f"状態={ST_NAMES.get(self.st, self.st)} "
                f"エラー={ER_NAMES.get(self.er, self.er)} テープ={tape}")

    def advice(self) -> str:
        """エラーのときの、利用者向けの説明。"""
        if self.er in ER_ADVICE:
            return ER_ADVICE[self.er]
        if self.is_error:
            return f"プリンタがエラーを知らせています ({ER_NAMES.get(self.er, self.er)})。電源を入れ直してみてください。"
        return ""


def parse_status(pkt: bytes) -> Status:
    # 実機: プレフィクス直後に 1 バイト (0x4E) があり、その次から ST / ER / TW
    b = pkt[len(STATUS_PREFIX):]
    return Status(st=b[1], er=b[2], tw=b[3], raw=pkt)


def extract_statuses(buf: bytes) -> tuple[list[Status], bytes]:
    """受信バッファから完全なステータスを取り出し、(ステータス一覧, 残りバッファ) を返す。"""
    out = []
    while True:
        i = buf.find(STATUS_PREFIX)
        if i < 0:
            # プレフィクスの途中で切れている可能性があるので末尾だけ残す
            return out, buf[-(len(STATUS_PREFIX) - 1):]
        if len(buf) - i < STATUS_LEN:
            return out, buf[i:]
        out.append(parse_status(buf[i:i + STATUS_LEN]))
        buf = buf[i + STATUS_LEN:]
