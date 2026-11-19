#!/usr/bin/env python3
"""
Build the phone pages (m/*.html) from the desktop pages (repo root).

Why: the phone set used to be hand-copied. Every desktop UI change then
broke the phone page (wrong ids, missing buttons, removed features still
referenced). Now the desktop page is the single source of truth and the
phone page is regenerated from it.

Usage (from the repo root):
    python scripts/gen-mobile.py          # rewrite m/*.html
    python scripts/gen-mobile.py --check  # exit 1 if m/*.html is stale

What changes in a phone page vs its desktop twin:
  * <html data-site="mobile"> and viewport-fit=cover
  * js/device.js points one level up; every styles/ and js/ URL gets "../"
  * styles/mobile.css is linked last
  * bottom tab bar added (the top nav / theme switch are hidden by CSS)
  * Three.js background is NOT loaded on phones (battery / GPU), and its
    settings row is dropped
  * Translate page only: live caption strip over the camera + captions.js

Run it after ANY edit to index/practice/learn/login/register.html.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PAGES = ["index", "practice", "learn", "login", "register"]

TABS = [  # (href, label, data-view that makes it active)
    ("index.html", "Translate", "translate"),
    ("practice.html", "Practice", "practice"),
    ("learn.html", "Information", "learn"),
]

MOBILE_CSS = '  <link rel="stylesheet" href="../styles/mobile.css?v=20261117m">'
CAPTIONS_DIV = '        <div class="stage-captions" id="captions" aria-live="polite"></div>'


def convert(src: str, view: str) -> str:
    s = src.replace("\r\n", "\n")

    # <html> + viewport
    s = s.replace('<html lang="en" data-theme="dark">',
                  '<html lang="en" data-theme="dark" data-site="mobile">', 1)
    s = re.sub(r'(<meta name="viewport" content="width=device-width, initial-scale=1)(")',
               r'\1, viewport-fit=cover\2', s, count=1)

    # resource URLs are written relative to the site root -> one level up
    s = re.sub(r'(href|src)="(\./)?(styles|js)/', r'\1="../\3/', s)

    # Three.js atmosphere: not on phones
    s = re.sub(r'[ \t]*<script src="https://cdn\.jsdelivr\.net/npm/three@[^"]*"></script>\n', "", s)
    s = re.sub(r'[ \t]*<script src="\.\./js/ui/three-scene\.js[^"]*"></script>\n', "", s)
    s = re.sub(r'[ \t]*<script src="\.\./js/ui/effects\.js[^"]*"></script>\n', "", s)
    s = re.sub(r'[ \t]*<div class="toggle-row">(?:(?!</div>).)*?id="setThreeFx"(?:(?!</div>).)*?</div>\n',
               "", s, flags=re.S)

    # phone stylesheet, last
    last_css = list(re.finditer(r'  <link rel="stylesheet" href="\.\./styles/[^"]*">\n', s))
    assert last_css, "no stylesheet links found"
    end = last_css[-1].end()
    s = s[:end] + MOBILE_CSS + "\n" + s[end:]

    # translate page: captions over the camera
    if view == "translate":
        s = s.replace('<div class="track-hud" id="trackHud" hidden aria-hidden="true"></div>\n',
                      '<div class="track-hud" id="trackHud" hidden aria-hidden="true"></div>\n'
                      + CAPTIONS_DIV + "\n", 1)
        assert 'id="captions"' in s, "captions div not inserted (trackHud line changed?)"
        s = re.sub(r'([ \t]*)(<script src="\.\./js/ui/transcript\.js[^"]*"></script>\n)',
                   r'\1\2\1<script src="../js/ui/captions.js?v=20261117m"></script>\n', s, count=1)
        assert "captions.js" in s, "captions.js not inserted (transcript.js line changed?)"

    # bottom tab bar, right after the toast container
    tabs = []
    for href, label, v in TABS:
        cls = ' class="active"' if v == view else ""
        tabs.append(f'  <a href="{href}"{cls}>{label}</a>')
    tabbar = '<nav class="m-tabbar" aria-label="Main">\n' + "\n".join(tabs) + "\n</nav>\n"
    m = re.search(r'<div class="toast-wrap"[^>]*></div>\n', s)
    assert m, "toast-wrap not found"
    s = s[:m.end()] + "\n" + tabbar + s[m.end():]

    return s


def main():
    check = "--check" in sys.argv
    stale = []
    (ROOT / "m").mkdir(exist_ok=True)
    for name in PAGES:
        src = (ROOT / f"{name}.html").read_text(encoding="utf-8")
        view = re.search(r'<body data-view="([^"]+)"', src).group(1)
        out = convert(src, view)
        dst = ROOT / "m" / f"{name}.html"
        old = dst.read_text(encoding="utf-8").replace("\r\n", "\n") if dst.exists() else None
        if old != out:
            stale.append(name)
            if not check:
                dst.write_text(out.replace("\n", "\r\n"), encoding="utf-8", newline="")
    if check:
        if stale:
            print("stale phone pages:", ", ".join(f"m/{n}.html" for n in stale))
            sys.exit(1)
        print("phone pages are up to date")
    else:
        print("wrote m/*.html" + (f" (changed: {', '.join(stale)})" if stale else " (no changes)"))


if __name__ == "__main__":
    main()
