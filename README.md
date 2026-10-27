# Units

A focused Figma plugin that sets a node's true pixel dimensions from a
real-world measurement. Draw a box or line, select it, type a width and/or
height in a chosen unit (at a chosen DPI), and Units converts to pixels and
resizes the node.

## Features

- **Real-world units:** in, ft, mm, cm, m, with a configurable DPI and drawing scale
  (enter `1`, `0.25`, or a fraction like `1/4`).
- **Width and/or height:** set both or just one — a single-field entry leaves the
  other axis unchanged.
- **Stroke weight:** set line weight in the same units, as a pen weight — converted at
  DPI only, so the drawing scale doesn't apply (0.35 mm stays 0.35 mm at any scale).
- **Corner radius:** set in the same units on rectangles, frames, polygons, stars and
  vectors. Radius is part of the object's geometry, so it follows the drawing scale
  like width and height.
- **Aspect-ratio lock:** set one dimension and scale the other proportionally, with a
  native-style constrain-proportions toggle.
- **Works on all shape tools, groups, and frames:** any resizable node; a line's width
  is set as its geometric length.
- **Pre-fill from selection:** the current size fills the fields in the chosen unit
  when a single node is selected, and tracks live as you drag-resize on the canvas.
- **Resize from center:** reposition after resize instead of pinning the top-left.
- **Apply to all selected:** the same dimensions to every selected node — explicit, so
  a multi-selection never silently resizes just one.

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

## Credits

Units was developed with the assistance of [Claude Code](https://claude.com/claude-code).

## License

MIT (c) Human Crafted, LLC. See [LICENSE](LICENSE) for details.