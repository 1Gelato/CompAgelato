#!/usr/bin/env python3
"""Génère l'icône de l'application (PNG + ICO + ICNS source)."""
import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
SIZE = 1024
R = 228  # rayon des coins, proportions macOS/Windows modernes


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def build() -> Image.Image:
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

    # Dégradé diagonal bleu → violet.
    top = (10, 132, 255)
    bottom = (106, 75, 188)
    gradient = Image.new("RGBA", (SIZE, SIZE))
    gd = ImageDraw.Draw(gradient)
    for y in range(SIZE):
        gd.line([(0, y), (SIZE, y)], fill=(*lerp(top, bottom, y / SIZE), 255))

    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=R, fill=255)
    img.paste(gradient, (0, 0), mask)

    d = ImageDraw.Draw(img)
    white = (255, 255, 255, 255)

    # Cornet de glace stylisé : boule + cône, trait épais.
    cx = SIZE // 2
    stroke = 46

    # Boule.
    ball_r = 168
    ball_cy = 372
    d.ellipse(
        [cx - ball_r, ball_cy - ball_r, cx + ball_r, ball_cy + ball_r],
        outline=white,
        width=stroke,
    )

    # Cône.
    # Le bord du cône affleure la boule, sans la traverser.
    cone_top_y = ball_cy + ball_r + 4
    cone_half = 196
    cone_tip_y = 852
    d.line([(cx - cone_half, cone_top_y), (cx, cone_tip_y)], fill=white, width=stroke, joint="curve")
    d.line([(cx + cone_half, cone_top_y), (cx, cone_tip_y)], fill=white, width=stroke, joint="curve")
    d.line([(cx - cone_half, cone_top_y), (cx + cone_half, cone_top_y)], fill=white, width=stroke)

    # Arrondi de la pointe.
    d.ellipse([cx - stroke // 2, cone_tip_y - stroke // 2, cx + stroke // 2, cone_tip_y + stroke // 2], fill=white)

    return img


def main() -> None:
    icon = build()
    png = os.path.join(HERE, "icon.png")
    icon.save(png)
    print("écrit", png)

    ico = os.path.join(HERE, "icon.ico")
    icon.save(ico, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("écrit", ico)

    # electron-builder produit l'icns depuis le PNG 1024 sous macOS.
    for size in (512, 256, 128, 64, 32, 16):
        out = os.path.join(HERE, f"icon-{size}.png")
        icon.resize((size, size), Image.LANCZOS).save(out)
    print("variantes PNG écrites")


if __name__ == "__main__":
    main()
