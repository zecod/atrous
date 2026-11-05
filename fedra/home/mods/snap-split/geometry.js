// Where things are on screen, for the drop zones: the shown tab's area from the
// layout tree, and each of its panes from the tab's split tree. Pure functions,
// all in mod px with the window's top left at 0,0.

import { readTextFile, home } from "atrous";
import * as fs from "fs/promises";

const pad = (p) => (Array.isArray(p) ? [p[0] ?? 0, p[1] ?? p[0] ?? 0] : [p ?? 0, p ?? 0]);
const clamp = (v, lo, hi) => Math.min(hi ?? Infinity, Math.max(lo ?? -Infinity, v));

export function find(node, test) {
  if (!node) return null;
  if (test(node)) return node;
  for (const c of node.children ?? []) {
    const hit = find(c, test);
    if (hit) return hit;
  }
  return null;
}

// Lays out a row/column/stack tree into `out` (id -> rect). `gapOf` / `divOf`
// say how far apart a container's children sit.
function solve(node, r, out, gapOf, divOf) {
  if (!node || node.hidden) return;
  if (node.id != null) out.set(node.id, r);
  const [pv, ph] = pad(node.padding);
  const box = { x: r.x + ph, y: r.y + pv, w: Math.max(0, r.w - 2 * ph), h: Math.max(0, r.h - 2 * pv) };
  const kids = (node.children ?? []).filter((c) => !c.hidden);
  if (!kids.length) return;
  if (node.type === "stack") {
    for (const c of kids) solve(c, box, out, gapOf, divOf);
    return;
  }
  const across = node.type === "row";
  const gap = gapOf(node) + divOf(node);
  const room = (across ? box.w : box.h) - gap * (kids.length - 1);
  const fixed = kids.map((c) => (c.size?.px != null ? clamp(c.size.px, c.min, c.max) : null));
  const weight = (c) => c.size?.weight ?? c.weight ?? 1;
  const left = Math.max(0, room - fixed.reduce((s, v) => s + (v ?? 0), 0));
  const total = kids.reduce((s, c, i) => s + (fixed[i] == null ? weight(c) : 0), 0) || 1;
  let at = across ? box.x : box.y;
  kids.forEach((c, i) => {
    const len = fixed[i] ?? clamp((left * weight(c)) / total, c.min, c.max);
    solve(c, across ? { x: at, y: box.y, w: len, h: box.h } : { x: box.x, y: at, w: box.w, h: len }, out, gapOf, divOf);
    at += len + gap;
  });
}

// The block showing the active tab, and the look its panes are drawn with.
export function tabArea(tree, size) {
  const block = find(tree, (n) => n?.content?.tab === "active");
  if (!block || !size) return null;
  const rects = new Map();
  solve(tree, { x: 0, y: 0, w: size.width, h: size.height }, rects, (n) => n.gap ?? 0, (n) => n.divider?.width ?? 0);
  const rect = rects.get(block.id);
  return rect ? { rect, gap: block.content.pane?.gap ?? 0 } : null;
}

// Each pane of a tab tree (the core's document) -> its rect inside `area`.
export function paneRects(root, area, gap) {
  const rects = new Map();
  solve(root, area, rects, () => gap, () => 0);
  const out = new Map();
  (function leaves(n) {
    if (!n) return;
    if (n.type === "block") { if (rects.has(n.id)) out.set(n.id, rects.get(n.id)); return; }
    (n.children ?? []).forEach(leaves);
  })(root);
  return out;
}

// The tab's split tree, from the core's saved copy of Atrous's document (this
// computer only). Undocumented, so anything odd gives null and the caller falls
// back to treating the focused pane as the whole area. The core's session
// (ATC_SESSION) names the folder: `default` first, then any other that has the tab.
// The app's document is "atrous" in docs.json.
export async function readTabTree(tab) {
  if (!tab) return null;
  const h = home().replace(/[\\/]+$/, "");
  const roots = [
    `${h}\\AppData\\Local\\atrous-core`,
    `${h}/Library/Application Support/atrous-core`,
    `${h}/.local/state/atrous-core`,
    `${h}/.local/share/atrous-core`,
  ];
  const lookIn = async (file) => {
    try {
      const text = await readTextFile(file);
      if (!text) return undefined;
      const doc = JSON.parse(text)?.["atrous"]?.value;
      for (const s of doc?.spaces ?? []) for (const t of s.tabs ?? []) if (t.id === tab) return t.root ?? null;
    } catch {}
    return undefined;
  };
  for (const root of roots) {
    const sep = root.includes("\\") ? "\\" : "/";
    const found = await lookIn(`${root}${sep}default${sep}docs.json`);
    if (found !== undefined) return found;
    let sessions = [];
    try { sessions = (await fs.readdir(root)).filter((n) => n !== "default"); } catch {}
    for (const s of sessions) {
      const other = await lookIn(`${root}${sep}${s}${sep}docs.json`);
      if (other !== undefined) return other;
    }
  }
  return null;
}

// Windows 11's snap bar: during a drag it hangs over the top of the tab (where the
// tab bar is), so a drag toward the top, or onto the tab bar, has somewhere to land.
// Its tiles: [left | right], [top / bottom], [new tab]. Returns the bar and its cells.
export function snapBar(area) {
  if (!area) return null;
  const tileW = 62, tileH = 40, gap = 10, pad = 10;
  const w = pad * 2 + tileW * 3 + gap * 2, h = pad * 2 + tileH;
  const bar = { x: area.x + (area.w - w) / 2, y: Math.max(4, area.y - h + 14), w, h };
  const tile = (i) => ({ x: bar.x + pad + i * (tileW + gap), y: bar.y + pad, w: tileW, h: tileH });
  const t0 = tile(0), t1 = tile(1), t2 = tile(2);
  const hw = (tileW - 3) / 2, hh = (tileH - 3) / 2;
  const cells = [
    { side: "left", rect: { x: t0.x, y: t0.y, w: hw, h: tileH } },
    { side: "right", rect: { x: t0.x + hw + 3, y: t0.y, w: hw, h: tileH } },
    { side: "top", rect: { x: t1.x, y: t1.y, w: tileW, h: hh } },
    { side: "bottom", rect: { x: t1.x, y: t1.y + hh + 3, w: tileW, h: hh } },
    { side: "tab", rect: t2 },
  ];
  return { bar, tiles: [t0, t1, t2], cells };
}

const inside = (p, r) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;
const half = (r, side, gap) => {
  const w = (r.w - gap) / 2, h = (r.h - gap) / 2;
  if (side === "left") return { x: r.x, y: r.y, w, h: r.h };
  if (side === "right") return { x: r.x + w + gap, y: r.y, w, h: r.h };
  if (side === "top") return { x: r.x, y: r.y, w: r.w, h };
  return { x: r.x, y: r.y + h + gap, w: r.w, h };
};
// What keep + swap make of each side: keep only goes right of or below the
// focused pane, so left and top swap afterwards.
const MOVES = {
  left: { place: "right", swap: "left" },
  right: { place: "right", swap: null },
  top: { place: "down", swap: "up" },
  bottom: { place: "down", swap: null },
};

export const insideRect = inside;

// One side of one target pane, as keep + swap make it ("tab": a new tab).
export function zoneFor(side, target, area, gap) {
  if (!target) return null;
  if (side === "tab") return { side, pane: target.pane, rect: area, place: "tab", swap: null };
  return { side, pane: target.pane, rect: half(target.rect, side, gap), ...MOVES[side] };
}

// The zone under `pt`. `targets`: [{ pane, rect }] the agent may land beside.
// Edges split that pane in half (a half that is already a column or a row gives
// a quarter of the area from its corners); the middle makes a new tab.
// `bar` (snapBar) wins where it is, its cells acting on `barTarget`.
export function zoneAt(pt, area, targets, gap, bar, barTarget) {
  const cell = bar && barTarget ? bar.cells.find((c) => inside(pt, c.rect)) : null;
  if (cell) return { ...zoneFor(cell.side, barTarget, area, gap), cell: cell.side };
  if (bar && inside(pt, bar.bar)) return null;
  if (!area || !inside(pt, area)) return null;
  const t = targets.find((x) => inside(pt, x.rect));
  if (!t) return null;
  const r = t.rect;
  const u = (pt.x - r.x) / r.w, v = (pt.y - r.y) / r.h;
  if (Math.abs(u - 0.5) < 0.17 && Math.abs(v - 0.5) < 0.17) return { side: "tab", pane: t.pane, rect: area, place: "tab", swap: null };
  const edge = [["left", u], ["right", 1 - u], ["top", v], ["bottom", 1 - v]].sort((a, b) => a[1] - b[1]);
  let side = edge[0][0];
  // A corner of a pane that is already half of the area: split it the other
  // way, so its corner becomes a quarter, as Windows snaps a window to a corner.
  const corner = (u < 0.3 || u > 0.7) && (v < 0.3 || v > 0.7);
  if (corner) {
    const tall = r.h >= area.h * 0.75, wide = r.w >= area.w * 0.75;
    if (tall && !wide) side = v < 0.5 ? "top" : "bottom";
    else if (wide && !tall) side = u < 0.5 ? "left" : "right";
  }
  return { side, pane: t.pane, rect: half(r, side, gap), ...MOVES[side] };
}

// "Top-left quarter", "Left half", or relative to the pane it lands beside.
export function zoneWords(z, area, lone, beside) {
  if (!z) return "";
  if (z.side === "tab") return "New tab";
  const r = z.rect;
  const halfW = Math.abs(r.w - area.w / 2) < area.w * 0.1, fullW = r.w > area.w * 0.9;
  const halfH = Math.abs(r.h - area.h / 2) < area.h * 0.1, fullH = r.h > area.h * 0.9;
  const lr = r.x + r.w / 2 < area.x + area.w / 2 ? "left" : "right";
  const tb = r.y + r.h / 2 < area.y + area.h / 2 ? "top" : "bottom";
  if (halfW && halfH) return `${tb[0].toUpperCase()}${tb.slice(1)}-${lr} quarter`;
  if (halfW && fullH) return `${lr[0].toUpperCase()}${lr.slice(1)} half`;
  if (fullW && halfH) return `${tb[0].toUpperCase()}${tb.slice(1)} half`;
  if (lone) return `${z.side[0].toUpperCase()}${z.side.slice(1)}`;
  const rel = { left: "Left of", right: "Right of", top: "Above", bottom: "Below" }[z.side];
  return `${rel} ${beside}`;
}
