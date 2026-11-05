// Flow: your work as a node canvas, like n8n's workflow editor. Projects (spaces) on the left,
// their agents to the right, each agent's subagents further right, joined by curved edges.
// A running agent's incoming edge carries moving dots, the way n8n shows a running execution.
//
// One mod, four parts (props.part):
//   (none)     the canvas (the Flow layout's main block)
//   "bar"      the slim title bar: logo, Fedra | Flow switch, counts, search, settings, window buttons
//   "terminal" the header over the focused agent's live terminal (layout block { agent: "focused" })
//   "add"      the popup a space's "+" node opens: start an agent there (knownAgents -> tab.new)
//
// The canvas
// - Pan: drag the background (or anywhere with the middle button), or the wheel (shift+wheel:
//   sideways). Zoom: ctrl+wheel (around the pointer) or the buttons at the bottom left (fit, in,
//   out, 100 %, tidy up). Until you pan or zoom, the view keeps fitting what's there.
// - Nodes: click an agent to show it in the terminal panel (double-click: type into it), drag to move
//   (saved per node in localStorage), right-click for the agent menu (mods/agent-menu) or the space
//   menu (mods/my-menu). A node never dragged sits where the left-to-right tree puts it, relative to
//   its parent, so it follows its parent. "Tidy up" forgets every dragged spot.
// - Status: working = spinner + a beam running round the card + dots flowing along the edge into it;
//   needs you = pulsing dot; done = check; idle = grey dot.
//
// How it draws (gpui-kit has no transforms, so zoom is done here: every size is multiplied by z)
// - Grid: one stroked path, one dashed line per row ([dot, gap] dashes = a row of dots); edges: one
//   path per style (window.paint_path, cubic beziers). Rebuilt each render; nothing per frame.
// - Motion is all `spin`, which the app paints on its own layer: turning it never lays the canvas out
//   again (frames and loop wake the whole view they're in, ~12 and ~30 times a second, and here
//   that meant re-laying out every node: 7 ms a frame instead of 1.5). An edge dot is a few-px
//   window (overflow_hidden) at the rim of a spinning wedge (flow-wedge.svg); successive dots sit
//   at successive angles, so they light in turn: a flow along any curve. The needs-you pulse is a
//   window on a spinning disc whose brightness rises and falls round it (flow-pulse.svg). Spins
//   paint above the rest of the view, so dots skip the corner controls. Spinners and beams are spins
//   too. No timers drive any animation.
//
// Cost
// - Renders only on live data, a drag/pan/zoom step or a subagent change. Nodes off screen are skipped.
// - Claude Code subagents as in my-spaces: sessions found by reading folders (session.js), changes by
//   watchFolder (subagents.js reads only changed transcripts, at most every 2 s). The 4 s folder scan
//   and the minute tick of running times stop while the window isn't in front.
// - Worktrees: `git rev-parse` once per place (a space's folder); never polled.
// Test commands (keys.json or `atrous do flow-canvas.<cmd>`): fit, zoom-in, zoom-out, zoom-reset,
// tidy, zoom:<z>, pan:<dx>,<dy>, wheel:<dx>,<dy>,<ctrl 0|1>,<x>,<y>, drag:<node id>,<dx>,<dy>,
// click:<node id>, menu:<node id> (its right-click menu), stress:<n> (n synthetic agents, not
// saved), stats (render times -> shared "flow.stats"), active:1|0|auto (treat the window as in
// front or not, for screenshots of a window kept in the back), off:<grid,edges,anim,nodes> (leave
// parts out, to measure them), subagents-test:<session dir> | subagents-test-off (my-spaces' switch:
// every Claude agent shows that session's subagents).

import { View, div, svg, image, PathBuilder } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  spaces, agents, terminals, panes, focused, theme, run, openOverlay, closeOverlay, props, shared, setShared,
  nextCommand, exec, layout, knownAgents, setAgentOrder, watchFolder, window as appWindow,
} from "atrous";
import * as G from "./graph.js";
import * as SA from "./subagents.js";
import { claudeSessionDir } from "./session.js";

const I = (n) => `mods/flow-canvas/${n}.svg`;
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
const GRID = 24; // world px between grid dots
const ZMIN = 0.2, ZMAX = 1.8;
const WORD = { working: "Working", blocked: "Needs you", done: "Done", idle: "Idle" };
const FLOW_K = 7; // edge dots per turn of the wedge: the gap between two lit runs
const FLOW_MS = 1100; // one turn
const DOTS = 120; // edge dots on screen, at most

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

/** `#rrggbb` (or #rgb / #rrggbbaa) with alpha a (0..1). */
function alpha(c, a) {
  if (typeof c !== "string" || c[0] !== "#") return c;
  let h = c.slice(1);
  if (h.length <= 4) h = [...h.slice(0, 3)].map((x) => x + x).join("");
  return `#${h.slice(0, 6)}${Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, "0")}`;
}

function programIcon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const stop = (_e, cx) => cx.stop_propagation();
const panelShown = () => { const n = find(layout(), "flow-terminal"); return Boolean(n) && !n.hidden; };

// One lit dot of a running edge, centred on (x, y): a w-px window at angle th on the rim of a
// spinning wedge. The wedge's bright edge passes th at th / 2pi of a turn.
function flowDot(x, y, th, w, color) {
  const r = w * 2.2, d = Math.ceil(2 * (r + w)) + 2;
  const cx = x - r * Math.cos(th), cy = y - r * Math.sin(th);
  return div().absolute().left(x - w / 2).top(y - w / 2).size(w).overflow_hidden()
    .child(svg(I("flow-wedge")).absolute().size(d).left(cx - d / 2 - (x - w / 2)).top(cy - d / 2 - (y - w / 2)).text_color(color).spin(FLOW_MS));
}

// The needs-you pulse: a w-px dot whose brightness rises and falls (windows far out on a spinning
// disc). Spins paint above everything in the view, so nothing can mask them round: the dot is three
// overlapping windows (two bars and a square), an octagon that reads as a round dot.
function pulseDot(w, color) {
  const r = w * 2.6, d = Math.ceil(2 * (r + w)) + 2;
  const win = (x, y, ww, hh) => div().absolute().left(x).top(y).w(ww).h(hh).overflow_hidden()
    .child(svg(I("flow-pulse")).absolute().size(d).left(w / 2 - r - d / 2 - x).top(w / 2 - d / 2 - y).text_color(color).spin(1100));
  const a = w * 0.56, b = w * 0.84;
  return div().relative().size(w).flex_none()
    .child(win(0, (w - a) / 2, w, a))
    .child(win((w - a) / 2, 0, a, w))
    .child(win((w - b) / 2, (w - b) / 2, b, b));
}

// ---- the mod ---------------------------------------------------------------------------------------

export default class Flow extends View {
  init(_props, cx) {
    this.part = props()?.part ?? "canvas";
    if (this.part === "add") return this.initAdd(cx);
    if (this.part !== "canvas") return;
    this.size = null;
    this.view = this.load("view", null); // { z, x, y }: screen = world * z + (x, y)
    // Until the person pans or zooms, the view fits whatever is there (new agents included).
    this.touched = this.load("touched", false);
    this.pos = this.load("pos", {}); // node id -> { x, y, at }: spots the person dragged nodes to
    this.git = {}; // whereKey -> { common, top, linked } | null
    this.gitBusy = new Set();
    this.press = null; // a press on a node or the background, until release
    this.drag = null; // { id, x, y } while a node is dragged
    this.extra = []; // stress test: synthetic agents
    this.subsOpen = new Set(); // agents whose subagents are all shown
    this.times = []; // render ms, for `stats`
    this.subDirs = new Map(); // agent address -> { dir, pid, at }
    this.subWatching = new Set();
    this.subDirty = new Map();
    this.active = appWindow()?.active !== false;
    // Folders only (no process) every 4 s, and only while the window is in front.
    cx.timer.every(4000, (cx) => { if (appWindow()?.active !== false) this.subScan(cx); });
    this.subScan(cx);
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        try { this.command(c, cx); } catch (e) { console.log(`flow-canvas: ${c}: ${e?.message ?? e}`); }
        cx.notify();
      }
    });
  }

  load(k, d) { try { return JSON.parse(localStorage.getItem(k) ?? "null") ?? d; } catch { return d; } }
  save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

  render(cx) {
    if (this.part === "bar") return this.renderBar();
    if (this.part === "terminal") return this.renderTerminalHeader();
    if (this.part === "add") return this.renderAdd();
    const t0 = Date.now();
    const el = this.renderCanvas(cx);
    this.times.push(Date.now() - t0);
    if (this.times.length > 200) this.times.shift();
    return el;
  }

  // ---- data ----------------------------------------------------------------------------------------

  // A place's repo, asked once (a worktree hangs under its repo's space). Never polled.
  askGit(sp, ps, cx) {
    for (const s of sp) {
      const key = G.whereKey(s, ps);
      if (key in this.git || this.gitBusy.has(key)) continue;
      const [on, cwd] = JSON.parse(key);
      if (!cwd) { this.git[key] = null; continue; }
      this.gitBusy.add(key);
      cx.spawn(async (cx) => {
        let info = null;
        try {
          const r = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"], { cwd, on });
          if (r.code === 0) {
            const [common, top] = r.stdout.split(/\r?\n/).map((x) => x.trim());
            if (common && top) info = { common, top, linked: common !== `${top}/.git` };
          }
        } catch {}
        this.git[key] = info;
        this.gitBusy.delete(key);
        if (info) cx.notify();
      });
    }
  }

  ccOf(a) {
    const dir = this.subDirs.get(a.address)?.dir;
    return dir ? SA.shown(dir) : [];
  }

  // Claude Code subagents (copied from my-spaces): which session each Claude agent is in, by
  // reading folders; transcripts changes come through watchFolder (subWatch -> subFlush).
  subScan(cx) {
    if (this.subBusy) { this.subAgain = true; return; }
    this.subBusy = true;
    this.subAgain = false;
    cx.spawn(async (cx) => {
      try {
        const now = Date.now();
        const live = new Set();
        const terms = new Map(terminals().map((k) => [k.address, k]));
        const test = shared("subagents.test"); // testing only: one session folder for every Claude agent
        for (const a of agents()) {
          const term = terms.get(a.address);
          if (!term || a.address.includes("/")) continue;
          live.add(a.address);
          const known = this.subDirs.get(a.address);
          const claude = `${a.app ?? ""} ${a.program?.key ?? ""}`.toLowerCase().includes("claude");
          if (typeof test === "string") this.subDirs.set(a.address, { dir: claude ? test : null, pid: term.pid, at: now });
          else if (!known || known.pid !== term.pid || now - known.at > 30000) {
            const dir = await claudeSessionDir(a, term).catch(() => null);
            this.subDirs.set(a.address, { dir, pid: term.pid, at: now });
          }
          const dir = this.subDirs.get(a.address)?.dir;
          if (!dir) continue;
          const { exists, fresh } = await SA.list(dir);
          if (exists) this.subWatch(dir, cx);
          if (fresh.length) await SA.refresh(dir, fresh);
        }
        for (const k of [...this.subDirs.keys()]) if (!live.has(k)) this.subDirs.delete(k);
      } finally {
        this.subBusy = false;
        const sig = this.subSignature();
        if (sig !== this.subSig) { this.subSig = sig; cx.notify(); }
        if (this.subAgain) this.subScan(cx);
      }
    });
  }

  // From render: after it (a redraw asked for during render is refused).
  scanSoon(cx) {
    cx.spawn(async (cx) => { await cx.sleep(0); this.subScan(cx); });
  }

  // What the subagent nodes show, minute-rounded: a change means a redraw.
  subSignature() {
    const now = Date.now();
    const out = [];
    for (const [addr, { dir }] of this.subDirs) {
      if (!dir) continue;
      for (const s of SA.shown(dir, now)) out.push([addr, s.id, s.state, SA.activityText(s), s.state === "running" && s.startAt ? Math.floor((now - s.startAt) / 60000) : 0]);
    }
    return JSON.stringify(out);
  }

  subWatch(dir, cx) {
    if (this.subWatching.has(dir)) return;
    this.subWatching.add(dir);
    cx.spawn(async (cx) => {
      try {
        for (;;) {
          const paths = await watchFolder(`${dir}/subagents`);
          if (![...this.subDirs.values()].some((d) => d.dir === dir)) break; // its agent is gone
          const set = this.subDirty.get(dir) ?? new Set();
          for (const p of paths ?? []) {
            const n = SA.norm(p);
            if (n.endsWith(".jsonl")) set.add(n);
            else if (n.endsWith(".meta.json")) set.add("*new");
            else set.add("*all");
          }
          this.subDirty.set(dir, set);
          if (!this.subFlushQueued) {
            this.subFlushQueued = true;
            cx.timer.after(2000, (cx) => this.subFlush(cx)); // at most one read every 2 s
          }
        }
      } catch {} finally {
        this.subWatching.delete(dir);
      }
    });
  }

  subFlush(cx) {
    this.subFlushQueued = false;
    const work = [...this.subDirty];
    this.subDirty.clear();
    cx.spawn(async (cx) => {
      let changed = false;
      for (const [dir, set] of work) {
        const { fresh } = await SA.list(dir);
        const files = set.has("*all") ? null : [...set].filter((f) => !f.startsWith("*")).concat(fresh);
        if (await SA.refresh(dir, files)) changed = true;
      }
      const sig = this.subSignature();
      if (changed || sig !== this.subSig) { this.subSig = sig; cx.notify(); }
    });
  }

  // ---- viewport ------------------------------------------------------------------------------------

  fit() {
    const b = this.graph && G.bounds(this.graph.nodes);
    const W = this.size?.width, H = this.size?.height;
    if (!b || !W || !H) { this.view = { z: 1, x: 48, y: 48 }; return; }
    const pad = 56;
    const z = clamp(Math.min((W - 2 * pad) / Math.max(1, b.w), (H - 2 * pad) / Math.max(1, b.h), 1.1), ZMIN, ZMAX);
    this.view = { z, x: (W - b.w * z) / 2 - b.x * z, y: (H - b.h * z) / 2 - b.y * z };
  }

  // The person moved the view (pan, zoom): stop fitting it to new nodes. Fit and tidy undo that.
  markTouched(on) {
    if (this.touched === on) return;
    this.touched = on;
    this.save("touched", on);
  }

  // Fit on the next render (it lays the graph out first), and keep fitting from then on.
  refit() {
    this.markTouched(false);
    this.fitSig = null;
  }

  tidy() {
    this.pos = {};
    this.save("pos", this.pos);
    this.refit();
  }

  zoomAt(z, p) {
    this.markTouched(true);
    const v = this.view ?? { z: 1, x: 0, y: 0 };
    z = clamp(z, ZMIN, ZMAX);
    const wx = (p.x - v.x) / v.z, wy = (p.y - v.y) / v.z;
    this.view = { z, x: p.x - wx * z, y: p.y - wy * z };
  }

  center() { return { x: (this.size?.width ?? 800) / 2, y: (this.size?.height ?? 600) / 2 }; }

  saveViewSoon(cx) {
    if (this.viewSaveQueued) return;
    this.viewSaveQueued = true;
    cx.timer.after(600, () => { this.viewSaveQueued = false; this.save("view", this.view); });
  }

  wheel(e, cx) {
    if (!this.view) return;
    const dx = e.delta?.x ?? 0, dy = e.delta?.y ?? 0;
    if (e.modifiers?.control || e.modifiers?.platform) this.zoomAt(this.view.z * Math.exp(dy * 0.0025), e.local_position ?? this.center());
    else if (e.modifiers?.shift && !dx) { this.markTouched(true); this.view = { ...this.view, x: this.view.x + dy }; }
    else { this.markTouched(true); this.view = { ...this.view, x: this.view.x + dx, y: this.view.y + dy }; }
    this.saveViewSoon(cx);
    cx.notify();
  }

  // ---- pointer: a press on a node or the background; moves drag it or pan; a still release clicks --

  pressNode(n, e) {
    this.press = { kind: "node", id: n.id, n, x: e.position.x, y: e.position.y, ox: n.x, oy: n.y, moved: false, dbl: (e.click_count ?? 1) >= 2 };
  }

  pressBackground(e) {
    if (!this.view) return;
    this.press = { kind: "pan", x: e.position.x, y: e.position.y, vx: this.view.x, vy: this.view.y, moved: false };
  }

  move(e, cx) {
    const p = this.press;
    if (!p || !e?.position) return;
    const dx = e.position.x - p.x, dy = e.position.y - p.y;
    if (!p.moved && Math.hypot(dx, dy) < 4) return;
    p.moved = true;
    if (p.kind === "node") {
      if (p.n.kind === "add" || p.n.kind === "more") return;
      const z = this.view?.z ?? 1;
      this.drag = { id: p.id, x: p.ox + dx / z, y: p.oy + dy / z };
    } else this.view = { ...this.view, x: p.vx + dx, y: p.vy + dy };
    cx.notify();
  }

  release(cx) {
    const p = this.press;
    this.press = null;
    if (!p) return;
    if (p.kind === "node") {
      if (p.moved && this.drag) {
        this.pos[p.id] = { x: Math.round(this.drag.x), y: Math.round(this.drag.y), at: Date.now() };
        const ids = Object.keys(this.pos);
        if (ids.length > 400) for (const id of ids.sort((a, b) => this.pos[a].at - this.pos[b].at).slice(0, ids.length - 400)) delete this.pos[id];
        this.save("pos", this.pos);
      } else if (!p.moved) this.clickNode(p.n, p.dbl, cx);
      this.drag = null;
    } else if (p.moved) { this.markTouched(true); this.save("view", this.view); }
    cx.notify();
  }

  clickNode(n, dbl, cx) {
    if (n.kind === "agent") {
      if (n.synthetic) return;
      run("agent.focus", { terminal: n.a.address });
      if (!panelShown()) run("layout.show", { id: "flow-terminal" });
      // Double-click: the keyboard goes to its terminal in the panel.
      if (dbl) run("pane.focus", { terminal: n.a.address });
    } else if (n.kind === "cc") {
      run("agent.focus", { terminal: n.agent.address });
      if (!panelShown()) run("layout.show", { id: "flow-terminal" });
    } else if (n.kind === "more") {
      this.subsOpen.add(n.agent.address);
    } else if (n.kind === "space") {
      run("space.select", { id: n.s.id });
    } else if (n.kind === "add") {
      this.openAdd(n.s);
    }
  }

  menuFor(n) {
    if (n.kind === "space") {
      openOverlay({ mod: "my-menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: n.s.id } } });
    } else if (n.kind === "agent" && !n.synthetic) {
      const a = n.a;
      const title = G.agentTitle(a);
      const cwd = (a.pane && panes().find((p) => p.pane === a.pane)?.cwd) || n.term?.cwd || null;
      const dir = this.subDirs.get(a.address)?.dir;
      openOverlay({ mod: "agent-menu", kind: "popup", width: 236, height: 300,
        props: { address: a.address, title, program: a.program?.name, pane: a.pane ?? null, pinned: Boolean(a.pinned), cwd,
          sessionId: dir ? dir.split("/").pop() : null, source: dir ? "claude" : null } });
    }
  }

  openAdd(s) {
    openOverlay({ mod: "flow-canvas", kind: "popup", width: 250, height: 330, props: { part: "add", space: s.id, machine: s.machine ?? null } });
  }

  // ---- test commands -----------------------------------------------------------------------------

  command(c, cx) {
    const i = c.indexOf(":");
    const name = i < 0 ? c : c.slice(0, i), arg = i < 0 ? "" : c.slice(i + 1);
    const num = (s) => Number(s) || 0;
    const fake = (x, y, n = 1) => ({ position: { x, y }, click_count: n });
    if (name === "fit") this.refit();
    else if (name === "zoom-in") this.zoomAt((this.view?.z ?? 1) * 1.2, this.center());
    else if (name === "zoom-out") this.zoomAt((this.view?.z ?? 1) / 1.2, this.center());
    else if (name === "zoom-reset") this.zoomAt(1, this.center());
    else if (name === "zoom") this.zoomAt(num(arg), this.center());
    else if (name === "tidy") this.tidy();
    else if (name === "pan") { const [dx, dy] = arg.split(",").map(num); this.markTouched(true); this.view = { ...this.view, x: this.view.x + dx, y: this.view.y + dy }; }
    else if (name === "wheel") {
      const [dx, dy, ctrl, x, y] = arg.split(",").map(num);
      this.wheel({ delta: { x: dx, y: dy }, modifiers: { control: ctrl === 1 }, local_position: { x, y } }, cx);
    } else if (name === "drag" || name === "click") {
      const [id, dx, dy] = arg.split(",");
      const n = this.graph?.nodes.get(id);
      if (!n) return console.log(`flow-canvas: no node ${id}`);
      if (n.kind === "space" && name === "drag") this.press = null;
      this.pressNode(n, fake(100, 100, name === "click" && dy === "2" ? 2 : 1));
      if (name === "drag") {
        this.move(fake(100 + num(dx) / 2, 100 + num(dy) / 2), cx);
        this.move(fake(100 + num(dx), 100 + num(dy)), cx);
      }
      this.release(cx);
    } else if (name === "off") { this.off = new Set(arg.split(",").filter(Boolean)); // perf experiments: grid,edges,nodes,anim
    } else if (name === "menu") {
      const n = this.graph?.nodes.get(arg);
      if (n) this.menuFor(n);
    } else if (name === "stress") {
      const sp = spaces();
      const progs = agents().map((a) => a.program).filter(Boolean);
      const st = ["working", "idle", "done", "blocked", "working"];
      this.extra = sp.length ? Array.from({ length: num(arg) }, (_, k) => ({
        address: `x${k}`, space: sp[k % sp.length].id, status: st[k % st.length], app: "claude-code",
        program: progs[k % Math.max(1, progs.length)] ?? null, title: `Synthetic agent ${k + 1}`, tab_name: "", synthetic: true,
      })) : [];
    } else if (name === "stats") {
      const a = [...this.times].sort((x, y) => x - y);
      const avg = a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
      const stats = { renders: a.length, avg: Math.round(avg * 10) / 10, p50: a[Math.floor(a.length / 2)] ?? 0, p95: a[Math.floor(a.length * 0.95)] ?? 0, max: a[a.length - 1] ?? 0,
        nodes: this.graph?.nodes.size ?? 0, drawn: this.drawn ?? 0, dots: this.dotCount ?? 0, view: this.view, at: Date.now() };
      setShared("flow.stats", stats);
      console.log(`flow-canvas stats ${JSON.stringify(stats)}`);
      this.times = [];
    } else if (name === "active") this.forceActive = arg === "1" ? true : arg === "0" ? false : undefined; // screenshots of a window in the back
    else if (name === "subagents-test") setShared("subagents.test", arg);
    else if (name === "subagents-test-off") setShared("subagents.test", null);
  }

  // ---- the canvas ----------------------------------------------------------------------------------

  renderCanvas(cx) {
    const t = theme();
    const active = this.forceActive ?? (appWindow()?.active !== false);
    if (active && this.active === false) this.scanSoon(cx); // back in front: catch up
    this.active = active;
    const sp = spaces(), ag = agents(), ps = panes();
    const terms = new Map(terminals().map((k) => [k.address, k]));
    this.askGit(sp, ps, cx);
    const graph = G.build({ sp, ag, terms, ps, git: this.git, ccOf: (a) => this.ccOf(a), extra: this.extra, open: this.subsOpen });
    // The "+" node at the end of each space: start an agent there (n8n's add-node).
    for (const n of [...graph.nodes.values()]) {
      if (n.kind !== "space") continue;
      const add = { id: `+:${n.s.id}`, kind: "add", s: n.s, parentId: n.id, children: [], w: 40, h: 40 };
      graph.nodes.set(add.id, add);
      const at = n.children.findIndex((c) => c.kind === "space");
      n.children.splice(at < 0 ? n.children.length : at, 0, add);
    }
    for (const a of this.extra) { const n = graph.nodes.get(`a:${a.address}`); if (n) n.synthetic = true; }
    setAgentOrder(graph.order.filter((a) => !a.startsWith("x")));
    const auto = G.autoLayout(graph.roots);
    G.resolve(graph.roots, auto, this.pos, this.drag);
    this.graph = graph;

    const W = this.size?.width ?? 0, H = this.size?.height ?? 0;
    // Fit again when nodes come or go or the canvas resizes, never because one was dragged.
    if (W > 0 && !this.press && (!this.view || !this.touched)) {
      const fitSig = `${Math.round(W)}x${Math.round(H)} ${[...graph.nodes.keys()].join(" ")}`;
      if (!this.view || fitSig !== this.fitSig) { this.fitSig = fitSig; this.fit(); }
    }
    // A Claude agent came or went (or restarted): look for its session now, window in front or not.
    const claudeSig = ag.filter((a) => `${a.app ?? ""} ${a.program?.key ?? ""}`.toLowerCase().includes("claude")).map((a) => `${a.address}:${terms.get(a.address)?.pid ?? ""}`).join(",");
    if (claudeSig !== this.claudeSig) { this.claudeSig = claudeSig; this.scanSoon(cx); }
    const v = this.view ?? { z: 1, x: 48, y: 48 };
    const z = v.z;
    const sx = (x) => x * z + v.x, sy = (y) => y * z + v.y;
    const shownAgent = focused()?.agent ?? null;

    // Edges, grouped by look: one path per group.
    const groups = { idle: [], done: [], work: [], block: [], link: [], add: [] };
    const dots = [], work = [];
    const STEP = clamp(14 * z, 9, 17);
    const dotW = clamp(7.5 * z, 4, 9);
    // Spins paint above the whole view: keep dots off the corner controls.
    const clear = (q) => !((q[0] < 250 && q[1] > H - 58) || (q[0] > W - 210 && q[1] < 56));
    const inView = (x0, y0, x1, y1) => Math.max(x0, x1) > -40 && Math.min(x0, x1) < W + 40 && Math.max(y0, y1) > -40 && Math.min(y0, y1) < H + 40;
    for (const n of graph.nodes.values()) {
      const p = n.parentId && graph.nodes.get(n.parentId);
      if (!p) continue;
      const x0 = sx(p.x + p.w), y0 = sy(p.y + p.h / 2), x1 = sx(n.x), y1 = sy(n.y + n.h / 2);
      const c = G.curve(x0, y0, x1, y1, z);
      if (!inView(Math.min(x0, c[1][0], c[2][0], x1), Math.min(y0, y1), Math.max(x0, c[1][0], c[2][0], x1), Math.max(y0, y1))) continue;
      const st = G.statusOf(n);
      const g = n.kind === "add" ? "add" : n.kind === "space" ? "link" : st === "working" ? "work" : st === "blocked" ? "block" : st === "done" ? "done" : "idle";
      groups[g].push(c);
      if (g === "work" && z >= 0.3) work.push([c, x0, x1]);
    }
    // Dots between the ports, lit in turn from parent to child; at most DOTS on screen (each is two
    // elements and a spin): with many running edges they space out.
    const place = (step) => work.map(([c, x0, x1]) => G.along(c[0], c[1], c[2], c[3], step)
      .filter((q) => (q[0] > x0 + 3 && q[0] < x1 - 3) || Math.abs(x1 - x0) < 12));
    let runs = place(STEP);
    const count = runs.reduce((k, r) => k + r.length, 0);
    if (count > DOTS) runs = place(STEP * (count / DOTS));
    for (const pts of runs) pts.forEach((q, i) => { if (clear(q)) dots.push(flowDot(q[0], q[1], ((i % FLOW_K) / FLOW_K) * 2 * Math.PI, dotW, t.working)); });
    this.dotCount = dots.length;

    // Nodes on screen.
    const nodes = [];
    for (const n of graph.nodes.values()) {
      const x = sx(n.x), y = sy(n.y), w = n.w * z, h = n.h * z;
      if (x > W + 60 || y > H + 60 || x + w < -60 || y + h < -60) continue;
      nodes.push(this.node(t, n, { x, y, w, h, z, active, on: n.kind === "agent" && n.a.address === shownAgent }));
    }
    this.drawn = nodes.length;

    const empty = !sp.length;
    return div().id("flow-root").relative().size_full().overflow_hidden().bg(t.canvas).text_color(t.foreground)
      .when(Boolean(this.press?.moved && this.press.kind === "pan"), (el) => el.cursor_grabbing())
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      .on_mouse_down("left", (e) => this.pressBackground(e))
      .on_mouse_down("middle", (e) => this.pressBackground(e)) // the middle button pans anywhere, over nodes too
      .on_mouse_move((e, cx) => this.move(e, cx))
      .on_mouse_up("left", (_e, cx) => this.release(cx))
      .on_mouse_up("middle", (_e, cx) => this.release(cx))
      .on_hover((over, cx) => { if (!over && this.press) this.release(cx); })
      .on_scroll_wheel((e, cx) => this.wheel(e, cx))
      .when(W > 0 && !this.off?.has("grid"), (el) => el.child(this.grid(t, W, H, v)))
      .when(!this.off?.has("edges"), (el) => el.children(this.edges(t, groups, z)))
      .when(!this.off?.has("anim"), (el) => el.children(dots))
      .when(!this.off?.has("nodes"), (el) => el.children(nodes))
      .when(empty, (el) => el.child(this.emptyState(t)))
      .child(this.controls(t, z))
      .child(this.toolbar(t));
  }

  // The dotted background: a dashed stroke per row draws a row of dots. Coarser when zoomed out.
  grid(t, W, H, v) {
    let step = GRID;
    while (step * v.z < 12) step *= 2;
    const s = step * v.z;
    const dot = clamp(1.6 * v.z, 1.1, 2.2);
    const ox = ((v.x % s) + s) % s, oy = ((v.y % s) + s) % s;
    const len = (Math.ceil(W / s) + 2) * s;
    let b = PathBuilder.stroke(dot).dash_array([dot, s - dot]);
    for (let y = oy - s; y < H + s; y += s) b = b.move_to(ox - s - dot / 2, y).line_to(ox - s - dot / 2 + len, y);
    return window.paint_path(b.build(), alpha(t.foreground, 0.17)).absolute().top(0).left(0).size_full();
  }

  edges(t, groups, z) {
    const look = {
      idle: [alpha(t.foreground, 0.28), null],
      done: [alpha(t.done, 0.75), null],
      work: [alpha(t.working, 0.55), null],
      block: [t.blocked, [7 * z, 5 * z]],
      link: [alpha(t.foreground, 0.35), [6 * z, 5 * z]],
      add: [alpha(t.foreground, 0.22), [4 * z, 4 * z]],
    };
    const width = clamp(2 * z, 1.2, 3);
    const out = [];
    for (const [g, list] of Object.entries(groups)) {
      if (!list.length) continue;
      const [color, dash] = look[g];
      let b = PathBuilder.stroke(width);
      if (dash) b = b.dash_array(dash);
      for (const [p0, c1, c2, p1] of list) b = b.move_to(p0[0], p0[1]).cubic_bezier_to(p1[0], p1[1], c1[0], c1[1], c2[0], c2[1]);
      out.push(window.paint_path(b.build(), color).absolute().top(0).left(0).size_full());
    }
    return out;
  }

  // One node: a rounded card with an icon tile, a title and a status line (n8n's node, wider).
  node(t, n, { x, y, w, h, z, active, on }) {
    const S = (k) => k * z;
    const st = G.statusOf(n);
    const dragging = this.drag?.id === n.id;
    const base = div().id(`node-${n.id}`).absolute().left(x).top(y).w(w).h(h)
      .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressNode(n, e); })
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.menuFor(n); });

    if (n.kind === "add") {
      return base.flex().items_center().justify_center().rounded(S(9)).border_1().border_dashed().border_color(alpha(t.foreground, 0.3))
        .bg(t.canvas).cursor_pointer().hover((s) => s.border_color(t.accent).bg(t.hover))
        .tooltip(`Start an agent in ${n.s.name}`)
        .child(svg(I("plus")).size(S(18)).text_color(t.muted));
    }
    if (n.kind === "more") {
      return base.flex().items_center().justify_center().rounded(S(8)).border_1().border_color(t.border).bg(t.background)
        .cursor_pointer().hover((s) => s.bg(t.hover)).text_size(S(12)).text_color(t.muted)
        .tooltip("Show all subagents").child(`+${n.n} more`);
    }

    const sub = n.kind === "cc";
    const p = n.kind === "agent" ? n.a.program : null;
    const title = n.kind === "space" ? n.s.name : n.kind === "agent" ? G.agentTitle(n.a) : n.sub.description;
    const tileSize = S(sub ? 30 : 38);
    let tile;
    if (n.kind === "space") {
      tile = div().size(tileSize).flex_none().rounded(S(9)).flex().items_center().justify_center()
        .bg(n.worktree ? alpha(t.ansi5 ?? t.accent, 0.16) : alpha(t.accent, 0.16))
        .child(svg(I(n.worktree ? "branch" : "folder")).size(S(19)).text_color(n.worktree ? (t.ansi5 ?? t.accent) : t.accent));
    } else if (n.kind === "agent") {
      tile = div().size(tileSize).flex_none().rounded(S(9)).flex().items_center().justify_center()
        .bg(p?.tile ?? t.raised).border_1().border_color(alpha(t.foreground, 0.08))
        .child(programIcon(p, S(20), p?.color ?? t.foreground) ?? svg(I("terminal")).size(S(18)).text_color(t.foreground));
    } else {
      tile = div().size(tileSize).flex_none().rounded(S(8)).flex().items_center().justify_center().bg(t.raised)
        .child(svg(I("bot")).size(S(16)).text_color(t.muted));
    }

    // The status line under the title.
    let line;
    if (n.kind === "space") {
      const mine = n.children.filter((c) => c.kind === "agent").length;
      const branch = n.s.branch ?? null;
      line = h_flex().gap(S(5)).items_center().min_w(0)
        .when(Boolean(branch), (el) => el.child(svg(I("branch")).size(S(11)).flex_none().text_color(t.dim)).child(div().min_w(0).truncate().child(branch)))
        .child(div().flex_none().text_color(t.dim).child(`${branch ? "· " : ""}${mine} agent${mine === 1 ? "" : "s"}`))
        .when(n.worktree, (el) => el.child(div().flex_none().px(S(4)).rounded(S(4)).border_1().border_color(t.border).text_size(S(9.5)).child("worktree")))
        .when(Boolean(n.s.machine), (el) => el.child(div().flex_none().text_color(t.dim).child(`· ${n.s.machine}`)));
    } else if (n.kind === "agent") {
      const msg = n.synthetic ? null : G.msgOf(n.term);
      line = h_flex().gap(S(5)).items_center().min_w(0)
        .child(div().flex_none().text_color(st === "idle" ? t.dim : t[st] ?? t.dim).child(WORD[st] ?? st))
        .when(Boolean(msg) && st !== "idle", (el) => el.child(div().min_w(0).truncate().text_color(t.muted).child(`· ${msg}`)));
    } else {
      const s = n.sub;
      const doing = s.state === "running" ? SA.activityText(s) ?? "Working" : s.state === "done" ? "Done" : "Stopped";
      const time = SA.runningFor(s);
      line = h_flex().gap(S(5)).items_center().min_w(0)
        .child(div().min_w(0).truncate().text_color(s.state === "running" ? t.muted : t.dim).child(doing))
        .when(Boolean(time), (el) => el.child(div().flex_none().text_color(t.dim).child(`· ${time}`)));
    }

    // The mark on the right: spinner, needs-you dot (pulsing), check, grey dot.
    const markSize = S(sub ? 12 : 14);
    let mark = null;
    if (n.kind !== "space") {
      if (st === "working") mark = svg(I("spinner")).size(markSize).flex_none().text_color(t.working).spin(900);
      else if (st === "done") mark = svg(I("check")).size(markSize).flex_none().text_color(t.done);
      else if (st === "blocked") {
        // Pulsing while the window is in front (a spin, cheap); a still dot otherwise.
        const dw = Math.max(5, S(9));
        mark = div().size(markSize).flex_none().flex().items_center().justify_center()
          .child(active ? pulseDot(dw, t.blocked) : div().size(dw).rounded_full().bg(t.blocked));
      } else mark = div().size(markSize).flex_none().flex().items_center().justify_center().child(div().size(S(6)).rounded_full().bg(t.dim));
    } else {
      const top = n.children.reduce((m, c) => (c.kind === "agent" && (RANK[c.a.status] ?? 0) > (RANK[m] ?? 0) ? c.a.status : m), null);
      if (top === "blocked" || top === "done") mark = div().size(S(8)).flex_none().rounded_full().bg(t[top]);
    }

    const tip = n.kind === "space"
      ? [n.s.name, n.s.branch, n.git?.top ?? n.s.folder].filter(Boolean).join("\n")
      : n.kind === "agent"
        ? [title, p?.name !== title ? p?.name : null, WORD[st], n.synthetic ? null : G.msgOf(n.term), "Click: show it · double-click: type into it · right-click: menu"].filter(Boolean).join("\n")
        : [n.sub.description, n.sub.type, `${SA.activityText(n.sub) ?? ""}`, n.sub.result ? n.sub.result.split("\n")[0].slice(0, 140) : null].filter(Boolean).join("\n");

    const edge = on ? t.accent : st === "blocked" ? t.blocked : st === "working" ? alpha(t.working, 0.5) : st === "done" ? alpha(t.done, 0.55) : t.border;
    const faded = (sub && n.sub.state !== "running") || (n.kind === "agent" && st === "idle" && !on);
    const card = base.flex().items_center().gap(S(10)).pl(S(sub ? 9 : 11)).pr(S(12)).rounded(S(11))
      .bg(t.background).border_color(edge)
      .when(on, (el) => el.border_2())
      .when(!on, (el) => el.border_1())
      .when(dragging, (el) => el.shadow_lg().cursor_grabbing())
      .when(!dragging, (el) => el.shadow_sm().cursor_pointer().hover((s) => s.border_color(on ? t.accent : t.input)))
      .when(faded, (el) => el.opacity(0.72))
      .tooltip(tip)
      .child(tile)
      .child(v_flex().flex_1().min_w(0).gap(S(2))
        .child(div().truncate().text_size(S(sub ? 12 : 13)).font_semibold().text_color(t.foreground).child(title))
        .when(z >= 0.5, (el) => el.child(line.text_size(S(sub ? 10.5 : 11.5)))))
      .when(Boolean(mark), (el) => el.child(mark));

    // Ports: in on the left (when it has a parent), out on the right (when it has children).
    const port = (left) => div().absolute().left(left).top(h / 2 - S(4)).size(S(8)).rounded_full().bg(t.background).border_1().border_color(alpha(t.foreground, 0.4));
    const withPorts = card
      .when(Boolean(n.parentId), (el) => el.child(port(-S(4) - 1)))
      .when(n.children.length > 0, (el) => el.child(port(w - S(4) - 1)));
    // A running agent: a beam runs round its edge (spin, its own layer).
    if (st === "working" && n.kind === "agent" && active) return this.beam(t, withPorts, w, h, S(11), n.id);
    return withPorts;
  }

  // From my-spaces: a bright wedge spins behind the card, seen only through four thin strips along
  // its edges (each clips its own copy), stopping short of the rounded corners.
  beam(t, card, w, h, radius, id) {
    const d = Math.ceil(Math.hypot(w, h)) + 6, k = 1.5, r = Math.max(2, radius);
    const strip = (s, x, y, sw, sh) => div().id(`beam-${id}-${s}`).absolute().left(x).top(y).w(sw).h(sh).overflow_hidden()
      .child(svg(I("beam")).absolute().w(d).h(d).left((w - d) / 2 - x).top((h - d) / 2 - y).text_color(t.working).spin(2200));
    return card
      .child(strip("t", r, 0, w - 2 * r, k))
      .child(strip("b", r, h - k, w - 2 * r, k))
      .child(strip("l", 0, r, k, h - 2 * r))
      .child(strip("r", w - k, r, k, h - 2 * r));
  }

  // Nothing here yet: n8n's "add first step" box.
  emptyState(t) {
    return v_flex().absolute().inset_0().items_center().justify_center().gap(12)
      .child(div().id("flow-first").size(96).rounded(14).border_2().border_dashed().border_color(alpha(t.foreground, 0.3))
        .flex().items_center().justify_center().cursor_pointer().hover((s) => s.border_color(t.accent).bg(t.hover))
        .on_mouse_down("left", stop)
        .on_click(() => openOverlay({ mod: "add-project", kind: "dialog", width: 520, props: { machine: null } }))
        .child(svg(I("plus")).size(30).text_color(t.muted)))
      .child(div().text_size(13).text_color(t.muted).child("Add your first project"));
  }

  button(t, id, icon, tip, action, on = false) {
    return div().id(id).size(30).flex().items_center().justify_center().rounded(8)
      .bg(on ? t.selected : t.background).border_1().border_color(t.border).text_color(on ? t.foreground : t.muted)
      .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_mouse_down("left", stop)
      .on_click((_e, cx) => { action(cx); cx.notify(); })
      .child(svg(I(icon)).size(15));
  }

  // Bottom left, like n8n: fit, zoom in, zoom out, 100 %, tidy up; the zoom level.
  controls(t, z) {
    const save = () => this.save("view", this.view);
    return h_flex().absolute().left(12).bottom(12).gap(5).items_center()
      .child(this.button(t, "flow-fit", "fit", "Fit to view (and keep fitting as agents come and go)", () => this.refit()))
      .child(this.button(t, "flow-zin", "zoom-in", "Zoom in (Ctrl+wheel)", () => { this.zoomAt((this.view?.z ?? 1) * 1.2, this.center()); save(); }))
      .child(this.button(t, "flow-zout", "zoom-out", "Zoom out (Ctrl+wheel)", () => { this.zoomAt((this.view?.z ?? 1) / 1.2, this.center()); save(); }))
      .child(this.button(t, "flow-z100", "hundred", "Zoom to 100 %", () => { this.zoomAt(1, this.center()); save(); }))
      .child(this.button(t, "flow-tidy", "workflow", "Tidy up: put every node back in the tree", () => this.tidy()))
      .child(div().pl(4).text_size(11).text_color(t.dim).child(`${Math.round(z * 100)}%`));
  }

  // Top right: add a project, show or hide the terminal panel.
  toolbar(t) {
    const shown = panelShown();
    return h_flex().absolute().right(12).top(12).gap(6).items_center()
      .child(h_flex().id("flow-add-project").h(30).px(10).gap(6).items_center().rounded(8).bg(t.background).border_1().border_color(t.border)
        .text_size(12).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip("Add a project").on_mouse_down("left", stop)
        .on_click(() => openOverlay({ mod: "add-project", kind: "dialog", width: 520, props: { machine: spaces().find((s) => s.active)?.machine ?? null } }))
        .child(svg(I("folder-plus")).size(14)).child("Add project"))
      .child(this.button(t, "flow-panel", "panel-right", shown ? "Hide the terminal panel" : "Show the terminal panel",
        () => run(shown ? "layout.hide" : "layout.show", { id: "flow-terminal" }), shown));
  }

  // ---- the title bar ---------------------------------------------------------------------------------

  renderBar() {
    const t = theme();
    const w = appWindow();
    const list = agents();
    const count = (s) => list.filter((a) => a.status === s).length;
    const working = count("working"), needs = count("blocked");
    const current = shared("layout") ?? "flow";
    const btn = (id, child, action, tip) => div().id(id).size(28).flex_none().flex().items_center().justify_center().rounded(6)
      .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).when(Boolean(tip), (el) => el.tooltip(tip))
      .on_mouse_down("left", stop).on_click(action).child(child);
    const seg = (name, label, icon) => h_flex().id(`flow-seg-${name}`).h(24).px(10).gap(6).items_center().rounded(6)
      .text_size(12).cursor_pointer()
      .when(current === name, (el) => el.bg(t.background).text_color(t.foreground).border_1().border_color(t.border))
      .when(current !== name, (el) => el.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
      .on_mouse_down("left", stop).on_click(() => { if (current !== name) run("layout.switch", { name }); })
      .child(svg(I(icon)).size(13)).child(label);
    return h_flex().size_full().bg(t.chrome).border_b(1).border_color(t.border).pl(14).pr(6).gap(10).items_center().text_size(13)
      .when(w?.platform === "macos" && !w?.fullscreen, (el) => el.pl(80))
      .child(h_flex().flex_1().min_w(0).gap(8).items_center()
        .child(image("mods/flow-canvas/atrous.png").size(20).flex_none())
        .child(div().font_semibold().text_color(t.foreground).child("Atrous"))
        .child(div().text_color(t.dim).child("/"))
        .child(h_flex().gap(6).items_center().text_color(t.muted).child(svg(I("workflow")).size(14)).child("Flow")))
      .child(h_flex().flex_none().p(2).gap(2).rounded(8).bg(t.surface ?? t.chrome).border_1().border_color(t.border)
        .child(seg("fedra", "Fedra", "sidebar")).child(seg("flow", "Flow", "workflow")))
      .child(h_flex().flex_1().min_w(0).gap(10).justify_end().items_center().text_size(12).text_color(t.muted)
        .child(h_flex().gap(5).items_center().child(div().size(6).rounded_full().bg(t.dim)).child(`${list.length} agent${list.length === 1 ? "" : "s"}`))
        .when(working > 0, (el) => el.child(h_flex().gap(5).items_center().child(svg(I("spinner")).size(11).text_color(t.working).spin(900)).child(`${working} working`)))
        .when(needs > 0, (el) => el.child(h_flex().gap(5).items_center().text_color(t.blocked).child(div().size(6).rounded_full().bg(t.blocked)).child(`${needs} need${needs === 1 ? "s" : ""} you`)))
        .child(h_flex().gap(1).items_center()
          .child(btn("flow-search", svg(I("search")).size(15), () => run("mod.open", { name: "picker" }), "Find a space or agent"))
          .child(btn("flow-settings", svg(I("settings")).size(15), () => run("mod.open", { name: "my-settings" }), "Settings"))
          .when(Boolean(w?.buttons), (el) => el
            .child(btn("flow-min", svg(I("win-min")).size(16), () => run("window.minimize")))
            .child(btn("flow-max", svg(I(w.maximized ? "win-restore" : "win-max")).size(16), () => run("window.maximize")))
            .child(btn("flow-close", svg(I("win-close")).size(16), () => run("window.close"))))));
  }

  // ---- the terminal panel's header -------------------------------------------------------------------

  renderTerminalHeader() {
    const t = theme();
    const addr = focused()?.agent ?? null;
    const list = agents();
    const a = list.find((x) => x.address === addr) ?? null;
    const term = addr ? terminals().find((k) => k.address === addr) : null;
    const st = a?.status ?? (term ? G.stateOf(term) : null);
    const title = a ? G.agentTitle(a) : term ? term.name || term.title || addr : "No agent";
    const p = a?.program ?? term?.program ?? null;
    const msg = G.msgOf(term);
    const space = a ? spaces().find((s) => s.id === a.space) : null;
    const btn = (id, icon, tip, action) => div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(6)
      .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip).on_click(action).child(svg(I(icon)).size(14));
    return h_flex().size_full().px(10).gap(8).items_center().bg(t.background).border_b(1).border_color(t.border).text_size(12.5)
      .child(programIcon(p, 15, t.foreground) ?? svg(I("terminal")).size(14).text_color(t.muted))
      .child(div().min_w(0).flex_shrink(1).truncate().font_semibold().text_color(t.foreground).child(title))
      .when(Boolean(st), (el) => el.child(h_flex().flex_none().gap(5).items_center().text_size(11.5).text_color(t[st] ?? t.dim)
        .when(st === "working", (el) => el.child(svg(I("spinner")).size(11).spin(900)))
        .when(st !== "working", (el) => el.child(div().size(6).rounded_full().bg(t[st] ?? t.dim)))
        .child(WORD[st] ?? st)))
      .when(Boolean(msg) && st !== "idle", (el) => el.child(div().min_w(0).flex_1().truncate().text_size(11.5).text_color(t.muted).child(msg)))
      .when(!(msg && st !== "idle"), (el) => el.child(div().flex_1()))
      .when(Boolean(space), (el) => el.child(div().flex_none().max_w(140).truncate().text_size(11.5).text_color(t.dim).child(space.name)))
      .child(btn("flow-prev", "chevron-left", "Previous agent", () => run("agent.prev")))
      .child(btn("flow-next", "chevron-right", "Next agent", () => run("agent.next")))
      .child(btn("flow-hide", "x", "Hide the panel", () => run("layout.hide", { id: "flow-terminal" })));
  }

  // ---- the "+" popup: start an agent in a space --------------------------------------------------------

  initAdd(cx) {
    const where = props()?.machine ?? "";
    this.agents = shared("new-menu.agents")?.[where] ?? [];
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async (cx) => {
      try {
        this.agents = await knownAgents({ on: props()?.machine ?? null });
        setShared("new-menu.agents", { ...(shared("new-menu.agents") ?? {}), [where]: this.agents });
      } catch { this.failed = true; }
      cx.notify();
    });
  }

  renderAdd() {
    const t = theme();
    const p = props() ?? {};
    const space = spaces().find((s) => s.id === p.space);
    const installed = (this.agents ?? []).filter((a) => a.installed);
    const start = (argv, name) => { closeOverlay(p.overlay); run("tab.new", { space: p.space, ...(name ? { name } : {}), ...(argv ? { argv } : {}) }); };
    const row = (id, icon, label, hint, action) => h_flex().id(id).h(31).px(9).gap(10).rounded(7).items_center().flex_none()
      .cursor_pointer().hover((s) => s.bg(t.selected)).on_click(action)
      .child(icon).child(div().flex_1().truncate().child(label)).child(div().text_size(11).text_color(t.dim).child(hint));
    return v_flex().id("flow-add").track_focus(this.handle).w_full().min_h(0).p(5).bg(t.popover).text_size(12.8).text_color(t.foreground)
      .on_key_down((e) => {
        if (e.key === "escape") return closeOverlay(p.overlay);
        const a = /^[1-9]$/.test(e.key) ? installed[Number(e.key) - 1] : null;
        if (a) start(a.run, a.name);
      })
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).truncate().child(`New agent in ${space?.name ?? "this space"}`))
      .children(installed.map((a, i) => row(`flow-add-${a.key}`, programIcon(a, 15, t.foreground) ?? svg(I("bot")).size(15), a.name, i < 9 ? String(i + 1) : "", () => start(a.run, a.name))))
      .when(!installed.length, (el) => el.child(div().px(9).py(6).text_size(12).text_color(t.dim).child(this.failed ? "Couldn't list the agents." : "Looking for agents…")))
      .child(div().mx(7).my(4).h(1).bg(t.border))
      .child(row("flow-add-shell", svg(I("terminal")).size(14).text_color(t.muted), "Terminal", "", () => start(null, null)));
  }
}
