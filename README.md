# Units

A focused Figma plugin that sets a node's true pixel dimensions from a
real-world measurement. Draw a box or line, select it, type a width and/or
height in a chosen unit (at a chosen DPI), and Units converts to pixels and
resizes the node.

## Features

- Set **width and/or height** in `in`, `ft`, `mm`, `cm`, or `m` at any DPI.
- **Drawing scale** — enter `1`, `0.25`, or a fraction like `1/4`; the entered
value is the real-world size and the node is set to `size / scale` on canvas.
- Single-field entry — set just W or just H, leaving the other unchanged.
- Works on **rectangles, frames** (and other resizable containers), and **lines**
(a line's width is set as its geometric length via `resize(len, 0)`).
- Current size **prefills** the fields in the chosen unit when one node is selected.
- **Lock aspect ratio** — set one dimension, scale the other proportionally.
- **Resize from center** — reposition after resize instead of pinning top-left.
- **Ignore child constraints** — `resizeWithoutConstraints()` for frames with children.
- **Apply to all selected** — same dimensions to every selected node (explicit; a
multi-selection won't silently resize just one).
- DPI and unit persist across sessions via `clientStorage`.

## Roadmap

- Rotated lines via the Dims measured-span (`0..LEN`) approach.
- Snap-to-unit: round moved/resized nodes to whole units on `documentchange`
(`pxPerUnit = (1 / PER_INCH[unit]) * dpi`), with an optional readout for the
native Preferences → Nudge amount value.

## Development

```
npm install
npm run build      # compile code.ts -> code.js
npm run watch      # recompile on change
```

Then in Figma: **Plugins → Development → Import plugin from manifest…** and pick
`manifest.json`. The compiled `code.js` is committed so the plugin loads without
a build step.