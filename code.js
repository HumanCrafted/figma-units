"use strict";
/// <reference types="@figma/plugin-typings" />
/**
 * Units
 * -----
 * The inverse of Dims. Dims READS a node's pixel size and displays it as a
 * real-world measurement; Units takes a real-world measurement as INPUT and
 * SETS the node's pixels.
 *
 * Both plugins share one conversion model so they never drift:
 *
 *   PER_INCH = { in: 1, ft: 1/12, mm: 25.4, cm: 2.54, m: 0.0254 }
 *   Dims  (read):  value  = (pixels / dpi) * PER_INCH[unit]
 *   Units (write): pixels = (value / PER_INCH[unit]) * dpi
 *
 * v1 scope: rectangles, frames (and other resizable containers), and lines.
 * A LINE's own `width` is its geometric length in local coordinates, so
 * resize(len, 0) sets the true span along the line's own axis at any rotation
 * — the bounding-box wrinkle Dims solved on read doesn't bite us on write.
 *
 * Stroke weight is set in the same units but treated as a PEN weight: it is
 * converted at DPI only and ignores the drawing scale, the way a 0.35mm line
 * stays 0.35mm on paper whether the drawing is 1:1 or 1/4" = 1'.
 *
 * Corner radius, by contrast, is part of the object's geometry (a 1/4" radius
 * on a real part), so it converts exactly like width/height, scale included.
 *
 * Conventions inherited from Dims: TypeScript + standard plugin structure,
 * `hcd:` pluginData namespace, DPI/unit persisted via clientStorage, Figma
 * theme colors in the UI. No text is drawn, so there are no font concerns.
 */
const NS = 'hcd';
// Unit magnitude per inch. Canvas inches = pixels / dpi (Figma baseline dpi = 72).
// Kept byte-for-byte identical to Dims' PER_INCH so the two plugins stay consistent.
const PER_INCH = {
    in: 1,
    ft: 1 / 12,
    mm: 25.4,
    cm: 2.54,
    m: 0.0254,
};
const MIN_PX = 0.01; // Figma's smallest legal node dimension
const DEFAULTS = {
    dpi: 72,
    unit: 'in',
    scale: 1,
    aspectLock: false,
    centerAnchor: false,
    ignoreConstraints: false,
    applyToAll: false,
};
let settings = { ...DEFAULTS };
// ---------- conversion ----------
/** Write formula: real-world value -> pixels. Inverse of Dims' read formula.
 *  Includes the drawing scale: pixels = (value / PER_INCH[unit]) * dpi * scale. */
function toPx(value, unit, dpi, scale) {
    const perInch = PER_INCH[unit] !== undefined ? PER_INCH[unit] : 1;
    return (value / perInch) * dpi * scale;
}
/** Read formula (for prefilling fields from a node's current size).
 *  Matches Dims: value = (pixels / dpi) * PER_INCH[unit] / scale. */
function toUnit(px, unit, dpi, scale) {
    const perInch = PER_INCH[unit] !== undefined ? PER_INCH[unit] : 1;
    return dpi && scale ? ((px / dpi) * perInch) / scale : 0;
}
function isResizable(n) {
    return typeof n.resize === 'function';
}
function isLine(n) {
    return n.type === 'LINE';
}
/** Anything that carries a stroke weight (shapes, frames, text) — not the same
 *  set as resizable: groups and slices resize but have no stroke. */
function hasStrokes(n) {
    return 'strokeWeight' in n;
}
/** Nodes with a corner radius worth setting. Ellipses carry the property too,
 *  but it does nothing visible on a closed ellipse, so they're left out. */
function hasCorners(n) {
    return 'cornerRadius' in n && n.type !== 'ELLIPSE';
}
/** Something Units can act on: its size, stroke weight, or corner radius. */
function isTarget(n) {
    return isResizable(n) || hasStrokes(n) || hasCorners(n);
}
/** A container whose children carry constraints, so the resize() vs
 *  resizeWithoutConstraints() choice is meaningful. */
function hasConstrainedChildren(n) {
    const kids = n.children;
    return Array.isArray(kids) && kids.length > 0;
}
/**
 * Resize one node to the requested real-world dimensions.
 *  - width/height are in the current unit; null means "leave this axis alone".
 *  - LINE nodes take width as their length and are always resized to height 0.
 *  - aspectLock scales the untouched axis proportionally when only one is given.
 *  - centerAnchor repositions after resize so the node grows about its center.
 *  - ignoreConstraints uses resizeWithoutConstraints() for containers w/ children.
 * Returns true if the node was resized.
 */
function applyToNode(node, msg) {
    if (!isResizable(node))
        return false;
    const oldW = node.width;
    const oldH = node.height;
    const wantW = msg.width != null ? Math.max(toPx(msg.width, settings.unit, settings.dpi, settings.scale), MIN_PX) : null;
    const wantH = msg.height != null ? Math.max(toPx(msg.height, settings.unit, settings.dpi, settings.scale), MIN_PX) : null;
    // LINE: width is the geometric length; height stays 0. Aspect/center don't apply.
    if (isLine(node)) {
        if (wantW == null)
            return false; // only length is meaningful for a line
        node.resize(wantW, 0);
        return true;
    }
    let newW = wantW != null ? wantW : oldW;
    let newH = wantH != null ? wantH : oldH;
    // Aspect lock only kicks in when exactly one axis was provided — a single-field
    // entry scales the other to preserve the node's current ratio.
    if (settings.aspectLock && oldW > 0 && oldH > 0) {
        if (wantW != null && wantH == null)
            newH = Math.max(wantW * (oldH / oldW), MIN_PX);
        else if (wantH != null && wantW == null)
            newW = Math.max(wantH * (oldW / oldH), MIN_PX);
    }
    const useUnconstrained = settings.ignoreConstraints && hasConstrainedChildren(node);
    if (useUnconstrained)
        node.resizeWithoutConstraints(newW, newH);
    else
        node.resize(newW, newH);
    // resize() pins the top-left; recentre so the node grows/shrinks about its middle.
    if (settings.centerAnchor) {
        node.x = node.x - (node.width - oldW) / 2;
        node.y = node.y - (node.height - oldH) / 2;
    }
    return true;
}
/**
 * Set a node's stroke weight from a value in the current unit. Converted at DPI
 * only (scale = 1): stroke weight is a pen weight, not a scaled dimension.
 * Returns false if the node has no stroke to weight.
 */
function applyStroke(node, value) {
    if (!hasStrokes(node) || !node.strokes.length)
        return false;
    // The field prefills with the current weight rounded to 4 decimals, so
    // re-applying it untouched would nudge the weight by that rounding error.
    const cur = node.strokeWeight;
    if (typeof cur === 'number' && tidy(toUnit(cur, settings.unit, settings.dpi, 1)) === value)
        return true;
    const px = toPx(value, settings.unit, settings.dpi, 1);
    node.strokeWeight = px;
    // Rectangles/frames with per-side weights: make sure every side took it.
    if (node.strokeWeight !== px && 'strokeTopWeight' in node) {
        const sides = node;
        sides.strokeTopWeight = sides.strokeBottomWeight = sides.strokeLeftWeight = sides.strokeRightWeight = px;
    }
    return true;
}
/**
 * Set a node's corner radius from a value in the current unit. Unlike stroke,
 * radius is geometry, so the drawing scale applies. Returns false if the node
 * has no corners to round.
 */
function applyRadius(node, value) {
    if (!hasCorners(node))
        return false;
    // Same prefill-rounding guard as applyStroke.
    const cur = node.cornerRadius;
    if (typeof cur === 'number' && tidy(toUnit(cur, settings.unit, settings.dpi, settings.scale)) === value)
        return true;
    const px = toPx(value, settings.unit, settings.dpi, settings.scale);
    node.cornerRadius = px;
    // Rectangles/frames with per-corner radii: make sure every corner took it.
    if (node.cornerRadius !== px && 'topLeftRadius' in node) {
        const corners = node;
        corners.topLeftRadius = corners.topRightRadius = corners.bottomLeftRadius = corners.bottomRightRadius = px;
    }
    return true;
}
// ---------- selection reporting ----------
/** Round to at most 4 decimals and drop trailing zeros, for clean field prefills. */
function tidy(n) {
    return Math.round(n * 10000) / 10000;
}
// Signature of what the UI currently shows, so repeated reports (from polling or
// documentchange) only post when something actually changed — otherwise a live
// poll would overwrite a value the user is mid-typing every tick.
let lastSig = '';
function strokeSignature(n) {
    if (!hasStrokes(n))
        return '-';
    // strokeWeight can be figma.mixed (a symbol), which can't go in a template.
    const w = typeof n.strokeWeight === 'number' ? n.strokeWeight : 'mixed';
    return `${n.strokes.length}/${w}`;
}
function radiusSignature(n) {
    if (!hasCorners(n))
        return '-';
    return typeof n.cornerRadius === 'number' ? String(n.cornerRadius) : 'mixed';
}
function selectionSignature(sel) {
    const parts = sel.map((n) => `${n.id}:${n.width}:${n.height}:${strokeSignature(n)}:${radiusSignature(n)}`);
    // Include unit/dpi/scale so a settings change re-expresses the current size.
    return `${settings.unit}|${settings.dpi}|${settings.scale}|${parts.join(',')}`;
}
/**
 * Report the current selection to the UI: how many target nodes, whether any
 * are lines or have a stroke or corners, and — for a single selection — its
 * current size, stroke weight and radius in the chosen unit so the fields
 * prefill (the inverse-of-Dims convenience). No-ops when nothing observable
 * changed since the last report.
 */
function reportSelection() {
    const sel = figma.currentPage.selection.filter(isTarget);
    const sig = selectionSignature(sel);
    if (sig === lastSig)
        return;
    lastSig = sig;
    const lineCount = sel.filter(isLine).length;
    const hasStroke = sel.some((n) => hasStrokes(n) && n.strokes.length > 0);
    const hasRadius = sel.some(hasCorners);
    let width = null;
    let height = null;
    let stroke = null;
    let radius = null;
    let type = null;
    if (sel.length === 1) {
        const n = sel[0];
        type = n.type;
        if (isResizable(n)) {
            width = tidy(toUnit(n.width, settings.unit, settings.dpi, settings.scale));
            height = isLine(n) ? null : tidy(toUnit(n.height, settings.unit, settings.dpi, settings.scale));
        }
        if (hasStroke && hasStrokes(n)) {
            // Per-side weights that differ read back as figma.mixed.
            stroke = typeof n.strokeWeight === 'number'
                ? tidy(toUnit(n.strokeWeight, settings.unit, settings.dpi, 1))
                : 'mixed';
        }
        if (hasCorners(n)) {
            // Per-corner radii that differ (or per-vertex on vectors) read as figma.mixed.
            radius = typeof n.cornerRadius === 'number'
                ? tidy(toUnit(n.cornerRadius, settings.unit, settings.dpi, settings.scale))
                : 'mixed';
        }
    }
    figma.ui.postMessage({
        type: 'selection',
        count: sel.length,
        lineCount,
        single: sel.length === 1,
        nodeType: type,
        width,
        height,
        hasStroke,
        stroke,
        hasRadius,
        radius,
    });
}
// ---------- lifecycle ----------
const UI_WIDTH = 264;
figma.showUI(__html__, { width: UI_WIDTH, height: 340, themeColors: true });
figma.ui.onmessage = async (msg) => {
    if (msg.type === 'apply') {
        const sel = figma.currentPage.selection.filter(isTarget);
        if (!sel.length) {
            figma.notify('Select a rectangle, frame, or line first');
            return;
        }
        const sizeGiven = msg.width != null || msg.height != null;
        if (!sizeGiven && msg.stroke == null && msg.radius == null) {
            figma.notify('Enter a width, height, stroke weight, or radius');
            return;
        }
        // Don't silently resize just one of many: multi-select requires an explicit
        // "apply to all" so the intent is never ambiguous.
        if (sel.length > 1 && !settings.applyToAll) {
            figma.notify('Multiple objects selected — enable "Apply to all selected" or select one');
            return;
        }
        const targets = settings.applyToAll ? sel : [sel[0]];
        let done = 0;
        let noStroke = 0;
        let noCorners = 0;
        for (const n of targets) {
            let changed = false;
            if (sizeGiven && applyToNode(n, msg))
                changed = true;
            if (msg.stroke != null) {
                if (applyStroke(n, msg.stroke))
                    changed = true;
                else
                    noStroke++;
            }
            if (msg.radius != null) {
                if (applyRadius(n, msg.radius))
                    changed = true;
                else
                    noCorners++;
            }
            if (changed)
                done++;
        }
        const suffix = settings.applyToAll && sel.length > 1 ? ` (of ${sel.length} selected)` : '';
        const skipped = (noStroke ? ` · ${noStroke} without a stroke skipped` : '')
            + (noCorners ? ` · ${noCorners} without corners skipped` : '');
        figma.notify((done ? `Updated ${done} object${done === 1 ? '' : 's'}${suffix}` : 'Nothing to update in selection') + skipped);
        reportSelection(); // reflect the new sizes back into the fields
    }
    else if (msg.type === 'settings') {
        settings = { ...settings, ...msg.settings };
        await figma.clientStorage.setAsync('settings', settings);
        reportSelection(); // unit/dpi change -> re-express current size in the new unit
    }
    else if (msg.type === 'requestSelection' || msg.type === 'poll') {
        // 'poll' is the UI's timer tick — the reliable driver for live-tracking a
        // drag-resize. reportSelection() dedupes, so idle ticks cost nothing.
        reportSelection();
    }
    else if (msg.type === 'coffee') {
        // Open the tip link in the user's browser. URL is hardcoded here (not taken
        // from the message) so nothing but this exact destination can be launched.
        figma.openExternal('https://www.buymeacoffee.com/jonalling');
    }
    else if (msg.type === 'resize') {
        const h = Math.max(80, Math.min(1000, Math.round(msg.height || 0)));
        figma.ui.resize(UI_WIDTH, h);
    }
};
figma.on('selectionchange', reportSelection);
/**
 * Live-refresh the fields when a selected node's size changes on the canvas
 * (e.g. the user drags a resize handle). We only READ sizes here and post them
 * to the UI — no document mutation — so unlike Dims' live label recalc this
 * needs no reentrancy guard. Watches size, stroke and radius only; a plain
 * move (x/y) is ignored since it changes none of them.
 */
const WATCHED = [
    'width', 'height', 'strokeWeight', 'strokes',
    'cornerRadius', 'topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius',
];
function onDocChange(e) {
    const selIds = new Set(figma.currentPage.selection.map((n) => n.id));
    if (!selIds.size)
        return;
    for (const c of e.documentChanges) {
        if (c.type !== 'PROPERTY_CHANGE')
            continue;
        if (!c.properties.some((p) => WATCHED.includes(p)))
            continue;
        const n = c.node;
        if (n && !n.removed && selIds.has(n.id)) {
            reportSelection();
            return;
        }
    }
}
(async function init() {
    const saved = (await figma.clientStorage.getAsync('settings'));
    if (saved)
        settings = { ...DEFAULTS, ...saved };
    figma.ui.postMessage({ type: 'init', settings });
    reportSelection();
    // documentchange gives an instant update when it fires; the UI poll is the
    // reliable fallback (esp. during an interactive drag). Registering the event
    // requires loadAllPagesAsync under dynamic-page access — guard it so a failure
    // here never takes down the poll-driven path.
    try {
        await figma.loadAllPagesAsync();
        figma.on('documentchange', onDocChange);
    }
    catch (e) {
        /* poll still covers live updates */
    }
})();
