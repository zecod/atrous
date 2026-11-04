// smart split: a press that turns into a drag hands one terminal to the snap-split
// overlay (mods/snap-split takes the pointer from there and shows where it lands).
// The same file sits in each mod that starts such drags (my-tabs, my-pane): a mod
// can't import from another mod's folder.

import { openOverlay, panes } from "herdr";

// The terminal a tab stands for: its agent, else its focused pane, else its first.
export function tabTerminal(tabId) {
  const mine = panes().filter((p) => p.tab === tabId && p.terminal);
  return (mine.find((p) => p.program?.agent || p.status) ?? mine.find((p) => p.focused) ?? mine[0])?.terminal ?? null;
}

// Arms a drag of `terminal` from a press. `down`: only a move that far below the press
// starts it (a tab pill: sideways stays a reorder); else any move past `slop` px.
export function armDrag(view, terminal, e, opts = {}) {
  view.dragOut = terminal && e?.position ? { terminal, x: e.position.x, y: e.position.y, ...opts } : null;
}

// A move over the element that armed it. True when the drag started.
export function dragMove(view, e) {
  const d = view.dragOut;
  if (!d || !e?.position) return false;
  const dx = e.position.x - d.x, dy = e.position.y - d.y;
  if (d.down != null ? dy < d.down : Math.hypot(dx, dy) < (d.slop ?? 6)) return false;
  start(view, e.position);
  return true;
}

// The pointer left that element with the button still down: the drag starts there.
export function dragLeft(view) {
  if (!view.dragOut) return false;
  start(view, null);
  return true;
}

export function disarm(view) {
  view.dragOut = null;
}

function start(view, at) {
  const d = view.dragOut;
  view.dragOut = null;
  const p = at ?? d;
  openOverlay({
    mod: "snap-split",
    kind: "window",
    frame: "none",
    width: 1,
    height: 1,
    at: { x: 0, y: 0 },
    props: { terminal: d.terminal, x: p.x, y: p.y, t: Date.now(), from: d.from ?? null },
  });
}
