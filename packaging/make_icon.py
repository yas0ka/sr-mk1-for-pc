"""アプリのアイコン (packaging/app.ico) を作る。赤い角丸の四角に、白いテープと「MK1」。"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).with_name("app.ico")
S = 256


def draw() -> Image.Image:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([8, 8, S - 8, S - 8], radius=48, fill=(209, 16, 43, 255))
    # テープ (白い帯) と、切り口の三角の切り欠き
    top, bottom = 78, 178
    d.rectangle([0, top, S, bottom], fill=(255, 255, 255, 255))
    d.polygon([(S, top), (S - 22, (top + bottom) // 2), (S, bottom)], fill=(0, 0, 0, 0))
    font = ImageFont.truetype("C:/Windows/Fonts/arialbd.ttf", 84)
    text = "MK1"
    l, t, r, b = font.getbbox(text)
    d.text(((S - 22 - (r - l)) // 2 - l, (top + bottom - (b - t)) // 2 - t), text, font=font, fill=(31, 35, 40, 255))
    return img


if __name__ == "__main__":
    draw().save(OUT, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    draw().save(OUT.with_suffix(".png"))
    print(OUT)
