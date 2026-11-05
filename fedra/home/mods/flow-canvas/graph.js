// The Flow canvas's graph: what hangs under what, and where each node goes.
//
// Nodes (ids are stable across redraws, so positions can be kept per node):
//   space  "s:<space id>"            a project folder; a worktree space hangs under its repo's
//   agent  "a:<terminal address>"    an agent in a space, or an atc sub-agent under its starter
//   cc     "c:<agent>:<subagent id>" a Claude Code subagent (its Agent/Task tool)
//   more   "m:<agent>"               "+N more" when an agent has too many subagents to show
// Edges go from a node to each of its children (parent's right side to child's left side).
//
// Layout: a left-to-right tree. A node's column is its depth; leaves take rows in order and a
// parent sits centred on its children (a subtree takes the height it needs, so trees never
// overlap). It's laid out again on every redraw: nodes that come, go or grow (a prompt) move the
// rest. A node the person dragged keeps its spot; one that was never dragged sits where the tree
// puts it *relative to its parent* (so it follows its parent), then moves down past anything
// already there: auto nodes flow around dragged ones and never cover each other. A drop on top of
// another dragged node lands on the nearest free spot instead (freeSpot). While a node is being
// dragged, it and what follows it float over the rest, which doesn't move until the drop.

export const SIZE = { space: [248, 64], agent: [248, 62], cc: [232, 46], more: [128, 30] };
export const COL = 330; // world px from one column to the next
export const ROW_GAP = 16; // between siblings
export const TREE_GAP = 46; // between top-level trees
export const MAX_SUBS = 5; // subagent nodes per agent before "+N more"

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
const isPath = (s) => /^[~/]|^[A-Za-z]:\\/.test(s) || s.includes("@");

// What an agent's session is about: the title it set, else a tab someone named, else the program.
export function agentTitle(a) {
  const live = clean(a.title);
  const prog = a.program?.name;
  if (live && live !== prog && live.toLowerCase() !== a.program?.key && !isPath(live)) return live;
  const tab = a.tab_name;
  if (tab && !/^\d+$/.test(tab) && tab !== prog) return tab;
  return prog || a.address;
}

// A terminal's status word and message; terminals() may carry the word or the core's { state, msg }.
export const stateOf = (term) => (typeof term?.status === "string" ? term.status : term?.status?.state ?? null);
export const msgOf = (term) => term?.report?.msg ?? (typeof term?.status === "object" ? term?.status?.msg : term?.msg) ?? null;

// Where a space is now: its first terminal's live folder, else where it was made.
export function placeOf(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
export const whereKey = (s, ps) => JSON.stringify([s.machine ?? null, placeOf(s, ps)]);

/**
 * The graph as a forest.
 *   sp, ag, terms (Map address -> terminal), ps: live data
 *   git: whereKey -> { common, top, linked } | null (null or missing: not a repo / not known yet)
 *   ccOf(agent) -> Claude Code subagents to show (subagents.js shown())
 *   extra: test-only synthetic agents [{ space, ...AgentInfo }]
 *   starting: agents with no OSC 7501 report [{ term, known, status }] (trust.js): starting, or
 *     never reporting (OpenCode), their status read from their screen
 * Returns { roots, nodes: Map id -> node, order: agent addresses in tree order }.
 */
export function build({ sp, ag, terms, ps, git, ccOf, extra = [], open = new Set(), starting = [] }) {
  const nodes = new Map();
  const add = (n) => { nodes.set(n.id, n); n.children = []; return n; };
  const all = [...ag, ...extra];
  const listed = new Set(all.map((a) => a.address));
  // An agent another listed agent started (an atc sub-agent) hangs under its starter, not its space.
  const starter = (addr) => {
    const p = terms.get(addr)?.parent;
    return p && p !== addr && (listed.has(p) || terms.get(p)) ? p : null;
  };

  // Spaces, worktrees under the space of their repo's main checkout.
  const info = sp.map((s) => ({ s, g: git[whereKey(s, ps)] ?? null }));
  const mains = new Map();
  for (const { s, g } of info) if (g && !g.linked && !mains.has(g.common)) mains.set(g.common, s.id);
  for (const { s, g } of info) {
    const n = add({ id: `s:${s.id}`, kind: "space", s, git: g, worktree: Boolean(g?.linked) });
    n.parentId = g?.linked && mains.has(g.common) && mains.get(g.common) !== s.id ? `s:${mains.get(g.common)}` : null;
  }

  // Agents (and atc sub-agents) under their space or starter.
  const agentNode = (a, parentId) => {
    const n = add({ id: `a:${a.address}`, kind: "agent", a, term: terms.get(a.address) ?? null, parentId });
    return n;
  };
  for (const a of all) {
    if (starter(a.address)) continue;
    if (!nodes.has(`s:${a.space}`)) continue;
    agentNode(a, `s:${a.space}`);
  }
  // No report (at its trust prompt, still loading, or a program that never reports): shown at once,
  // as its program.
  for (const { term, known, status } of starting) {
    const space = term.labels?.["atrous.space"];
    if (!nodes.has(`s:${space}`) || nodes.has(`a:${term.address}`) || listed.has(term.address)) continue;
    add({
      id: `a:${term.address}`, kind: "agent", unreported: true, starting: status === "starting", term, parentId: `s:${space}`,
      a: { address: term.address, status, app: known.key, program: known, title: known.name, tab_name: "", space, tab: term.labels?.["atrous.tab"] ?? null },
    });
  }
  // atc sub-agents: live terminals whose parent is an agent on the canvas (listed in agents() or not).
  const subTree = (addr, depth) => {
    if (depth > 4) return;
    for (const k of terms.values()) {
      if (k.parent !== addr || k.state !== "live" || k.address === addr) continue;
      const id = `a:${k.address}`;
      if (nodes.has(id)) continue;
      const listedAs = all.find((x) => x.address === k.address);
      const raw = listedAs?.status ?? stateOf(k);
      const status = raw === "error" ? "blocked" : raw === "done" ? "idle" : raw ?? "idle";
      const a = listedAs ?? {
        address: k.address, status, app: k.report?.app ?? null, program: k.program,
        title: k.name || k.template || clean(k.title) || k.program?.name || k.address, space: null, tab_name: "",
      };
      add({ id, kind: "agent", sub: true, a: { ...a, status }, term: k, parentId: `a:${addr}` });
      subTree(k.address, depth + 1);
    }
  };
  for (const n of [...nodes.values()]) if (n.kind === "agent") subTree(n.a.address, 1);

  // Claude Code subagents under their agent: running ones first; more than MAX_SUBS fold.
  for (const n of [...nodes.values()]) {
    if (n.kind !== "agent" || n.sub) continue;
    let list = ccOf(n.a) ?? [];
    if (!list.length) continue;
    list = [...list.filter((s) => s.state === "running"), ...list.filter((s) => s.state !== "running")];
    const hidden = open.has(n.a.address) ? 0 : Math.max(0, list.length - MAX_SUBS);
    for (const s of hidden ? list.slice(0, MAX_SUBS) : list) add({ id: `c:${n.a.address}:${s.id}`, kind: "cc", sub: s, agent: n.a, parentId: n.id });
    if (hidden) add({ id: `m:${n.a.address}`, kind: "more", n: hidden, agent: n.a, parentId: n.id });
  }

  // Children in order: a space's agents, then its worktrees; an agent's subagents, then atc ones.
  const roots = [];
  const rank = (c) => (c.kind === "cc" ? 0 : c.kind === "more" ? 1 : c.kind === "agent" ? 2 : 3);
  for (const n of nodes.values()) {
    const p = n.parentId && nodes.get(n.parentId);
    if (p) p.children.push(n);
    else { n.parentId = null; roots.push(n); }
  }
  for (const n of nodes.values()) {
    if (n.kind === "space") n.children.sort((x, y) => (x.kind === "space") - (y.kind === "space"));
    else n.children.sort((x, y) => rank(x) - rank(y));
  }
  const order = [];
  const walk = (n) => { if (n.kind === "agent") order.push(n.a.address); n.children.forEach(walk); };
  roots.forEach(walk);
  for (const n of nodes.values()) [n.w, n.h] = SIZE[n.kind];
  return { roots, nodes, order };
}

/** Tidy left-to-right tree positions (world px) for every node: Map id -> { x, y }. */
export function autoLayout(roots) {
  const at = new Map();
  const place = (n, depth, y0) => {
    const x = depth * COL;
    if (!n.children.length) {
      at.set(n.id, { x, y: y0 });
      return y0 + n.h + ROW_GAP;
    }
    let y = y0;
    for (const c of n.children) y = place(c, depth + 1, y);
    const first = at.get(n.children[0].id), last = at.get(n.children[n.children.length - 1].id);
    const mid = (first.y + n.children[0].h / 2 + last.y + n.children[n.children.length - 1].h / 2) / 2;
    let top = mid - n.h / 2;
    if (top < y0) {
      // Taller than its children's span: push the subtree down so the parent fits.
      const d = y0 - top;
      const shift = (m) => { const p = at.get(m.id); p.y += d; m.children.forEach(shift); };
      n.children.forEach(shift);
      top = y0;
      y += d;
    }
    at.set(n.id, { x, y: top });
    return Math.max(y, top + n.h + ROW_GAP);
  };
  let y = 0;
  for (const r of roots) y = place(r, 0, y) + TREE_GAP - ROW_GAP;
  return at;
}

/**
 * Final positions: a dragged node keeps its saved spot; any other sits at its tree offset from
 * its parent's final spot (a root: at its tree spot). Mutates nodes (x, y).
 */
// The closest two cards may come (siblings sit ROW_GAP apart, columns COL - width apart).
const GAP_X = 14, GAP_Y = ROW_GAP / 2;
const hit = (a, b) => a.x < b.x + b.w + GAP_X && b.x < a.x + a.w + GAP_X && a.y < b.y + b.h + GAP_Y && b.y < a.y + a.h + GAP_Y;

// Moves n down until it covers none of `placed` (y only grows, so at most one step per node).
function settle(n, placed) {
  for (let i = 0; i <= placed.length; i++) {
    const b = placed.find((p) => hit(n, p));
    if (!b) return;
    n.y = b.y + b.h + ROW_GAP;
  }
}

/**
 * Where every node goes: x, y on each node. auto: autoLayout's; saved: node id -> { x, y } the
 * person dragged it to; drag: { id, x, y } of the node being dragged now, if any.
 */
export function resolve(roots, auto, saved, drag) {
  const order = []; // parents before children, trees in order
  const walk = (n, parent, floating) => {
    const f = floating || drag?.id === n.id;
    order.push({ n, parent, floating: f });
    n.children.forEach((c) => walk(c, n, f));
  };
  roots.forEach((r) => walk(r, null, false));
  const own = (n) => (drag?.id === n.id ? drag : saved[n.id]);
  const placed = [];
  // Dragged spots first, as dropped (one left on another, from before drops found free spots, moves down).
  for (const { n } of order) {
    const o = own(n);
    if (!o) continue;
    n.x = o.x;
    n.y = o.y;
    if (drag?.id === n.id) continue;
    settle(n, placed);
    placed.push(n);
  }
  // Then the tree, each node relative to where its parent ended up, down past what's there.
  for (const { n, parent, floating } of order) {
    if (own(n)) continue;
    const a = auto.get(n.id);
    if (parent) { const pa = auto.get(parent.id); n.x = parent.x + (a.x - pa.x); n.y = parent.y + (a.y - pa.y); }
    else { n.x = a.x; n.y = a.y; }
    if (floating) continue; // follows the node being dragged, over the rest
    settle(n, placed);
    placed.push(n);
  }
}

/**
 * Where a node dropped at (x, y) lands: there, unless it would cover one of `others` (nodes with
 * spots the person chose); then the nearest spot that covers none, looked for in rings 8 px apart.
 */
export function freeSpot(n, x, y, others) {
  const probe = { x, y, w: n.w, h: n.h };
  const free = () => !others.some((o) => hit(probe, o));
  if (free()) return { x, y };
  for (let r = 8; r <= 1200; r += 8) {
    const ring = [];
    for (let d = -r; d <= r; d += 8) ring.push([d, -r], [d, r], [-r, d], [r, d]);
    ring.sort((p, q) => p[0] * p[0] + p[1] * p[1] - (q[0] * q[0] + q[1] * q[1]));
    for (const [dx, dy] of ring) {
      probe.x = x + dx;
      probe.y = y + dy;
      if (free()) return { x: probe.x, y: probe.y };
    }
  }
  return { x, y };
}

/** Any two nodes that cover each other (for tests): [[id, id], ...]. */
export function overlaps(nodes) {
  const list = [...nodes];
  const out = [];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j];
    if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) out.push([a.id, b.id]);
  }
  return out;
}

/** The world box around every node, or null. */
export function bounds(nodes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes.values()) {
    x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
    x1 = Math.max(x1, n.x + n.w + (n.kind === "space" ? 44 : 0)); y1 = Math.max(y1, n.y + n.h);
  }
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** A node's status for its mark and its incoming edge: working | blocked | done | idle | null. */
export function statusOf(n) {
  if (n.prompt) return "blocked"; // asking something (a trust prompt): needs you
  if (n.kind === "agent") return n.a.status ?? "idle";
  if (n.kind === "cc") return n.sub.state === "running" ? "working" : n.sub.state === "done" ? "done" : "idle";
  if (n.kind === "space") return null;
  return "idle";
}

/** Points along a cubic bezier, `step` px apart (screen space), for the running-edge dots. */
export function along(p0, c1, c2, p1, step) {
  const N = 40;
  const pts = [];
  let prev = p0, acc = 0, next = step * 0.9; // not at the very start: fanned-out edges share it
  for (let i = 1; i <= N; i++) {
    const t = i / N, u = 1 - t;
    const x = u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p1[0];
    const y = u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p1[1];
    const d = Math.hypot(x - prev[0], y - prev[1]);
    while (acc + d >= next) {
      const f = (next - acc) / d;
      pts.push([prev[0] + (x - prev[0]) * f, prev[1] + (y - prev[1]) * f]);
      next += step;
    }
    acc += d;
    prev = [x, y];
  }
  return pts;
}

/** The control points of an n8n-like edge from an output port to an input port. */
export function curve(x0, y0, x1, y1, z) {
  const dx = x1 - x0;
  const k = Math.max(Math.abs(dx) * 0.5, 60 * z);
  return [[x0, y0], [x0 + k, y0], [x1 - k, y1], [x1, y1]];
}
