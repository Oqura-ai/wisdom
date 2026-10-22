---
name: architecture-diagrams
description: Draw minimal architecture and flow diagrams as one self-contained HTML file in a soft card style (inline SVG, rounded pastel boxes, chevron arrows, a feedback loop). Use when the user asks for architecture diagrams, flow charts, a system or tool overview, or "draw how X works" in HTML.
---

# Architecture diagrams in HTML

One page, one card per diagram, rendered from a JSON spec by `scripts/render.py`. The look is
fixed (calm palette, plain sans labels, italic serif side notes); your job is choosing what the
boxes say.

## Workflow

1. **Learn the system from the source**, not from memory or docs. Every label must be true of the
   current code: what triggers it, what decides, what comes out. Note anything you can't confirm.
2. **Plan the diagrams.** Usually one `overview` (what the product gives you), then one `flow` per
   component (how it works). Ask the user if the split isn't obvious.
3. **Write the spec** as a JSON file with the Write tool (shell heredocs can mangle `\n`, `\b` and
   other backslashes). Start from `examples/optim-jev.json`.
4. **Render and look:**
   ```
   python <skill>/scripts/render.py spec.json out.html --shot out.png
   ```
   Fix every `warning:` line (a label that will overflow, too many lines, too many results), then
   open `out.png` with the Read tool and check the picture yourself before handing it over.
5. **Hand over** the HTML path, and say plainly which labels simplify the code, or what you
   couldn't verify.

## Connector rules

- Route connectors as orthogonal pipes: every segment must be horizontal or vertical. Do not use diagonal segments.
- Never emit duplicate consecutive points or zero-length connector segments.
- Every connector segment, especially the final segment carrying the arrowhead, must be at least 24 px long. This is a hard failure threshold, not a layout target.
- Prefer 80–140 px of clear connector corridor between major boxes. When labels require larger boxes, expand the canvas or card and redistribute the nodes instead of compressing the pipe.
- Keep at least 40 px of clearance between a connector and unrelated boxes, labels, or parallel connectors. Use longer orthogonal runs and deliberate elbows so flows remain easy to trace.
- Treat every connector warning from `scripts/render.py` as a required fix. A visible arrowhead without a clearly visible line is a failed render even when boxes do not overlap.
- Inspect the screenshot at full size and verify each pipe visually connects the intended box edges without appearing detached, collapsed, or ambiguous.

## What goes in the boxes

- **No descriptions.** Labels only: a title of 1–4 words and at most two short lines under it.
  No paragraphs, no legends, no explanatory text blocks.
- **Overview = deliverables only.** What each part gives the user. No mechanisms: no hooks,
  processes, APIs, file formats, prices, logs or thresholds. No column headings.
- **Nest features inside what they belong to.** A component's capabilities go inside its box.
- **Don't pad for symmetry.** One real feature is one box; never invent a second or third to even
  the rows out.
- **Only real capabilities.** Reporting (stats, logs) is not a feature of the product.
- **Name outcomes by what the user gets**, not by how it happens ("shortlist", "names only").
- **Say the true thing, not the flattering one.** Don't claim a benefit the code doesn't deliver
  (e.g. "keeps the prompt cache intact"); if a label simplifies, say so when you hand over.
- **Flows show the mechanism, minimally.** Plain-noun column headers (Trigger, Judge, Check,
  Result); leave numbers and thresholds out unless they are the point.
- **Use the user's own terms** for products and features, spelled as they spell them.
- **Don't copy a reference image's colours exactly.** If the user brings a reference, match its
  structure and calm, and keep this skill's palette (or shift it via `theme`).

## Spec

```json
{
  "title": "page title",
  "theme": { "page": "#e3e8ee" },
  "diagrams": [ { "type": "overview", ... }, { "type": "flow", ... } ]
}
```

`theme` is optional; keys: `page`, `card`, `ink`, `muted`, `line`, `red`, `grey`, and the box
colours `amber`, `indigo`, `green`, `slate`, `white` as `[fill, stroke]`.

A text item is `{ "title": "...", "lines": ["...", "..."] }` (`lines` optional).

### `overview`: what the product gives you

```json
{ "type": "overview", "title": "optim-jev",
  "root":  { "title": "One plugin", "lines": ["3 tools"] },
  "items": [
    { "title": "jev-router", "lines": ["cheaper subagents"],
      "features": [ { "title": "Routes by your rules", "lines": ["right model, not just cheapest"] } ] } ] }
```

The root box sits on the left. Each item is one wide box, with its features filling it left to
right. One to three features per item; two lines of text per feature at most.

### `flow`: how one part works

```json
{ "type": "flow", "title": "jev-compacter",
  "headers": ["Trigger", "Judge", "Check", "Result"],
  "start":  { "title": "/compact", "lines": ["auto-limit 85%"] },
  "step":   { "title": "Jev, per tool call", "lines": ["keep · truncate · drop"] },
  "check":  { "left":  { "title": "Tokens freed", "lines": ["8k or more"] },
              "right": { "title": "Errors", "dots": [["grey", "write 1 — ok"], ["red", "write 2 — error"]] } },
  "results": [ { "title": "enough freed", "lines": ["apply the prune"] } ],
  "caption": ["side note, line 1", "line 2"],
  "loop":   { "header": "Memory", "title": "Keeps Jev's scores", "note": "per session",
              "left": ["reused scores", "confident calls skipped"],
              "right": ["new scores", "saved after each run"] },
  "footer": "logs → /jev-compact stats" }
```

- Columns: `start` (amber) → `step` (indigo) **+** `check` (two inner boxes, green and slate) →
  up to 3 `results` (the first is shaded as the main outcome).
- `step` may be a `"chain": ["a", "b", "c"]` of up to three circles (a ladder or pipeline), with
  up to two `lines` under it, instead of a title.
- A `check` side may be a `"dots"` list of `[colour, label]` rows (`grey` or `red`), for a run
  of attempts.
- `"join": "arrow"` uses an arrow instead of the `+` between step and check.
- `loop` (optional) draws the bottom feedback box: an arrow from check down into it, and one from it
  back up into `step`. `left` and `right` label those two arrows.
- `caption` is up to two italic lines under the check box; `footer` is one italic line at the
  bottom right.
- `"show_title": false` hides a diagram's title.

## Limits (the renderer warns past these)

| Place | Width | Fits about |
|---|---|---|
| start box | 268px | 18 characters of title, 26 per line |
| step box | 254px | 17 / 24 |
| check inner box | 218px | 15 / 21 |
| result box | 214px | 17 / 22 |
| overview feature (2 per row) | 386px | 30 / 40 |

Need a layout these two can't express? Add a function to `LAYOUTS` in `scripts/render.py`,
reusing `box`, `rect`, `arrow`, `block` and `text`, rather than writing SVG by hand.
