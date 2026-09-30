"""
Generate the Full Page Shot icon set.

Design: a blue rounded square, a white page, and a downward chevron reading as
"the page continues". Everything is drawn at 4x and downsampled with LANCZOS so
the 16px variant stays crisp — small extension icons live or die on their
silhouette, not their detail.

Run:  python make-icons.py <output-dir>
"""

import os
import sys

from PIL import Image, ImageDraw

SIZES = [16, 32, 48, 128]
SS = 8  # supersample factor

BLUE_TOP = (32, 122, 236)
BLUE_BOTTOM = (9, 74, 178)
PAGE = (255, 255, 255)
RULE = (176, 196, 224)
RULE_STRONG = (120, 148, 190)


def rounded(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def build(size):
    """Draw one icon at `size` px, rendered at size*SS then downsampled."""
    n = size * SS
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # --- background: vertical gradient inside a rounded square -------------
    bg = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    grad = Image.new("RGBA", (1, n))
    for y in range(n):
        t = y / max(1, n - 1)
        grad.putpixel(
            (0, y),
            (
                round(BLUE_TOP[0] + (BLUE_BOTTOM[0] - BLUE_TOP[0]) * t),
                round(BLUE_TOP[1] + (BLUE_BOTTOM[1] - BLUE_TOP[1]) * t),
                round(BLUE_TOP[2] + (BLUE_BOTTOM[2] - BLUE_TOP[2]) * t),
                255,
            ),
        )
    grad = grad.resize((n, n))
    mask = Image.new("L", (n, n), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, n - 1, n - 1), radius=int(n * 0.22), fill=255
    )
    bg.paste(grad, (0, 0), mask)
    img = Image.alpha_composite(img, bg)
    d = ImageDraw.Draw(img)

    # --- the page -----------------------------------------------------------
    pad = int(n * 0.20)
    page_box = (pad, int(n * 0.13), n - pad, n - int(n * 0.13))
    rounded(d, page_box, int(n * 0.055), PAGE)

    left = page_box[0] + int(n * 0.075)
    right = page_box[2] - int(n * 0.075)
    width = right - left

    # text rules: full, full, shorter, then a short one before the chevron
    y = page_box[1] + int(n * 0.10)
    step = int(n * 0.088)
    bar = max(2, int(n * 0.030))
    spans = [1.0, 1.0, 0.62, 1.0]
    for i, frac in enumerate(spans):
        d.rounded_rectangle(
            (left, y, left + int(width * frac), y + bar),
            radius=bar // 2,
            fill=RULE_STRONG if i % 2 == 0 else RULE,
        )
        y += step

    # --- chevron: "page continues below" ------------------------------------
    cx = (page_box[0] + page_box[2]) // 2
    cy = page_box[3] - int(n * 0.085)
    arm = int(n * 0.052)
    stroke = max(2, int(n * 0.028))
    d.line(
        [(cx - arm, cy - arm // 2), (cx, cy + arm // 2), (cx + arm, cy - arm // 2)],
        fill=BLUE_BOTTOM,
        width=stroke,
        joint="curve",
    )

    return img.resize((size, size), Image.LANCZOS)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "."
    os.makedirs(out, exist_ok=True)
    for s in SIZES:
        path = os.path.join(out, f"icon{s}.png")
        build(s).save(path, "PNG", optimize=True)
        print(f"wrote {path}  ({os.path.getsize(path)} bytes)")


if __name__ == "__main__":
    main()
