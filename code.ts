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
 * Conventions inherited from Dims: TypeScript + standard plugin structure,
 * `hcd:` pluginData namespace, DPI/unit persisted via clientStorage, Figma
 * theme colors in the UI. No text is drawn, so there are no font concerns.
 */

const NS = 'hcd';

// Unit magnitude per inch. Canvas inches = pixels / dpi (Figma baseline dpi = 72).
// Kept byte-for-byte identical to Dims' PER_INCH so the two plugins stay consistent.
const PER_INCH: Record<string, number> = {
  in: 1,
  ft: 1 / 12,
  mm: 25.4,
  cm: 2.54,
  m: 0.0254,
};

const MIN_PX = 0.01; // Figma's smallest legal node dimension

interface Settings {
  dpi: number;             // pixels per inch (Figma baseline = 72)
  unit: string;            // 'in' | 'ft' | 'mm' | 'cm' | 'm'
  scale: number;           // drawing scale: entered value = real size / scale
  aspectLock: boolean;     // set one dimension, scale the other proportionally
  centerAnchor: boolean;   // resize() pins top-left; re-center after resize
  ignoreConstraints: boolean; // frames w/ children: resizeWithoutConstraints()
  applyToAll: boolean;     // apply the same dimension(s) to every selected node
}

const DEFAULTS: Settings = {
  dpi: 72,
  unit: 'in',
  scale: 1,
  aspectLock: false,
  centerAnchor: false,
  ignoreConstraints: false,
  applyToAll: false,
};

let settings: Settings = { ...DEFAULTS };

// ---------- conversion ----------

/** Write formula: real-world value -> pixels. Inverse of Dims' read formula.
 *  Includes the drawing scale: pixels = (value / PER_INCH[unit]) * dpi * scale. */
function toPx(value: number, unit: string, dpi: number, scale: number): number {
  const perInch = PER_INCH[unit] !== undefined ? PER_INCH[unit] : 1;
  return (value / perInch) * dpi * scale;
}

/** Read formula (for prefilling fields from a node's current size).
 *  Matches Dims: value = (pixels / dpi) * PER_INCH[unit] / scale. */
function toUnit(px: number, unit: string, dpi: number, scale: number): number {
  const perInch = PER_INCH[unit] !== undefined ? PER_INCH[unit] : 1;
  return dpi && scale ? ((px / dpi) * perInch) / scale : 0;
}

// ---------- node classification ----------

type Resizable = SceneNode & {
  resize: (w: number, h: number) => void;
  resizeWithoutConstraints: (w: number, h: number) => void;
};

function isResizable(n: SceneNode): n is Resizable {
  return typeof (n as { resize?: unknown }).resize === 'function';
}

function isLine(n: SceneNode): n is LineNode {
  return n.type === 'LINE';
}

/** A container whose children carry constraints, so the resize() vs
 *  resizeWithoutConstraints() choice is meaningful. */
function hasConstrainedChildren(n: SceneNode): boolean {
  const kids = (n as ChildrenMixin & SceneNode).children;
  return Array.isArray(kids) && kids.length > 0;
}

// ---------- the setter ----------

interface ApplyMsg {
  width: number | null;  // in current unit; null = leave unchanged
  height: number | null; // in current unit; null = leave unchanged
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
function applyToNode(node: SceneNode, msg: ApplyMsg): boolean {
  if (!isResizable(node)) return false;

  const oldW = node.width;
  const oldH = node.height;

  const wantW = msg.width != null ? Math.max(toPx(msg.width, settings.unit, settings.dpi, settings.scale), MIN_PX) : null;
  const wantH = msg.height != null ? Math.max(toPx(msg.height, settings.unit, settings.dpi, settings.scale), MIN_PX) : null;

  // LINE: width is the geometric length; height stays 0. Aspect/center don't apply.
  if (isLine(node)) {
    if (wantW == null) return false; // only length is meaningful for a line
    node.resize(wantW, 0);
    return true;
  }

  let newW = wantW != null ? wantW : oldW;
  let newH = wantH != null ? wantH : oldH;

  // Aspect lock only kicks in when exactly one axis was provided — a single-field
  // entry scales the other to preserve the node's current ratio.
  if (settings.aspectLock && oldW > 0 && oldH > 0) {
    if (wantW != null && wantH == null) newH = Math.max(wantW * (oldH / oldW), MIN_PX);
    else if (wantH != null && wantW == null) newW = Math.max(wantH * (oldW / oldH), MIN_PX);
  }

  const useUnconstrained = settings.ignoreConstraints && hasConstrainedChildren(node);
  if (useUnconstrained) node.resizeWithoutConstraints(newW, newH);
  else node.resize(newW, newH);

  // resize() pins the top-left; recentre so the node grows/shrinks about its middle.
  if (settings.centerAnchor) {
    node.x = node.x - (node.width - oldW) / 2;
    node.y = node.y - (node.height - oldH) / 2;
  }

  return true;
}

// ---------- selection reporting ----------

/** Round to at most 4 decimals and drop trailing zeros, for clean field prefills. */
function tidy(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// Signature of what the UI currently shows, so repeated reports (from polling or
// documentchange) only post when something actually changed — otherwise a live
// poll would overwrite a value the user is mid-typing every tick.
let lastSig = '';

function selectionSignature(sel: Resizable[]): string {
  const parts = sel.map((n) => `${n.id}:${n.width}:${n.height}`);
  // Include unit/dpi/scale so a settings change re-expresses the current size.
  return `${settings.unit}|${settings.dpi}|${settings.scale}|${parts.join(',')}`;
}

/**
 * Report the current selection to the UI: how many resizable nodes, whether any
 * are lines, and — for a single selection — its current size in the chosen unit
 * so the fields prefill (the inverse-of-Dims convenience). No-ops when nothing
 * observable changed since the last report.
 */
function reportSelection() {
  const sel = figma.currentPage.selection.filter(isResizable);
  const sig = selectionSignature(sel);
  if (sig === lastSig) return;
  lastSig = sig;
  const lineCount = sel.filter(isLine).length;
  let width: number | null = null;
  let height: number | null = null;
  let type: string | null = null;

  if (sel.length === 1) {
    const n = sel[0];
    type = n.type;
    width = tidy(toUnit(n.width, settings.unit, settings.dpi, settings.scale));
    height = isLine(n) ? null : tidy(toUnit(n.height, settings.unit, settings.dpi, settings.scale));
  }

  figma.ui.postMessage({
    type: 'selection',
    count: sel.length,
    lineCount,
    single: sel.length === 1,
    nodeType: type,
    width,
    height,
  });
}

// ---------- lifecycle ----------

const UI_WIDTH = 264;
figma.showUI(__html__, { width: UI_WIDTH, height: 340, themeColors: true });

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'apply') {
    const sel = figma.currentPage.selection.filter(isResizable);
    if (!sel.length) {
      figma.notify('Select a rectangle, frame, or line first');
      return;
    }
    if (msg.width == null && msg.height == null) {
      figma.notify('Enter a width and/or height');
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
    for (const n of targets) {
      if (applyToNode(n, { width: msg.width, height: msg.height })) done++;
    }
    const suffix = settings.applyToAll && sel.length > 1 ? ` (of ${sel.length} selected)` : '';
    figma.notify(done ? `Resized ${done} object${done === 1 ? '' : 's'}${suffix}` : 'Nothing resizable in selection');
    reportSelection(); // reflect the new sizes back into the fields
  } else if (msg.type === 'settings') {
    settings = { ...settings, ...msg.settings };
    await figma.clientStorage.setAsync('settings', settings);
    reportSelection(); // unit/dpi change -> re-express current size in the new unit
  } else if (msg.type === 'requestSelection' || msg.type === 'poll') {
    // 'poll' is the UI's timer tick — the reliable driver for live-tracking a
    // drag-resize. reportSelection() dedupes, so idle ticks cost nothing.
    reportSelection();
  } else if (msg.type === 'coffee') {
    // Open the tip link in the user's browser. URL is hardcoded here (not taken
    // from the message) so nothing but this exact destination can be launched.
    figma.openExternal('https://www.buymeacoffee.com/jonalling');
  } else if (msg.type === 'resize') {
    const h = Math.max(80, Math.min(1000, Math.round(msg.height || 0)));
    figma.ui.resize(UI_WIDTH, h);
  }
};

figma.on('selectionchange', reportSelection);

/**
 * Live-refresh the fields when a selected node's size changes on the canvas
 * (e.g. the user drags a resize handle). We only READ sizes here and post them
 * to the UI — no document mutation — so unlike Dims' live label recalc this
 * needs no reentrancy guard. Watches width/height only; a plain move (x/y) is
 * ignored since it doesn't change the dimensions.
 */
function onDocChange(e: DocumentChangeEvent) {
  const selIds = new Set(figma.currentPage.selection.map((n) => n.id));
  if (!selIds.size) return;
  for (const c of e.documentChanges) {
    if (c.type !== 'PROPERTY_CHANGE') continue;
    if (!(c.properties.includes('width') || c.properties.includes('height'))) continue;
    const n = c.node as SceneNode;
    if (n && !n.removed && selIds.has(n.id)) {
      reportSelection();
      return;
    }
  }
}

(async function init() {
  const saved = (await figma.clientStorage.getAsync('settings')) as Partial<Settings> | undefined;
  if (saved) settings = { ...DEFAULTS, ...saved };
  figma.ui.postMessage({ type: 'init', settings });
  reportSelection();
  // documentchange gives an instant update when it fires; the UI poll is the
  // reliable fallback (esp. during an interactive drag). Registering the event
  // requires loadAllPagesAsync under dynamic-page access — guard it so a failure
  // here never takes down the poll-driven path.
  try {
    await figma.loadAllPagesAsync();
    figma.on('documentchange', onDocChange);
  } catch (e) {
    /* poll still covers live updates */
  }
})();
