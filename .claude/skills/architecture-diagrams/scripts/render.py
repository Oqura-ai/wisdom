#!/usr/bin/env python3
"""Render minimal architecture diagrams from a JSON spec into one self-contained HTML file.

    python render.py spec.json out.html [--shot out.png]

Layouts: "overview" (a root box feeding items, each with nested feature boxes) and "flow"
(start -> step + check -> results, with an optional feedback loop). See ../SKILL.md for the spec.
Prints a warning for every label likely to overflow its box; --shot screenshots the page with a
headless Edge/Chrome so the result can be looked at before it is handed over.
"""

from __future__ import annotations

import argparse
import html
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

W = 1600
# Line height and font size per text class.
LH = {"t": 34, "t2": 32, "s": 27, "s2": 25, "d": 30, "ds": 26, "n": 30}
SIZE = {"t": 25, "t2": 23, "s": 19, "s2": 18, "d": 22, "ds": 18, "n": 21}
BOLD = {"t", "t2", "d"}

THEME = {
    "page": "#e3e8ee", "card": "#f7f9fb", "ink": "#1f2b3a", "muted": "#64748b", "line": "#8896a8",
    "amber": ["#fdf3df", "#d4a037"], "indigo": ["#e8ecfb", "#5a6fd6"], "green": ["#e2f4ec", "#3f9f7f"],
    "slate": ["#e4e8ee", "#8896a8"], "white": ["#ffffff", "#8896a8"], "red": "#c0392b", "grey": "#b8c2cf",
}

warnings: list[str] = []
MIN_ARROW_SEGMENT = 24


# ------------------------------------------------------------------ primitives

def esc(s: str) -> str:
    return html.escape(str(s), quote=False)


def text(x: float, y: float, s: str, cls: str, anchor: str = "middle") -> str:
    return f'<text x="{x:g}" y="{y:g}" class="{cls}" text-anchor="{anchor}">{esc(s)}</text>'


def check_fit(s: str, cls: str, width: float, where: str) -> None:
    est = len(s) * SIZE[cls] * (0.5 if cls in BOLD else 0.47)
    if est > width - 20:
        warnings.append(f"{where}: {s!r} (~{est:.0f}px) may overflow its {width:g}px box; shorten it")


def block(cx: float, y0: float, h: float, lines: list[tuple[str, str]], width: float, where: str) -> str:
    total = sum(LH[c] for _, c in lines)
    if total > h - 16:
        warnings.append(f"{where}: {len(lines)} lines don't fit a {h:g}px-high box; drop a line")
    y = y0 + (h - total) / 2
    out = []
    for s, cls in lines:
        check_fit(s, cls, width, where)
        out.append(text(cx, round(y + LH[cls] * 0.74, 1), s, cls))
        y += LH[cls]
    return "".join(out)


def rect(x: float, y: float, w: float, h: float, color: str, r: float = 22) -> str:
    return f'<rect x="{x:g}" y="{y:g}" width="{w:g}" height="{h:g}" rx="{r:g}" class="b {color}"/>'


def box(x, y, w, h, color, lines, where, r=22) -> str:
    return rect(x, y, w, h, color, r) + block(x + w / 2, y, h, lines, w, where)


def arrow(*pts: tuple[float, float]) -> str:
    clean: list[tuple[float, float]] = []
    for point in pts:
        if clean and point == clean[-1]:
            warnings.append(f"connector has a zero-length duplicate point at {point}")
            continue
        clean.append(point)
    if len(clean) < 2:
        warnings.append(f"connector needs at least two distinct points: {pts}")
        return ""
    for start, end in zip(clean, clean[1:]):
        dx, dy = end[0] - start[0], end[1] - start[1]
        if dx and dy:
            warnings.append(f"connector segment {start} to {end} is diagonal; use pipe routing")
        length = abs(dx) + abs(dy)
        if length < MIN_ARROW_SEGMENT:
            warnings.append(
                f"connector segment {start} to {end} is only {length:g}px; "
                f"use at least {MIN_ARROW_SEGMENT}px so the line and arrowhead remain visible"
            )
    points = " ".join(f"{a:g},{b:g}" for a, b in clean)
    return f'<polyline points="{points}" class="ar" marker-end="url(#chev)"/>'


def lines_of(item: dict[str, Any], title_cls: str, sub_cls: str) -> list[tuple[str, str]]:
    out = [(item["title"], title_cls)] if item.get("title") else []
    subs = item.get("lines", [])
    if isinstance(subs, str):
        subs = [subs]
    if item.get("sub"):
        subs = [item["sub"], *subs]
    return out + [(s, sub_cls) for s in subs]


def header(x: float, y: float, s: str | None) -> str:
    return text(x, y, s, "h") if s else ""


# ------------------------------------------------------------------ layouts

def overview(d: dict[str, Any]) -> tuple[str, int]:
    """Root box on the left; one wide box per item, its features as boxes inside it."""
    items = d["items"]
    row_h, gap, top = 150, 24, 120
    total = len(items) * row_h + (len(items) - 1) * gap
    name = d["title"]
    out = box(106, top, 268, total, "amber", lines_of(d["root"], "t", "ds"), f"{name} root")
    for i, item in enumerate(items):
        y = top + i * (row_h + gap)
        yc = y + row_h / 2
        out += arrow((388, yc), (426, yc))
        out += rect(440, y, 1074, row_h, "indigo")
        out += block(567, y, row_h, lines_of(item, "t", "ds"), 254, f"{name} / {item.get('title')}")
        feats = item.get("features", [])
        if feats:
            left, right, fgap = 700, 1490, 18
            fw = (right - left - fgap * (len(feats) - 1)) / len(feats)
            for j, f in enumerate(feats):
                out += box(left + j * (fw + fgap), y + 25, fw, row_h - 50, "slate",
                           lines_of(f, "d", "ds"), f"{name} / {item.get('title')} / feature {j + 1}", 16)
    return out, int(top + total + 60)


def dots(x: float, y0: float, rows: list[list[str]]) -> str:
    out = []
    for i, (color, label) in enumerate(rows):
        y = y0 + 33 * i
        out.append(f'<circle cx="{x:g}" cy="{y - 6:g}" r="7" class="dot {color}"/>')
        out.append(text(x + 22, y, label, "s", "start"))
    return "".join(out)


def inner(x: float, color: str, spec: dict[str, Any], where: str) -> str:
    if "dots" in spec:
        return rect(x, 160, 218, 175, color, 18) + text(x + 109, 208, spec.get("title", ""), "t2") + dots(x + 33, 258, spec["dots"])
    return box(x, 160, 218, 175, color, lines_of(spec, "t2", "s2"), where, 18)


def chain(cx: float, cy: float, names: list[str]) -> str:
    xs = [cx - 67, cx, cx + 67][: len(names)]
    out = []
    for x, n in zip(xs, names):
        out.append(f'<circle cx="{x:g}" cy="{cy:g}" r="21" class="circ"/>' + text(x, cy + 44, n, "tiny"))
    for a, b in zip(xs, xs[1:]):
        out.append(arrow((a + 21, cy), (b - 21, cy)))
    return "".join(out)


def flow(d: dict[str, Any]) -> tuple[str, int]:
    """start -> step (+) check[left | right] -> results; optional loop from check back to step."""
    name = d["title"]
    loop = d.get("loop")
    height = 840 if loop else 530
    hs = (d.get("headers") or [None] * 4) + [None] * 4
    out = header(240, 133, hs[0]) + header(567, 133, hs[1]) + header(1000, 133, hs[2]) + header(1407, 133, hs[3])

    out += box(106, 160, 268, 175, "amber", lines_of(d["start"], "t", "s"), f"{name} start")
    out += arrow((388, 247), (426, 247))
    step = d["step"]
    if "chain" in step:
        out += rect(440, 160, 254, 175, "indigo") + chain(567, 214, step["chain"])
        for k, s in enumerate(step.get("lines", [])[:2]):
            check_fit(s, "s", 254, f"{name} step")
            out += text(567, 296 + 27 * k, s, "s")
    else:
        out += box(440, 160, 254, 175, "indigo", lines_of(step, "t", "s"), f"{name} step")

    out += text(728, 258, "+", "plus") if d.get("join", "+") == "+" else arrow((708, 247), (746, 247))
    out += rect(760, 140, 480, 212, "outer", 24)
    out += inner(775, "green", d["check"]["left"], f"{name} check left")
    out += inner(1007, "slate", d["check"]["right"], f"{name} check right")

    results = d["results"]
    if len(results) > 3:
        warnings.append(f"{name}: {len(results)} results; only 3 fit, keep the 3 that matter")
    out += arrow((1255, 246), (1285, 246))
    for i, r in enumerate(results[:3]):
        out += box(1300, 140 + 92 * i, 214, 79, "slate" if i == 0 else "white",
                   lines_of(r, "d", "ds"), f"{name} result {i + 1}", 16)

    cap = d.get("caption")
    if cap:
        x = 1093 if loop else 1240
        for k, s in enumerate(cap[:2]):
            out += text(x, 382 + 29 * k, s, "n", "end")

    if loop:
        out += arrow((1115, 368), (1115, 665), (1032, 665))
        out += arrow((640, 665), (500, 665), (500, 352))
        left, right = loop.get("left", ["", ""]), loop.get("right", ["", ""])
        out += text(520, 497, left[0], "lb", "start") + text(520, 525, left[1], "ls", "start")
        out += text(1135, 497, right[0], "lb", "start") + text(1135, 525, right[1], "ls", "start")
        out += header(836, 560, loop.get("header"))
        lines = [(loop["title"], "t")] + ([(loop["note"], "n")] if loop.get("note") else [])
        out += box(640, 587, 392, 160, "indigo", lines, f"{name} loop")

    if d.get("footer"):
        out += text(1515, height - 50, d["footer"], "n", "end")
    return out, height


def custom_box(item: dict[str, Any], x: float, y: float, w: float, h: float,
               color: str, where: str, r: float = 20) -> str:
    return box(x, y, w, h, color, lines_of(item, "d", "ds"), where, r)


def railway_topology(d: dict[str, Any]) -> tuple[str, int]:
    """Layered Railway deployment topology with traffic, state, and provider boundaries."""
    out = '<rect x="440" y="105" width="650" height="570" rx="30" class="zone"/>'
    out += text(735, 145, d.get("zone", "Railway project"), "h")
    out += text(220, 176, "Application", "h")
    out += text(765, 176, "Gateway and state", "h")
    out += text(1360, 176, "Provider APIs", "h")

    out += custom_box(d["app"], 55, 260, 260, 150, "amber", f'{d["title"]} app')
    out += custom_box(d["gateway"], 600, 220, 330, 180, "indigo", f'{d["title"]} gateway')
    out += custom_box(d["database"], 625, 525, 280, 115, "green", f'{d["title"]} database')

    out += '<rect x="1210" y="215" width="320" height="370" rx="28" class="lane"/>'
    for i, provider in enumerate(d["providers"][:3]):
        out += custom_box(provider, 1245, 250 + 100 * i, 250, 72, "white",
                          f'{d["title"]} provider {i + 1}', 16)

    out += arrow((335, 335), (580, 335))
    out += arrow((950, 310), (1190, 310))
    out += arrow((765, 420), (765, 505))
    out += text(458, 310, d.get("traffic", "model traffic"), "n")
    out += text(1070, 285, d.get("protocol", "OpenAI-compatible API"), "n")

    for i, note in enumerate(d.get("notes", [])[:3]):
        out += text(230 + i * 520, 720, note, "n")
    return out, 770


def evidence_cycle(d: dict[str, Any]) -> tuple[str, int]:
    """Six-stage evidence cycle using orthogonal pipe connectors."""
    positions = [
        (60, 150), (610, 150), (1140, 150),
        (1140, 560), (610, 560), (60, 560),
    ]
    colors = ["amber", "indigo", "green", "slate", "indigo", "white"]
    out = custom_box(d["center"], 650, 330, 300, 130, "indigo", f'{d["title"]} center', 28)
    for i, (item, (x, y), color) in enumerate(zip(d["stages"][:6], positions, colors)):
        out += custom_box(item, x, y, 260, 105, color, f'{d["title"]} stage {i + 1}')

    out += arrow((340, 202), (590, 202))
    out += arrow((890, 202), (1120, 202))
    out += arrow((1270, 275), (1270, 540))
    out += arrow((1120, 612), (890, 612))
    out += arrow((590, 612), (340, 612))
    out += arrow((190, 540), (190, 275))

    out += arrow((740, 275), (740, 315))
    out += arrow((740, 475), (740, 540))
    out += text(800, 735, d.get("caption", "test, compare, record"), "n")
    return out, 785


def mintlify_split(d: dict[str, Any]) -> tuple[str, int]:
    """Side-by-side current failure path and proposed navigation experiment."""
    out = '<line x1="800" y1="115" x2="800" y2="650" class="divider"/>'
    out += text(400, 145, d.get("left_title", "Current traversal"), "h")
    out += text(1200, 145, d.get("right_title", "Proposed experiment"), "h")

    lx = [45, 320, 595]
    for i, (item, x) in enumerate(zip(d["current"][:3], lx)):
        color = "amber" if i == 0 else ("white" if i == 1 else "slate")
        out += custom_box(item, x, 245, 180, 115, color, f'{d["title"]} current {i + 1}', 18)
        if i < 2:
            out += arrow((x + 200, 302), (lx[i + 1] - 20, 302))
    out += custom_box(d["fallback"], 270, 480, 260, 105, "slate", f'{d["title"]} fallback', 18)
    out += arrow((685, 380), (685, 425), (400, 425), (400, 460))

    rx = [855, 1130, 1405]
    for i, (item, x) in enumerate(zip(d["experiment"][:3], rx)):
        color = "amber" if i == 0 else ("indigo" if i == 1 else "green")
        out += custom_box(item, x, 245, 180, 115, color, f'{d["title"]} experiment {i + 1}', 18)
        if i < 2:
            out += arrow((x + 200, 302), (rx[i + 1] - 20, 302))
    out += custom_box(d["measure"], 1070, 480, 260, 105, "green", f'{d["title"]} measure', 18)
    out += arrow((1495, 380), (1495, 425), (1200, 425), (1200, 460))
    out += text(400, 640, d.get("left_note", "Observed failure mode"), "n")
    out += text(1200, 640, d.get("right_note", "Hypothesis to validate"), "n")
    return out, 700


def agent_dual_view(d: dict[str, Any]) -> tuple[str, int]:
    """Same-response architecture splitting into human and agent views."""
    out = custom_box(d["request"], 60, 300, 230, 130, "amber", f'{d["title"]} request')
    out += custom_box(d["response"], 600, 260, 340, 200, "indigo", f'{d["title"]} response', 26)
    out += custom_box(d["selector"], 640, 80, 260, 100, "white", f'{d["title"]} selector', 18)
    out += custom_box(d["human"], 1240, 170, 300, 140, "green", f'{d["title"]} human')
    out += custom_box(d["agent"], 1240, 410, 300, 140, "slate", f'{d["title"]} agent')
    out += custom_box(d["data"], 600, 570, 340, 110, "green", f'{d["title"]} data')

    out += arrow((310, 365), (580, 365))
    out += arrow((770, 200), (770, 240))
    out += arrow((960, 330), (1080, 330), (1080, 240), (1220, 240))
    out += arrow((960, 390), (1080, 390), (1080, 480), (1220, 480))
    out += arrow((770, 550), (770, 480))
    out += text(1090, 205, "visual homepage", "n")
    out += text(1090, 515, "text-first briefing", "n")
    return out, 735


def operations_pipeline(d: dict[str, Any]) -> tuple[str, int]:
    """Publishing pipeline with a separate reliability rail."""
    xs = [40, 365, 690, 1015, 1340]
    colors = ["amber", "indigo", "indigo", "green", "slate"]
    out = text(800, 145, d.get("top_label", "Publishing path"), "h")
    for i, (item, x, color) in enumerate(zip(d["steps"][:5], xs, colors)):
        out += custom_box(item, x, 195, 190, 125, color, f'{d["title"]} step {i + 1}', 18)
        if i < 4:
            out += arrow((x + 210, 257), (xs[i + 1] - 20, 257))

    out += '<rect x="70" y="415" width="1460" height="150" rx="28" class="rail"/>'
    out += text(800, 452, d.get("rail_label", "Reliability rail"), "h")
    checks_x = [145, 505, 865, 1225]
    for i, (item, x) in enumerate(zip(d["checks"][:4], checks_x)):
        out += custom_box(item, x, 475, 210, 70, "white", f'{d["title"]} check {i + 1}', 15)
    out += arrow((250, 455), (250, 385), (135, 385), (135, 340))
    out += arrow((610, 455), (610, 385), (785, 385), (785, 340))
    out += arrow((970, 455), (970, 385), (1110, 385), (1110, 340))
    out += arrow((1330, 455), (1330, 385), (1435, 385), (1435, 340))
    out += text(800, 615, d.get("footer", "Account credentials excluded"), "n")
    return out, 660


LAYOUTS = {
    "overview": overview,
    "flow": flow,
    "railway-topology": railway_topology,
    "evidence-cycle": evidence_cycle,
    "mintlify-split": mintlify_split,
    "agent-dual-view": agent_dual_view,
    "operations-pipeline": operations_pipeline,
}


# ------------------------------------------------------------------ page

def css(t: dict[str, Any]) -> str:
    colors = "".join(
        f"  .{k} {{ fill:{v[0]}; stroke:{v[1]}; }}\n" for k, v in t.items() if isinstance(v, list)
    )
    return f"""
  :root {{ --page:{t['page']}; --card:{t['card']}; --ink:{t['ink']}; --muted:{t['muted']}; --line:{t['line']}; }}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; padding:40px 24px; background:var(--page); font-family:"Segoe UI",-apple-system,"Helvetica Neue",Arial,sans-serif; }}
  main {{ max-width:1280px; margin:0 auto; display:flex; flex-direction:column; gap:32px; }}
  svg {{ display:block; width:100%; height:auto; background:var(--card); border-radius:34px; }}
  svg.defs {{ position:absolute; width:0; height:0; background:none; }}
  .title {{ font-size:34px; font-weight:700; fill:var(--ink); }}
  .h {{ font-size:25px; fill:var(--muted); letter-spacing:.3px; }}
  .t {{ font-size:25px; font-weight:600; fill:var(--ink); }}
  .t2 {{ font-size:23px; font-weight:600; fill:var(--ink); }}
  .s {{ font-size:19px; fill:var(--muted); }}
  .s2 {{ font-size:18px; fill:var(--muted); }}
  .d {{ font-size:22px; font-weight:600; fill:var(--ink); }}
  .ds {{ font-size:18px; fill:var(--ink); }}
  .tiny {{ font-size:15px; fill:var(--muted); }}
  .n {{ font-family:Georgia,"Times New Roman",serif; font-style:italic; font-size:21px; fill:var(--muted); }}
  .lb {{ font-size:22px; font-weight:600; fill:var(--muted); }}
  .ls {{ font-size:19px; fill:var(--muted); }}
  .plus {{ font-size:42px; fill:var(--muted); }}
  .b {{ stroke-width:2.6; }}
{colors}  .outer {{ fill:var(--card); stroke:var(--line); }}
  .zone {{ fill:rgba(232,236,251,.42); stroke:var(--line); stroke-width:2; stroke-dasharray:9 8; }}
  .lane {{ fill:rgba(255,255,255,.45); stroke:var(--line); stroke-width:2; }}
  .rail {{ fill:rgba(228,232,238,.55); stroke:var(--line); stroke-width:2; }}
  .divider {{ stroke:var(--line); stroke-width:2; stroke-dasharray:8 10; }}
  .ar {{ fill:none; stroke:var(--muted); stroke-width:3; stroke-linecap:round; stroke-linejoin:round; }}
  .circ {{ fill:var(--card); stroke:var(--ink); stroke-width:2.6; }}
  .dot.grey {{ fill:{t['grey']}; }}
  .dot.red {{ fill:{t['red']}; }}
"""


def render(spec: dict[str, Any]) -> tuple[str, int]:
    theme = {**THEME, **spec.get("theme", {})}
    svgs, total = [], 80
    for d in spec["diagrams"]:
        layout = LAYOUTS.get(d.get("type", ""))
        if layout is None:
            raise SystemExit(f"unknown diagram type {d.get('type')!r}; use one of {', '.join(LAYOUTS)}")
        body, height = layout(d)
        title = text(105, 74, d["title"], "title", "start") if d.get("show_title", True) else ""
        svgs.append(f'<svg viewBox="0 0 {W} {height}" role="img" aria-label="{esc(d["title"])}">{title}{body}</svg>')
        total += round(height * 1280 / W) + 32
    page = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(spec.get("title", "Architecture"))}</title>
<style>{css(theme)}</style>
</head>
<body>
<svg class="defs" aria-hidden="true"><defs>
  <marker id="chev" viewBox="0 0 12 12" refX="9" refY="6" markerWidth="11" markerHeight="11" orient="auto-start-reverse">
    <path d="M2 2 L9 6 L2 10" fill="none" stroke="{theme['muted']}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
  </marker>
</defs></svg>
<main>
{chr(10).join(svgs)}
</main>
</body>
</html>
"""
    return page, total


# ------------------------------------------------------------------ screenshot

def find_browser() -> str | None:
    named = os.environ.get("BROWSER")
    if named and shutil.which(named):
        return shutil.which(named)
    for exe in ("msedge", "google-chrome", "chromium", "chromium-browser", "chrome"):
        if shutil.which(exe):
            return shutil.which(exe)
    for path in (
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ):
        if os.path.exists(path):
            return path
    return None


def screenshot(page: Path, png: Path, height: int) -> None:
    browser = find_browser()
    if browser is None:
        print("no Edge/Chrome found; open the HTML in a browser to check it", file=sys.stderr)
        return
    subprocess.run(
        [browser, "--headless", "--disable-gpu", "--hide-scrollbars", f"--screenshot={png.resolve()}",
         f"--window-size=1400,{height}", page.resolve().as_uri()],
        check=True, capture_output=True, timeout=120,
    )
    print(f"screenshot: {png.resolve()}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("spec")
    parser.add_argument("out")
    parser.add_argument("--shot", help="also save a PNG screenshot here")
    args = parser.parse_args()
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8")
    spec = json.loads(Path(args.spec).read_text(encoding="utf-8"))
    page, height = render(spec)
    out = Path(args.out)
    out.write_text(page, encoding="utf-8")
    print(f"wrote {out.resolve()}")
    for w in warnings:
        print(f"warning: {w}", file=sys.stderr)
    if args.shot:
        screenshot(out, Path(args.shot), height)


if __name__ == "__main__":
    main()
