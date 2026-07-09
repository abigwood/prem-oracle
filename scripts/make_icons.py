#!/usr/bin/env python3
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
ICONS = ROOT / "icons"
ICONS.mkdir(exist_ok=True)


def font(size):
    for path in (
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/SFNS.ttf",
    ):
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def make(size, path):
    img = Image.new("RGBA", (size, size), "#38003c")
    draw = ImageDraw.Draw(img)
    margin = int(size * 0.16)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=int(size * 0.22), fill="#38003c")
    draw.ellipse((margin, margin, size - margin, size - margin), fill="#00ff87", outline="white", width=max(4, int(size * 0.035)))
    fnt = font(int(size * 0.30))
    text = "PO"
    box = draw.textbbox((0, 0), text, font=fnt)
    draw.text(((size - (box[2] - box[0])) / 2, (size - (box[3] - box[1])) / 2 - int(size * 0.03)), text, fill="#38003c", font=fnt)
    img.save(path)


make(192, ICONS / "icon-192.png")
make(512, ICONS / "icon-512.png")
make(180, ICONS / "apple-touch-icon.png")
print("icons written")
