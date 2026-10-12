#!/usr/bin/env python3
"""Draws the SimpleSwing app icon set: a strobe (multi-exposure) golf swing.

The club shaft appears at several moments of the downswing, fanning from the hands down into the
ball and getting more solid towards impact, like a sequence photo, and like stepping through the
app's slow-motion frames.

Run from the repo root:  python3 scripts/generate-icons.py
Needs Pillow. Writes into assets/images/.
"""

import math
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "assets" / "images"

GREEN_TOP = (36, 150, 84)  # brand accent #1F8A4C, lifted slightly
GREEN_BOTTOM = (9, 64, 36)
WHITE = (255, 255, 255)

SUPERSAMPLE = 4

# --- The mark, in its own coordinate space (fitted into each icon afterwards) -------------------
PIVOT = (0.0, 0.0)  # the hands
SHAFT = 100.0
# Downswing, from club parallel to the ground (left) to impact (just past vertical).
FRAME_ANGLES = [172, 152, 133, 115, 97]
FRAME_ALPHA = [0.32, 0.45, 0.6, 0.78, 1.0]
SHAFT_WIDTH = 3.6
HEAD_LENGTH = 11.0
HEAD_WIDTH = 7.0
ARC_WIDTH = 1.8
BALL_RADIUS = 9.5
HANDS_RADIUS = 5.0


def polar(angle_deg, r):
    a = math.radians(angle_deg)
    return PIVOT[0] + r * math.cos(a), PIVOT[1] + r * math.sin(a)


def impact_ball_centre():
    hx, hy = polar(FRAME_ANGLES[-1], SHAFT)
    # The ball sits just ahead of the club face, along the swing direction (clockwise tangent).
    t = math.radians(FRAME_ANGLES[-1])
    tx, ty = -math.sin(t), math.cos(t)
    return hx - tx * (HEAD_WIDTH / 2 + BALL_RADIUS + 1.5), hy + ty * 0 + BALL_RADIUS * 0.15


def mark_bounds():
    pts = [(PIVOT[0] - HANDS_RADIUS, PIVOT[1] - HANDS_RADIUS), (PIVOT[0] + HANDS_RADIUS, PIVOT[1] + HANDS_RADIUS)]
    for a in FRAME_ANGLES:
        for r in (SHAFT - HEAD_WIDTH, SHAFT + HEAD_WIDTH):
            pts.append(polar(a, r))
        # head extends sideways from the shaft end
        ex, ey = polar(a, SHAFT)
        t = math.radians(a)
        pts.append((ex - math.sin(t) * (HEAD_LENGTH + HEAD_WIDTH), ey + math.cos(t) * (HEAD_LENGTH + HEAD_WIDTH)))
    bx, by = impact_ball_centre()
    pts += [(bx - BALL_RADIUS, by - BALL_RADIUS), (bx + BALL_RADIUS, by + BALL_RADIUS)]
    xs, ys = zip(*pts)
    return min(xs), min(ys), max(xs), max(ys)


def draw_mark(img, box, colour=WHITE, ball=True):
    """Draws the mark scaled to fit inside box=(x0, y0, x1, y1) in img's pixel space."""
    x0, y0, x1, y1 = mark_bounds()
    bw, bh = x1 - x0, y1 - y0
    scale = min((box[2] - box[0]) / bw, (box[3] - box[1]) / bh)
    ox = box[0] + ((box[2] - box[0]) - bw * scale) / 2 - x0 * scale
    oy = box[1] + ((box[3] - box[1]) - bh * scale) / 2 - y0 * scale

    def P(x, y):
        return ox + x * scale, oy + y * scale

    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))

    # Faint swing-path arc through the club heads.
    cx, cy = P(*PIVOT)
    r = SHAFT * scale
    arc_layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(arc_layer).arc(
        [cx - r, cy - r, cx + r, cy + r],
        start=FRAME_ANGLES[-1] - 14,
        end=FRAME_ANGLES[0] + 6,
        fill=colour + (int(255 * 0.28),),
        width=max(1, int(ARC_WIDTH * scale)),
    )
    layer = Image.alpha_composite(layer, arc_layer)

    for angle, alpha in zip(FRAME_ANGLES, FRAME_ALPHA):
        frame = Image.new("RGBA", img.size, (0, 0, 0, 0))
        fd = ImageDraw.Draw(frame)
        a8 = int(255 * alpha)
        ex, ey = P(*polar(angle, SHAFT))
        w = max(1, int(SHAFT_WIDTH * scale))
        fd.line([P(*PIVOT), (ex, ey)], fill=colour + (a8,), width=w)
        # Club head: a rounded bar across the end of the shaft, toe pointing away from the ball.
        t = math.radians(angle)
        tx, ty = -math.sin(t), math.cos(t)
        hl = HEAD_LENGTH * scale
        hw = max(1, int(HEAD_WIDTH * scale))
        start = (ex, ey)
        end = (ex + tx * hl, ey + ty * hl)
        fd.line([start, end], fill=colour + (a8,), width=hw)
        for px, py in (start, end):
            fd.ellipse([px - hw / 2, py - hw / 2, px + hw / 2, py + hw / 2], fill=colour + (a8,))
        layer = Image.alpha_composite(layer, frame)

    # The hands: where every shaft meets, so the fan reads as a golfer holding the club.
    hx, hy = P(*PIVOT)
    hr = HANDS_RADIUS * scale
    ImageDraw.Draw(layer).ellipse([hx - hr, hy - hr, hx + hr, hy + hr], fill=colour + (255,))

    if ball:
        bx, by = P(*impact_ball_centre())
        br = BALL_RADIUS * scale
        bd = ImageDraw.Draw(layer)
        bd.ellipse([bx - br, by - br, bx + br, by + br], fill=colour + (255,))

    return Image.alpha_composite(img, layer)


def gradient(size):
    img = Image.new("RGBA", (size, size))
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / (size - 1)
        c = tuple(int(GREEN_TOP[i] + (GREEN_BOTTOM[i] - GREEN_TOP[i]) * t) for i in range(3))
        d.line([(0, y), (size, y)], fill=c + (255,))
    return img


def render(size, background, box_frac, ball=True):
    """Draws at SUPERSAMPLE x and downsamples for smooth edges."""
    big = size * SUPERSAMPLE
    img = gradient(big) if background else Image.new("RGBA", (big, big), (0, 0, 0, 0))
    lo, hi = box_frac
    img = draw_mark(img, (big * lo, big * lo, big * hi, big * hi), ball=ball)
    return img.resize((size, size), Image.LANCZOS)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    # App Store / Play listing / iOS icon: opaque, mark fills most of the square.
    render(1024, background=True, box_frac=(0.15, 0.85)).convert("RGB").save(OUT / "icon.png")
    # Android adaptive icon: launchers mask to a circle/squircle, keep the mark in the 66% safe zone.
    gradient(1024).save(OUT / "android-icon-background.png")
    render(1024, background=False, box_frac=(0.27, 0.73)).save(OUT / "android-icon-foreground.png")
    render(1024, background=False, box_frac=(0.27, 0.73)).save(OUT / "android-icon-monochrome.png")
    # Splash: white mark on the green splash background colour.
    render(512, background=False, box_frac=(0.05, 0.95)).save(OUT / "splash-icon.png")
    print("Wrote icon set to", OUT)


if __name__ == "__main__":
    main()
