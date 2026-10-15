#!/usr/bin/env python3
"""Writes CheckLink's launcher icon vectors from favicon.svg's geometry (ICON-1 A, "A closer look":
a magnifier held over a link, chosen 12 October 2026).

Run from android/:  python3 tools/make_icons.py app/src/main/res

It prints the mark's bounding box and the transforms used, and writes four files:
  drawable/ic_launcher_foreground.xml    the adaptive icon's foreground (Android 8 and later)
  drawable/ic_launcher_monochrome.xml    the themed-icon layer (Android 13 and later)
  mipmap-anydpi/ic_launcher.xml          Android 7.0 and 7.1: the mark on a dark rounded tile
  mipmap-anydpi/ic_launcher_round.xml    the same on a dark round tile
mipmap-anydpi-v26/ic_launcher*.xml (the adaptive icons) only name these files and the background
colour, and are not written here.

The rules are the template app's (the Labs app this project was copied from): the mark is scaled
and centred on its own bounding box inside the 108 unit viewport, so that every point of it stays
inside the 66 unit safe zone that launchers never crop (here: its farthest point 31 units from the
centre); the legacy tiles carry the same mark 1.2 / 0.78 times larger, the ratio the template's
tiles use.
tools/build-store-icon.py renders the 512 pixel store icon with the foreground's scale and
translation, so the store tile and the launcher icon are the same picture; keep its SCALE and
TRANSLATE equal to what this script prints (tests/stage5-release.test.mjs checks it).

The drawing is favicon.svg's, shape for shape: the handle (a round-capped line), the lens (a
filled circle with a gradient ring) and the link under the glass (two round-capped arcs and a
bar). Vector drawables take the same path commands, and their gradients use the path's own
coordinates, like the SVG's userSpaceOnUse gradients, so the numbers carry over unchanged. There
is no mask in this drawing, so no clip-path is needed.
"""
import math
import os
import sys

res = sys.argv[1]

# favicon.svg, element for element (64 x 64 viewBox).
HANDLE = "M43,43 L56,56"
HANDLE_WIDTH = 8
LENS_C, LENS_R, LENS_WIDTH = (28, 28), 19.5, 5
LENS = "M8.5,28 A19.5,19.5 0 1,0 47.5,28 A19.5,19.5 0 1,0 8.5,28 Z"
LINK = "M24,22 H20 A6,6 0 0,0 20,34 H24 M32,22 H36 A6,6 0 0,1 36,34 H32 M24,28 H32"
LINK_WIDTH = 4

# The outline of what is drawn: the handle with its round caps, and the outer edge of the lens
# ring. The link lies inside the lens.
pts = []
for k in range(720):
    t = math.radians(k / 2)
    for (cx, cy) in ((43, 43), (56, 56)):
        pts.append((cx + HANDLE_WIDTH / 2 * math.cos(t), cy + HANDLE_WIDTH / 2 * math.sin(t)))
    r = LENS_R + LENS_WIDTH / 2
    pts.append((LENS_C[0] + r * math.cos(t), LENS_C[1] + r * math.sin(t)))
xs = [p[0] for p in pts]
ys = [p[1] for p in pts]
minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
cx, cy = (minx + maxx) / 2, (miny + maxy) / 2
far = max(math.hypot(p[0] - cx, p[1] - cy) for p in pts)
print(f"bbox x {minx:.2f}..{maxx:.2f} y {miny:.2f}..{maxy:.2f}; centre {cx:.2f},{cy:.2f}; farthest point {far:.2f}")


def grad(x1, y1, x2, y2, c1, c2, attr):
    return (f'<aapt:attr name="android:{attr}">\n'
            f'                <gradient android:type="linear" android:startX="{x1:g}" android:startY="{y1:g}" android:endX="{x2:g}" android:endY="{y2:g}">\n'
            f'                    <item android:offset="0" android:color="{c1}" />\n'
            f'                    <item android:offset="1" android:color="{c2}" />\n'
            f'                </gradient>\n'
            f'            </aapt:attr>')


def group(scale, tx, ty, body):
    return f'''    <group
        android:scaleX="{scale:.4f}"
        android:scaleY="{scale:.4f}"
        android:translateX="{tx:.2f}"
        android:translateY="{ty:.2f}">
{body}
    </group>'''


COLOUR = f'''        <!-- favicon.svg, shape for shape, in its order: the handle, then the lens over its
             inner end, then the link under the glass. -->
        <path
            android:strokeWidth="{HANDLE_WIDTH}"
            android:strokeLineCap="round"
            android:pathData="{HANDLE}">
            {grad(42, 42, 59, 59, "#FFE879F9", "#FF9333EA", "strokeColor")}
        </path>
        <path
            android:fillColor="#FF1B1226"
            android:strokeWidth="{LENS_WIDTH}"
            android:pathData="{LENS}">
            {grad(8, 8, 48, 48, "#FFF0ABFC", "#FFA855F7", "strokeColor")}
        </path>
        <path
            android:strokeWidth="{LINK_WIDTH}"
            android:strokeLineCap="round"
            android:strokeLineJoin="round"
            android:pathData="{LINK}">
            {grad(12, 20, 44, 36, "#FFFFFFFF", "#FFF0ABFC", "strokeColor")}
        </path>'''

MONO = f'''        <!-- One colour, read by its alpha only. The lens is a ring with no fill, so the link
             stays visible inside it. -->
        <path
            android:strokeColor="#FFFFFFFF"
            android:strokeWidth="{HANDLE_WIDTH}"
            android:strokeLineCap="round"
            android:pathData="{HANDLE}" />
        <path
            android:strokeColor="#FFFFFFFF"
            android:strokeWidth="{LENS_WIDTH}"
            android:pathData="{LENS}" />
        <path
            android:strokeColor="#FFFFFFFF"
            android:strokeWidth="{LINK_WIDTH}"
            android:strokeLineCap="round"
            android:strokeLineJoin="round"
            android:pathData="{LINK}" />'''

HEAD = '''<?xml version="1.0" encoding="utf-8"?>
<!--
{comment}
-->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
{aapt}    android:width="{size}dp"
    android:height="{size}dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
'''
AAPT = '    xmlns:aapt="http://schemas.android.com/aapt"\n'

# Adaptive foreground: the farthest point of the mark 31 units from the centre, inside the
# 66 unit safe zone (radius 33).
fs = 31 / far
ftx, fty = 54 - cx * fs, 54 - cy * fs
# Android 7.0 and 7.1: the template's tiles carry its mark at 1.2 where its foreground has 0.78;
# the same ratio here.
ls = fs * 1.2 / 0.78
ltx, lty = 54 - cx * ls, 54 - cy * ls
print(f"foreground scale {fs:.4f} translate {ftx:.2f},{fty:.2f}; legacy scale {ls:.4f} translate {ltx:.2f},{lty:.2f}")

fg_comment = ("  Adaptive-icon foreground for CheckLink (ICON-1 A, \"A closer look\"), drawn from the web\n"
              "  app's favicon.svg (64 x 64) by android/tools/make_icons.py. The mark is scaled and\n"
              "  centred on its own bounding box so that every point of it stays inside the 66 unit\n"
              "  safe zone that launchers never crop. Edit favicon.svg and the script, not this file.")
with open(os.path.join(res, "drawable/ic_launcher_foreground.xml"), "w", encoding="utf-8") as f:
    f.write(HEAD.format(comment=fg_comment, aapt=AAPT, size=108) + group(fs, ftx, fty, COLOUR) + "\n</vector>\n")

TILE = '    <path android:fillColor="#FF0C0A12" android:pathData="M12,0 H96 A12,12 0 0 1 108,12 V96 A12,12 0 0 1 96,108 H12 A12,12 0 0 1 0,96 V12 A12,12 0 0 1 12,0 Z" />\n'
ROUND = '    <path android:fillColor="#FF0C0A12" android:pathData="M0,54 A54,54 0 1,0 108,54 A54,54 0 1,0 0,54 Z" />\n'
legacy_comment = "  Android 7.0 and 7.1 have no adaptive icons; this is the same mark on the same dark tile."
with open(os.path.join(res, "mipmap-anydpi/ic_launcher.xml"), "w", encoding="utf-8") as f:
    f.write(HEAD.format(comment=legacy_comment, aapt=AAPT, size=48) + TILE + group(ls, ltx, lty, COLOUR) + "\n</vector>\n")
with open(os.path.join(res, "mipmap-anydpi/ic_launcher_round.xml"), "w", encoding="utf-8") as f:
    f.write(HEAD.format(comment=legacy_comment.replace("tile", "round tile"), aapt=AAPT, size=48) + ROUND
            + group(ls, ltx, lty, COLOUR) + "\n</vector>\n")

mono_comment = ("  Themed-icon layer (Android 13 and later). The launcher tints it with one colour and only\n"
                "  reads its alpha, so it is the outline of the mark: the handle, the lens as a ring and\n"
                "  the link, without the dark fill that would otherwise turn the lens into a solid disc.")
with open(os.path.join(res, "drawable/ic_launcher_monochrome.xml"), "w", encoding="utf-8") as f:
    f.write(HEAD.format(comment=mono_comment, aapt="", size=108) + group(fs, ftx, fty, MONO) + "\n</vector>\n")
print("written")
