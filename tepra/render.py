"""ラベル画像をラスター行に変換する。

座標の約束:
- ラベル画像は「テープを左→右に読む向き」で作る。高さ = テープの印字ドット数、幅 = 送り方向。
- 画像は公称 360dpi で描く。寸法補正 (送り倍率・前後のずれ) はラスター化のときにまとめてかける。
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from .config import Calibration
from .protocol import DPI

THRESHOLD = 140  # これより暗いピクセルを黒にする

FONT_DIR = Path("C:/Windows/Fonts")
DEFAULT_FONTS = ("meiryob.ttc", "meiryo.ttc", "YuGothB.ttc", "msgothic.ttc", "arial.ttf")


def mm_to_dots(mm: float) -> int:
    return round(mm / 25.4 * DPI)


def find_font(size: int, names=DEFAULT_FONTS) -> ImageFont.FreeTypeFont:
    for name in names:
        p = FONT_DIR / name
        if p.exists():
            return ImageFont.truetype(str(p), size)
    return ImageFont.load_default(size)


def to_rows(img: Image.Image, margin_mm: float = 2.0,
            calib: Calibration | None = None, flip: bool = False) -> list[bytes]:
    """ラベル画像 → ラスター行 (送る順)。両端の余白と寸法補正もここでかける。"""
    calib = calib or Calibration()
    gray = img.convert("L")
    # 送り方向の補正: 実機の送りが feed_scale 倍になるので、画像を 1/feed_scale 倍にしておく
    if calib.feed_scale != 1.0:
        w = max(1, round(gray.width / calib.feed_scale))
        gray = gray.resize((w, gray.height), Image.BILINEAR)
    # 余白 (実寸 mm を、補正後の行数に換算)
    rows_per_mm = DPI / 25.4 / calib.feed_scale
    front = max(0, round((margin_mm + calib.front_shift_mm) * rows_per_mm))
    back = max(0, round((margin_mm - calib.front_shift_mm) * rows_per_mm))
    page = Image.new("L", (front + gray.width + back, gray.height), 255)
    page.paste(gray, (front, 0))

    bw = page.point(lambda y: 0 if y < THRESHOLD else 255)
    # 実機確認: 最初に送った行がラベルの右端に来る → 右端の列から送る
    bw = bw.transpose(Image.FLIP_LEFT_RIGHT)
    if flip:
        bw = bw.transpose(Image.FLIP_TOP_BOTTOM)
    col = bw.transpose(Image.TRANSPOSE)                # 行 i = 元の列 i
    raw = col.point(lambda v: 255 - v).convert("1").tobytes()  # 黒=1, MSB first
    stride = (page.height + 7) // 8
    return [raw[i * stride:(i + 1) * stride] for i in range(col.height)]


def text_label(text: str, dots: int, frame: bool = False) -> Image.Image:
    """1 行の文字ラベル (テスト用。本格的なレイアウトはアプリ側で作る)。"""
    font = find_font(round(dots * 0.6))
    l, t, r, b = font.getbbox(text)
    img = Image.new("L", (r - l, dots), 255)
    d = ImageDraw.Draw(img)
    d.text((-l, (dots - (b - t)) // 2 - t), text, font=font, fill=0)
    if frame:
        pad = round(dots * 0.15)
        framed = Image.new("L", (img.width + pad * 2, dots), 255)
        framed.paste(img, (pad, 0))
        ImageDraw.Draw(framed).rectangle([0, 0, framed.width - 1, dots - 1], outline=0, width=3)
        img = framed
    return img


def ruler_label(dots: int, length_mm: int = 100) -> Image.Image:
    """寸法補正用の目盛りラベル。0〜length_mm に 1mm 刻みの目盛り、10mm ごとに数字。"""
    width = mm_to_dots(length_mm) + 2
    img = Image.new("L", (width, dots), 255)
    d = ImageDraw.Draw(img)
    font = find_font(round(dots * 0.32))
    for mm in range(length_mm + 1):
        x = mm_to_dots(mm)
        if mm % 10 == 0:
            h, w = dots * 0.55, 3
        elif mm % 5 == 0:
            h, w = dots * 0.38, 2
        else:
            h, w = dots * 0.22, 2
        d.rectangle([x, 0, x + w - 1, round(h)], fill=0)
        if mm % 10 == 0:
            label = str(mm)
            l, t, r, b = font.getbbox(label)
            tx = x + 1 - (r - l) // 2 - l
            tx = min(max(tx, 0), width - (r - l))
            d.text((tx, dots - (b - t) - t - 2), label, font=font, fill=0)
    return img
