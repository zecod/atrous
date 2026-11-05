// smart split: dragging an agent out of this list onto the shown tab.
// A press on an agent row (or a rail tile) arms it. Once the pointer has moved a
// few px with the button still down, or left the list, the `snap-split` mod opens
// as a frameless overlay over the whole window and takes the drag from there:
// it draws the zones and does the move (mods/snap-split/main.js). A press that
// ends where it began stays a click, so rows still focus their agent.
// (Its own file because a mod can't import from another mod's folder.)

import { openOverlay } from "atrous";

const SLOP = 6; // px of travel before a press counts as a drag

export function smartPress(view, terminal, e) {
  view.smartSplit = terminal && e?.position ? { terminal, x: e.position.x, y: e.position.y } : null;
}

// From the list's mouse move, or with no event when the pointer left the list.
export function smartMove(view, e) {
  const d = view.smartSplit;
  if (!d) return;
  const p = e?.position ?? null;
  if (p && Math.hypot(p.x - d.x, p.y - d.y) < SLOP) return;
  view.smartSplit = null;
  const at = p ?? d;
  openOverlay({
    mod: "snap-split",
    kind: "window",
    frame: "none",
    width: 1,
    height: 1,
    at: { x: 0, y: 0 },
    props: { terminal: d.terminal, x: at.x, y: at.y, t: Date.now() },
  });
}

export function smartRelease(view) {
  view.smartSplit = null;
}
