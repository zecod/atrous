// Usage & activity: tokens and money spent with AI coding agents, from ccusage
// (https://github.com/ryoppippi/ccusage), which reads the agents' local logs
// (~/.claude/projects, ~/.codex/sessions, ...). One implementation for two places:
// - the Settings tab (main.js, section "usage": mode "embedded"), and
// - the standalone dialog (`mod.open usage-stats` opens this mod with
//   props { section: "usage", only: true }: mode "standalone"),
// because a mod can't import from another mod's folder.
//
// Data: collect.mjs runs ccusage in a background atrous-core terminal and merges a compact
// per-day summary into ~/.config/atrous/data/usage-stats/ccusage.json (see its header).
// Preferences (source, metric, range, last width) go to prefs.json beside it.
//
// Smoothness. Atrous interrupts a render after ~55 ms of script and keeps the last good frame,
// so nothing here renders much at once:
// - the page is split into retained views that rebuild only when their own inputs change:
//   the page (header, toggles, job state), HeatView (the 53x7 grid: data, source, metric,
//   width), HoverLayer (the day under the pointer: a handful of elements, moved by one
//   mouse-move handler instead of 371 hover handlers) and BodyView (tiles, models, days);
// - what they show is computed once per data stamp, source, metric, range and day (`memo`);
// - progress animates natively (spin, loop): nothing re-renders while ccusage runs;
// - before the data file is read, the same layout renders with empty values, so nothing moves
//   when the numbers arrive; the data stays in memory for the next open.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, core, appHome, closeOverlay } from "atrous";
import * as fs from "fs/promises";

const STALE = 5 * 60000;
const JOB_LIMIT = 10 * 60000; // collect.mjs gives up on its own after 9 minutes
const COLS = 53; // weeks in the heatmap, the current one last
const RECENT = 14;

const root = () => appHome().replace(/\\/g, "/").replace(/\/+$/, "");
const DIR = () => `${root()}/data/usage-stats`;
const DATA = () => `${DIR()}/ccusage.json`;
const JOB = () => `${DIR()}/job.json`;
const PREFS = () => `${DIR()}/prefs.json`;
const SCRIPT = () => `${root()}/mods/my-settings/collect.mjs`;
const I = (name) => `mods/my-settings/${name}.svg`;

const SOURCES = [
  { key: "all", label: "All agents" },
  { key: "claude", label: "Claude Code", icon: "icons/claude.svg" },
  { key: "codex", label: "Codex", icon: "icons/codex.svg" },
  { key: "other", label: "Others" },
];
// ccusage's agent ids -> [name, icon in icons/, one-color glyph (drawn with svg(), tinted)].
const AGENTS = {
  claude: ["Claude Code", "claude"], codex: ["Codex", "codex"], opencode: ["opencode", "opencode", true],
  gemini: ["Gemini CLI", "gemini"], pi: ["pi", "pi"], amp: ["Amp", "amp"], copilot: ["Copilot CLI", "copilot", true],
  kimi: ["Kimi", "kimi"], grok: ["Grok", "grok", true], hermes: ["Hermes", "hermes", true], antigravity: ["Antigravity", "antigravity"],
  qwen: ["Qwen"], goose: ["Goose"], droid: ["Droid"], codebuff: ["Codebuff"], kilo: ["Kilo"], openclaw: ["OpenClaw"], zcode: ["ZCode"],
};
const agentName = (a) => AGENTS[a]?.[0] ?? a;
function agentIcon(a, color) {
  const [, icon, tint] = AGENTS[a] ?? [];
  return icon && !tint ? image(`icons/${icon}.svg`) : svg(`icons/${icon ?? "agent"}.svg`).text_color(color);
}

// ---- dates (local, as ccusage groups them) ----
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n) => String(n).padStart(2, "0");
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromKey = (k) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const todayKey = () => dayKey(new Date());
const shortDate = (d, year) => `${MONTHS[d.getMonth()]} ${d.getDate()}${year || d.getFullYear() !== new Date().getFullYear() ? `, ${d.getFullYear()}` : ""}`;
const longDate = (d) => `${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
const clock = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

// ---- numbers ----
const grouped = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
function tok(n) {
  const a = Math.abs(n ?? 0);
  if (a >= 1e9) return `${(n / 1e9).toFixed(a >= 1e11 ? 0 : a >= 1e10 ? 1 : 2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e8 ? 0 : 1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(a >= 1e5 ? 0 : 1)}K`;
  return String(Math.round(n ?? 0));
}
function usd(c) {
  if (!c) return "$0";
  if (c < 0.01) return "<$0.01";
  return c >= 1000 ? `$${grouped(c)}` : `$${c.toFixed(2)}`;
}
const plural = (n, word) => `${grouped(n)} ${word}${n === 1 ? "" : "s"}`;

// ---- colors ----
function rgb(hex) {
  const h = String(hex ?? "").replace("#", "");
  if (h.length === 3) return [0, 1, 2].map((i) => parseInt(h[i] + h[i], 16));
  if (h.length >= 6) return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return null;
}
function mix(a, b, w) {
  const x = rgb(a), y = rgb(b);
  if (!x || !y || [...x, ...y].some(Number.isNaN)) return w < 0.5 ? a : b;
  return `#${x.map((v, i) => pad(Math.round(v * (1 - w) + y[i] * w).toString(16))).join("")}`;
}
function dark(hex) {
  const c = rgb(hex);
  return !c || (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255 < 0.5;
}
// GitHub's contribution greens, for dark and light themes; the empty step from the theme.
const GREENS = { dark: ["#0e4429", "#006d32", "#26a641", "#39d353"], light: ["#9be9a8", "#40c463", "#30a14e", "#216e39"] };
const heatColors = (t) => [mix(t.raised, t.foreground, 0.07), ...GREENS[dark(t.background) ? "dark" : "light"]];

async function readJson(path) {
  try { return JSON.parse(await fs.readFile(path, "utf8")); } catch { return null; }
}

function errorText(r) {
  try {
    const msg = JSON.parse(r.stdout || r.stderr)?.error?.message;
    if (msg) return msg;
  } catch {}
  return (r.stderr || r.stdout || "").trim();
}

const empty = () => ({ i: 0, o: 0, cw: 0, cr: 0, c: 0, t: 0 });
const add = (r, e) => { r.i += e.i; r.o += e.o; r.cw += e.cw; r.cr += e.cr; r.c += e.c; r.t += e.t; return r; };

// ---- shared state: one per build of this mod, so a reopened page has its numbers at once ----

const store = {
  data: null, // ccusage.json
  stamp: 0, // bumped when data changes
  loaded: false, // the file was read (it may not exist yet)
  prefs: { source: "all", metric: "tokens", range: "30", width: {} },
  prefsRead: false,
  memo: new Map(),
};

function memo(key, f) {
  if (store.memo.has(key)) return store.memo.get(key);
  if (store.memo.size > 80) store.memo.clear();
  const v = f();
  store.memo.set(key, v);
  return v;
}

function setData(d) {
  store.data = d;
  store.stamp++;
  store.memo.clear();
}
function setPrefs(p) {
  store.prefs = { ...store.prefs, ...p, width: { ...(p.width ?? {}) } };
}

// The first frame after Atrous starts: the files aren't read yet (a busy disk can take a while),
// so the numbers and preferences come from this copy's localStorage, which reads at once.
function seed() {
  if (store.data) return;
  try {
    const p = JSON.parse(localStorage.getItem("usage.prefs") ?? "null");
    if (p) setPrefs(p);
    const d = JSON.parse(localStorage.getItem("usage.data") ?? "null");
    if (d?.days) setData(d);
  } catch {}
}

async function loadData() {
  const d = await readJson(DATA());
  if (d?.days && d.updated !== store.data?.updated) {
    setData(d);
    try { localStorage.setItem("usage.data", JSON.stringify(d)); } catch {}
  }
  if (!store.prefsRead) {
    const p = await readJson(PREFS());
    if (p) setPrefs(p);
    store.prefsRead = true;
  }
  store.loaded = true;
}

function savePrefs(cx) {
  try { localStorage.setItem("usage.prefs", JSON.stringify(store.prefs)); } catch {}
  cx.spawn(async () => {
    await fs.mkdir(DIR(), { recursive: true }).catch(() => {});
    await fs.writeFile(PREFS(), JSON.stringify(store.prefs)).catch(() => {});
  });
}

// ---- numbers for a source, computed once per data stamp ----

const matches = (source, agent) => source === "all" || (source === "other" ? agent !== "claude" && agent !== "codex" : agent === source);
const val = (metric, e) => (!e ? 0 : metric === "cost" ? e.c : e.t);
const fmt = (metric, v) => (metric === "cost" ? usd(v) : tok(v));
const other = (metric, e) => (metric === "cost" ? `${tok(e.t)} tokens` : usd(e.c));

function agentsInData() {
  return memo(`agents|${store.stamp}`, () => {
    const seen = new Set();
    for (const agents of Object.values(store.data?.days ?? {})) for (const a of Object.keys(agents)) seen.add(a);
    return [...seen];
  });
}

// date -> summed { i, o, cw, cr, c, t, by: { agent: { t, c } } }
function series(source) {
  return memo(`series|${store.stamp}|${source}`, () => {
    const v = new Map();
    for (const [date, agents] of Object.entries(store.data?.days ?? {})) {
      const s = { ...empty(), by: {} };
      for (const [agent, e] of Object.entries(agents)) {
        if (!matches(source, agent)) continue;
        const t = e.i + e.o + e.cw + e.cr;
        add(s, { ...e, t });
        if (t > 0 || e.c > 0) s.by[agent] = { t, c: e.c };
      }
      if (s.t > 0 || s.c > 0) v.set(date, s);
    }
    return v;
  });
}

// The heatmap's days, column by column from a Monday 53 weeks back (null: after today).
function calendar(today) {
  return memo(`cal|${today}`, () => {
    const now = fromKey(today);
    const start = addDays(now, -((now.getDay() + 6) % 7) - (COLS - 1) * 7);
    const days = [];
    const starts = []; // [column, month] where a month's 1st falls
    for (let i = 0; i < COLS * 7; i++) {
      const d = addDays(start, i);
      const future = d > now;
      days.push(future ? null : dayKey(d));
      if (!future && d.getDate() === 1) starts.push([Math.floor(i / 7), d.getMonth()]);
    }
    const labels = [];
    if (!starts.length || starts[0][0] >= 3) labels.push([0, start.getMonth()]);
    for (const [c, m] of starts) if (!labels.length || c - labels[labels.length - 1][0] >= 3) labels.push([c, m]);
    return { days, labels };
  });
}

// Each day's step: four between the quartiles of the year's active days (GitHub's way),
// so one huge day doesn't wash out the rest. -1: after today.
function heatModel(source, metric, today) {
  return memo(`heat|${store.stamp}|${source}|${metric}|${today}`, () => {
    const s = series(source);
    const { days } = calendar(today);
    const vals = [];
    const total = { t: 0, c: 0 };
    for (const k of days) {
      const e = k && s.get(k);
      if (!e) continue;
      total.t += e.t;
      total.c += e.c;
      if (val(metric, e) > 0) vals.push(val(metric, e));
    }
    vals.sort((a, b) => a - b);
    const q = (p) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] ?? 0;
    const cuts = [q(0.25), q(0.5), q(0.75)];
    const levels = days.map((k) => {
      if (!k) return -1;
      const v = val(metric, s.get(k));
      return v <= 0 ? 0 : v <= cuts[0] ? 1 : v <= cuts[1] ? 2 : v <= cuts[2] ? 3 : 4;
    });
    return { levels, total };
  });
}

function stats(source, metric, today) {
  return memo(`stats|${store.stamp}|${source}|${metric}|${today}`, () => {
    const s = series(source);
    const now = fromKey(today);
    const sum = (from) => {
      const r = empty();
      for (let d = addDays(now, -from); d <= now; d = addDays(d, 1)) { const e = s.get(dayKey(d)); if (e) add(r, e); }
      return r;
    };
    const keys = [...s.keys()].sort();
    const all = empty();
    for (const e of s.values()) add(all, e);
    // Streaks of days with any usage; today counts once it has some, else the streak runs to yesterday.
    let current = 0;
    let d = s.has(today) ? now : addDays(now, -1);
    while (s.has(dayKey(d))) { current++; d = addDays(d, -1); }
    const currentFrom = current ? addDays(d, 1) : null;
    let longest = 0, longestFrom = null, longestTo = null, run = 0, runFrom = null, prev = null;
    for (const k of keys) {
      const day = fromKey(k);
      run = prev && dayKey(addDays(prev, 1)) === k ? run + 1 : 1;
      if (run === 1) runFrom = day;
      if (run > longest) { longest = run; longestFrom = runFrom; longestTo = day; }
      prev = day;
    }
    let busiest = null;
    for (const [k, e] of s) if (!busiest || val(metric, e) > val(metric, busiest.e)) busiest = { k, e };
    return {
      today: sum(0), week: sum(6), month: sum(29), all,
      first: keys[0] ?? null, active: keys.length,
      current, currentFrom, longest, longestFrom, longestTo, busiest,
    };
  });
}

function models(source, range, metric, today) {
  return memo(`models|${store.stamp}|${source}|${range}|${metric}|${today}`, () => {
    const from = range === "all" ? null : dayKey(addDays(fromKey(today), -(Number(range) - 1)));
    const m = new Map();
    for (const [date, agents] of Object.entries(store.data?.days ?? {})) {
      if (from && date < from) continue;
      for (const [agent, e] of Object.entries(agents)) {
        if (!matches(source, agent)) continue;
        for (const [name, [i, o, cw, cr, c]] of Object.entries(e.m ?? {})) {
          const k = `${agent}|${name}`;
          const x = m.get(k) ?? { agent, name, t: 0, c: 0 };
          x.t += i + o + cw + cr;
          x.c += c;
          m.set(k, x);
        }
      }
    }
    const all = [...m.values()].filter((x) => x.t > 0 || x.c > 0).sort((a, b) => val(metric, b) - val(metric, a) || b.t - a.t);
    const shown = all.slice(0, 9);
    const rest = all.slice(9);
    if (rest.length) shown.push({ agent: null, name: `${rest.length} more models`, t: rest.reduce((a, x) => a + x.t, 0), c: rest.reduce((a, x) => a + x.c, 0) });
    return { shown, total: all.reduce((a, x) => a + val(metric, x), 0) };
  });
}

function recent(source, today) {
  return memo(`recent|${store.stamp}|${source}|${today}`, () => {
    const s = series(source);
    const now = fromKey(today);
    return [...Array(RECENT)].map((_, n) => {
      const d = addDays(now, -n);
      return { n, label: n === 0 ? "Today" : `${WEEKDAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}`, long: longDate(d), e: s.get(dayKey(d)) ?? null };
    });
  });
}

// Heatmap geometry for a content width.
function geom(width, compact) {
  const label = compact ? 26 : 30, gap = compact ? 2 : 3, pad = compact ? 14 : 16;
  const cell = Math.max(6, Math.min(20, Math.floor((width - pad * 2 - 2 - label + gap) / COLS) - gap));
  const step = cell + gap;
  return { label, gap, pad, cell, step, w: COLS * step - gap, h: 7 * step - gap };
}

// ---- pieces ----

const card = (t) => v_flex().rounded(10).border_1().border_color(t.border).bg(t.raised);

function segmented(t, id, items, value, pick) {
  return h_flex().p(2).gap(2).rounded(8).border_1().border_color(t.border).bg(t.background)
    .children(items.map((it) => {
      const on = it.key === value;
      return h_flex().id(`${id}-${it.key}`).h(26).px(10).gap(6).items_center().rounded(6).text_size(12.5)
        .when(on, (el) => el.bg(t.selected).text_color(t.foreground).font_semibold())
        .when(!on, (el) => el.text_color(t.muted).font_medium().cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)))
        .when(Boolean(it.tip), (el) => el.tooltip(it.tip))
        .on_click((_e, cx) => { if (!on) pick(it.key, cx); })
        .when(Boolean(it.icon), (el) => el.child(image(it.icon).size(13).flex_none()))
        .child(it.label);
    }));
}

function iconButton(t, id, icon, tip, action, spinning) {
  return div().id(id).size(28).flex_none().flex().items_center().justify_center().rounded(7)
    .text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
    .tooltip(tip).on_click(action)
    .child(spinning ? svg(I("us-spinner")).size(15).text_color(t.working).spin(900) : svg(I(icon)).size(16));
}

// ---- the views ----

// The day under the pointer: an outline on its cell and a card with its numbers.
class HoverLayer extends View {
  init(props) { this.p = props ?? {}; }
  update(props) { this.p = props ?? {}; }
  render() {
    const { at, g, source } = this.p;
    if (!at || !g) return div();
    const t = theme();
    // g: the grid as drawn (HeatView.drawn()), in its own coordinates.
    const col = Math.floor(at.i / 7), row = at.i % 7;
    const x = col * g.sx, y = row * g.sy;
    const e = series(source).get(at.k);
    const by = e ? Object.entries(e.by).sort((a, b) => b[1].t - a[1].t) : [];
    const lines = [e ? `${grouped(e.t)} tokens · ${usd(e.c)}` : "No usage"];
    if (by.length > 1) lines.push(by.map(([a, v]) => `${agentName(a)} ${tok(v.t)} · ${usd(v.c)}`).join("   "));
    const W = by.length > 1 ? 300 : 230;
    const H = 14 + 17 * (lines.length + 1);
    const left = Math.max(-g.label, Math.min(COLS * g.sx - W, x + g.cw / 2 - W / 2));
    const top = row < 3 ? y + g.ch + 6 : y - H - 6;
    return div().size_full().relative()
      .child(div().absolute().left(x - 1).top(y - 1).w(g.cw + 2).h(g.ch + 2).rounded(3).border_1().border_color(t.foreground))
      .child(v_flex().absolute().left(left).top(top).w(W).px(10).py(7).gap(1).rounded(7)
        .border_1().border_color(t.border).bg(t.popover).shadow_md().text_size(12)
        .child(div().font_semibold().text_color(t.foreground).child(longDate(fromKey(at.k))))
        .children(lines.map((l, n) => div().truncate().text_color(n ? t.dim : t.muted).child(l))));
  }
}

// The year as a grid of days. Rebuilt only when data, source, metric, day or width change.
class HeatView extends View {
  init(props) { this.p = props ?? {}; }
  update(props) {
    this.p = props ?? {};
    this.shown = undefined;
  }

  // The grid as drawn. GPUI rounds every cell and gap to whole device pixels (at 125%, a 10 px
  // cell is 12 device px and a 2 px gap 2, not 12.5 and 2.5), so 53 columns end up narrower
  // than cell + gap would say: positions come from the measured size, never from `g.step`.
  drawn() {
    const { g } = this.p;
    const w = this.size?.width ?? g.w, h = this.size?.height ?? g.h;
    const sx = (w + g.gap) / COLS, sy = (h + g.gap) / 7;
    return { ...g, sx, sy, cw: sx * (g.cell / g.step), ch: sy * (g.cell / g.step) };
  }

  // One handler for the whole grid: which cell is under the pointer.
  point(pos) {
    const { today, source, hover } = this.p;
    const d = this.drawn();
    let at = null;
    if (pos) {
      const col = Math.floor(pos.x / d.sx), row = Math.floor(pos.y / d.sy);
      if (col < 0 || col >= COLS || row < 0 || row >= 7) return;
      // In the gap between two cells: keep what's shown.
      if (pos.x - col * d.sx > d.cw || pos.y - row * d.sy > d.ch) return;
      const i = col * 7 + row;
      const k = calendar(today).days[i];
      if (k) at = { i, k };
    }
    if ((at?.k ?? null) === (this.shown ?? null)) return;
    this.shown = at?.k ?? null;
    hover.set_props({ at, g: d, source });
  }

  render() {
    const t = theme();
    const { source, metric, today, g, hover } = this.p;
    const cal = calendar(today);
    const { levels, total } = heatModel(source, metric, today);
    const colors = heatColors(t);
    const ring = mix(t.raised, t.foreground, 0.5);
    const radius = Math.min(3, g.cell / 4);
    const cols = [];
    for (let c = 0; c < COLS; c++) {
      const cells = [];
      for (let r = 0; r < 7; r++) {
        const i = c * 7 + r;
        const cell = div().size(g.cell);
        if (levels[i] >= 0) {
          cell.rounded(radius).bg(colors[levels[i]]);
          if (cal.days[i] === today) cell.border_1().border_color(ring);
        }
        cells.push(cell);
      }
      cols.push(v_flex().flex_none().gap(g.gap).children(cells));
    }
    const legend = h_flex().gap(3).items_center().text_size(11).text_color(t.dim)
      .child(div().pr(3).child("Less"))
      .children(colors.map((c) => div().size(10).rounded(2).bg(c)))
      .child(div().pl(3).child("More"));
    const weekdays = ["Mon", "", "Wed", "", "Fri", "", ""];
    // Month names in slots as wide as the columns, so they round like the cells do.
    const months = new Map(cal.labels);
    const slots = [];
    for (let c = 0; c < COLS; c++) {
      const slot = div().w(g.cell).h(14).flex_none().relative();
      if (months.has(c)) slot.child(div().absolute().top(0).left(0).whitespace_nowrap().text_size(10.5).text_color(t.muted).child(MONTHS[months.get(c)]));
      slots.push(slot);
    }
    return card(t).p(g.pad).gap(10)
      .child(h_flex().h(20).items_center().gap(8)
        .child(div().text_size(13.5).font_semibold().text_color(t.foreground)
          .child(store.data ? `${metric === "cost" ? usd(total.c) : `${tok(total.t)} tokens`} in the last year` : "The last year"))
        .when(Boolean(store.data), (el) => el.child(div().text_size(12).text_color(t.dim).child(metric === "cost" ? `${tok(total.t)} tokens` : usd(total.c))))
        .child(div().flex_1())
        .child(legend))
      // Centered: rounding to device pixels leaves the drawn grid narrower than planned.
      .child(h_flex().justify_center().child(v_flex().flex_none().gap(4)
        .child(h_flex().ml(g.label).gap(g.gap).children(slots))
        .child(h_flex().items_start()
          .child(v_flex().w(g.label).flex_none().gap(g.gap)
            .children(weekdays.map((w) => div().h(g.cell).flex().items_center().text_size(Math.min(10.5, g.cell + 1)).text_color(t.dim).child(w))))
          .child(div().id("hm-grid").relative().flex_none()
            .on_mouse_move((e, _cx) => this.point(e.local_position))
            .on_hover((inside, _cx) => { if (!inside) this.point(null); })
            .child(h_flex().id("hm-cols").items_start().gap(g.gap)
              .on_size_change((size, _cx) => { this.size = size; })
              .children(cols))
            .child(div().absolute().inset_0().child(hover))))));
  }
}

// Tiles, models and recent days. Rebuilt only when data, source, metric, range, day or width change.
class BodyView extends View {
  init(props) { this.p = props ?? {}; }
  update(props) { this.p = props ?? {}; }

  tile(t, label, value, sub, tip) {
    // Three lines always (a blank tile has a no-break space), so its height doesn't change.
    return v_flex().id(`tile-${label}`).flex_1().min_w(0).px(14).py(11).gap(2).rounded(10).border_1().border_color(t.border).bg(t.raised)
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .child(div().text_size(11.5).text_color(t.muted).truncate().child(label))
      .child(div().text_size(19).font_semibold().text_color(store.data ? t.foreground : t.dim).truncate().child(value))
      .child(div().text_size(11.5).text_color(t.dim).truncate().child(sub));
  }

  tiles(t) {
    const { source, metric, today } = this.p;
    if (!store.data) {
      const blank = (label) => this.tile(t, label, "—", " ");
      return v_flex().gap(10)
        .child(h_flex().gap(10).children(["Today", "Last 7 days", "Last 30 days", "All time"].map(blank)))
        .child(h_flex().gap(10).children(["Current streak", "Longest streak", "Busiest day", "Active days"].map(blank)));
    }
    const st = stats(source, metric, today);
    const exact = (e) => `${grouped(e.t)} tokens · ${usd(e.c)} (input ${tok(e.i)}, output ${tok(e.o)}, cache write ${tok(e.cw)}, cache read ${tok(e.cr)})`;
    const range = (a, b) => (a && b ? `${shortDate(a)} – ${shortDate(b)}` : "");
    const todayHas = st.today.t > 0 || st.today.c > 0;
    const b = st.busiest;
    const span = st.first ? Math.round((fromKey(today) - fromKey(st.first)) / 86400000) + 1 : 0;
    return v_flex().gap(10)
      .child(h_flex().gap(10)
        .child(this.tile(t, "Today", fmt(metric, val(metric, st.today)), other(metric, st.today), exact(st.today)))
        .child(this.tile(t, "Last 7 days", fmt(metric, val(metric, st.week)), other(metric, st.week), exact(st.week)))
        .child(this.tile(t, "Last 30 days", fmt(metric, val(metric, st.month)), other(metric, st.month), exact(st.month)))
        .child(this.tile(t, "All time", fmt(metric, val(metric, st.all)), `${other(metric, st.all)}${st.first ? ` · since ${shortDate(fromKey(st.first), true)}` : ""}`, exact(st.all))))
      .child(h_flex().gap(10)
        .child(this.tile(t, "Current streak", plural(st.current, "day"),
          st.current ? `since ${shortDate(st.currentFrom)}${todayHas ? "" : " · not today yet"}` : "No usage yesterday or today"))
        .child(this.tile(t, "Longest streak", plural(st.longest, "day"), range(st.longestFrom, st.longestTo) || "—"))
        .child(this.tile(t, "Busiest day", b ? shortDate(fromKey(b.k)) : "—", b ? `${tok(b.e.t)} tokens · ${usd(b.e.c)}` : "", b ? longDate(fromKey(b.k)) : null))
        .child(this.tile(t, "Active days", grouped(st.active), st.first ? `of ${grouped(span)} since ${shortDate(fromKey(st.first), true)}` : "—")));
  }

  modelsCard(t) {
    const { source, metric, range, today } = this.p;
    const { shown, total } = store.data ? models(source, range, metric, today) : { shown: [], total: 0 };
    const ranges = [{ key: "7", label: "7 days" }, { key: "30", label: "30 days" }, { key: "all", label: "All time" }];
    const bar = heatColors(t)[3];
    const pick = (k, cx) => {
      store.prefs.range = k;
      savePrefs(cx);
      this.p = { ...this.p, range: k };
      models(source, k, metric, today);
      cx.notify();
    };
    const rows = shown.length
      ? shown.map((m, n) => {
        const share = total > 0 ? val(metric, m) / total : 0;
        return v_flex().id(`model-${n}`).gap(5).tooltip(`${m.agent ? `${agentName(m.agent)} · ` : ""}${m.name}: ${grouped(m.t)} tokens · ${usd(m.c)}`)
          .child(h_flex().gap(8).items_center().text_size(12.5)
            .child(m.agent ? agentIcon(m.agent, t.muted).size(13).flex_none() : div().size(13).flex_none())
            .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(m.name))
            .child(div().w(64).flex_none().text_right().text_color(metric === "tokens" ? t.foreground : t.dim).child(tok(m.t)))
            .child(div().w(76).flex_none().text_right().text_color(metric === "cost" ? t.foreground : t.dim).child(usd(m.c)))
            .child(div().w(42).flex_none().text_right().text_color(t.muted).child(`${Math.round(share * 100)}%`)))
          .child(div().ml(21).h(4).rounded(2).bg(t.border)
            .when(share > 0, (el) => el.child(div().h_full().w(`${Math.max(0.6, share * 100)}%`).rounded(2).bg(bar))));
      })
      : store.data
        ? [div().h(36).flex().items_center().text_size(12.5).text_color(t.dim).child("No usage in this range.")]
        : [62, 48, 55, 40].map((w) => v_flex().gap(5).child(div().h(17).w(`${w}%`).rounded(4).bg(t.hover)).child(div().ml(21).h(4).rounded(2).bg(t.border)));
    return card(t).flex_1().min_w(0).p(16).gap(12)
      .child(h_flex().items_center().gap(8)
        .child(div().text_size(13.5).font_semibold().child("Models"))
        .child(div().flex_1())
        .child(segmented(t, "us-range", ranges, range, pick)))
      .child(v_flex().gap(10).children(rows));
  }

  recentCard(t) {
    const { source, metric, today } = this.p;
    const cols = ["Input", "Output", "Cache write", "Cache read", "Total", "Cost"];
    const head = h_flex().h(24).items_center().gap(8).text_size(11).font_medium().text_color(t.dim)
      .child(div().w(92).flex_none().child("Date"))
      .children(cols.map((c) => div().flex_1().min_w(0).text_right().truncate().child(c)));
    const rows = recent(source, today).map(({ n, label, long, e }) => {
      const cell = (text, strong) => div().flex_1().min_w(0).text_right().truncate().text_color(!e ? t.dim : strong ? t.foreground : t.muted).child(text);
      return h_flex().id(`row-${n}`).h(27).items_center().gap(8).text_size(12).border_t(1).border_color(t.border)
        .when(Boolean(e), (el) => el.tooltip(`${long}: ${grouped(e.t)} tokens · ${usd(e.c)}`))
        .child(div().w(92).flex_none().truncate().text_color(n === 0 ? t.foreground : t.muted).when(n === 0, (el) => el.font_semibold()).child(label))
        .child(cell(e ? tok(e.i) : "—"))
        .child(cell(e ? tok(e.o) : "—"))
        .child(cell(e ? tok(e.cw) : "—"))
        .child(cell(e ? tok(e.cr) : "—"))
        .child(cell(e ? tok(e.t) : "—", metric === "tokens"))
        .child(cell(e ? usd(e.c) : "—", metric === "cost"));
    });
    return card(t).flex_1().min_w(0).p(16).gap(8)
      .child(h_flex().h(30).items_center()
        .child(div().text_size(13.5).font_semibold().child("Recent days"))
        .child(div().flex_1())
        .child(div().text_size(11.5).text_color(t.dim).child(`last ${RECENT} days`)))
      .child(v_flex().child(head).children(rows));
  }

  render() {
    const t = theme();
    const wide = (this.p.width ?? 0) >= 980;
    return v_flex().gap(14)
      .child(this.tiles(t))
      .child(wide
        ? h_flex().gap(14).items_start().child(this.modelsCard(t)).child(this.recentCard(t))
        : v_flex().gap(14).child(this.modelsCard(t)).child(this.recentCard(t)));
  }
}

// The page. props: { mode: "embedded" (the Settings tab) | "standalone" (its own dialog),
// overlay (standalone: the dialog to close), width (expected content width), focus (a token:
// a new one takes the keyboard, for R) }.
export class UsagePage extends View {
  init(props, cx) {
    seed();
    this.p = props ?? {};
    this.compact = this.p.mode !== "standalone";
    this.mode = this.compact ? "embedded" : "standalone";
    this.width = store.prefs.width?.[this.mode] ?? this.p.width ?? (this.compact ? 713 : 1189);
    this.job = null; // { id, started, address, full } of a running refresh
    this.error = null;
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.focusToken = this.p.focus;
    // Numbers kept from an earlier open: compute what the first frame shows now, not in render.
    const h = this.heatProps();
    heatModel(h.source, h.metric, h.today);
    if (store.data) {
      stats(h.source, h.metric, h.today);
      models(h.source, store.prefs.range, h.metric, h.today);
      recent(h.source, h.today);
    }
    this.hover = cx.new(HoverLayer, {});
    this.heat = cx.new(HeatView, this.heatProps());
    this.body = cx.new(BodyView, this.bodyProps());
    this.keys = { heat: this.heatKey(), body: this.bodyKey() };
    cx.spawn(async (cx) => {
      const had = store.stamp;
      await loadData();
      this.width = store.prefs.width?.[this.mode] ?? this.width;
      // A refresh started before (by an earlier page) may still be running: follow it.
      const j = await readJson(JOB());
      const address = j?.state === "running" && Date.now() - (j.started ?? 0) < JOB_LIMIT
        ? j.address ?? (await this.findCollector())
        : null;
      if (address) this.job = { id: j.id, started: j.started, address };
      else if (!store.data || Date.now() - (store.data.updated ?? 0) > STALE) this.refresh(cx);
      this.sync(had !== store.stamp);
      cx.notify();
    });
    cx.timer.every(1000, (cx) => this.poll(cx));
  }

  update(props) {
    const before = this.p;
    this.p = props ?? {};
    if (this.p.focus !== this.focusToken) {
      this.focusToken = this.p.focus;
      this.handle.focus();
    }
    // `my-settings.refresh`: started by the next poll (update has no context to start it from).
    if (this.p.refresh && this.p.refresh !== before.refresh) this.wantRefresh = true;
  }

  heatProps() {
    return { source: store.prefs.source, metric: store.prefs.metric, today: todayKey(), g: geom(this.width, this.compact), hover: this.hover };
  }
  bodyProps() {
    return { source: store.prefs.source, metric: store.prefs.metric, range: store.prefs.range, today: todayKey(), width: this.width, ready: store.loaded };
  }
  heatKey() {
    const p = this.heatProps();
    return `${store.stamp}|${p.source}|${p.metric}|${p.today}|${p.g.cell}|${p.g.w}`;
  }
  bodyKey() {
    const p = this.bodyProps();
    return `${store.stamp}|${p.source}|${p.metric}|${p.range}|${p.today}|${p.width >= 980}`;
  }

  // Hands the child views new props when what they show changed (never from render). The
  // numbers are computed here, in a handler or task, so the renders only draw.
  sync(force) {
    const heat = this.heatKey(), body = this.bodyKey();
    if (force || heat !== this.keys.heat) {
      this.keys.heat = heat;
      const p = this.heatProps();
      heatModel(p.source, p.metric, p.today);
      this.hover.set_props({});
      this.heat.set_props(p);
    }
    if (force || body !== this.keys.body) {
      this.keys.body = body;
      const p = this.bodyProps();
      if (store.data) {
        stats(p.source, p.metric, p.today);
        models(p.source, p.range, p.metric, p.today);
        recent(p.source, p.today);
      }
      this.body.set_props(p);
    }
  }

  pick(field, value, cx) {
    store.prefs[field] = value;
    savePrefs(cx);
    this.sync();
    cx.notify();
  }

  resized(width, cx) {
    if (Math.abs(width - this.width) < 1) return;
    this.width = width;
    store.prefs.width = { ...store.prefs.width, [this.mode]: Math.round(width) };
    savePrefs(cx);
    this.sync();
    if (this.job) cx.notify(); // the progress bar's travel
  }

  // ---- refreshing ----

  // Reads the days since the last update (seconds); `full` re-reads every log (minutes).
  refresh(cx, full) {
    if (this.job) return;
    const job = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, started: Date.now(), address: null, full: Boolean(full) || !store.data };
    this.job = job;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await fs.mkdir(DIR(), { recursive: true }).catch(() => {});
        await fs.writeFile(JOB(), JSON.stringify({ id: job.id, started: job.started, state: "running" }));
        const r = await core(["run", "--bg", "--rm", "--json", "--no-parent", "--no-notify", "--cwd", DIR(), "--", "node", SCRIPT(), DIR(), job.id, ...(full ? ["--full"] : [])]);
        if (r.code !== 0) throw new Error(errorText(r) || "Couldn't start ccusage.");
        job.address = JSON.parse(r.stdout).address;
        // So a later page can follow it too (unless it already finished: npx alone takes seconds).
        const j = await readJson(JOB());
        if (j?.id === job.id && j.state === "running") await fs.writeFile(JOB(), JSON.stringify({ ...j, address: job.address }));
      } catch (e) {
        if (this.job === job) {
          this.job = null;
          this.error = String(e?.message ?? e);
          cx.notify();
        }
      }
    });
  }

  // A live collector terminal (it runs in the data folder), when job.json lacks its address:
  // the page that started it closed before `atc run` answered. None: that job never started.
  async findCollector() {
    try {
      const r = await core(["ls", "--json"]);
      const norm = (p) => String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
      const t = (JSON.parse(r.stdout).terminals ?? []).find((x) => x.state === "live" && norm(x.cwd) === norm(DIR()));
      return t?.address ?? null;
    } catch {
      return null;
    }
  }

  async settle(job, result) {
    if (this.job !== job) return;
    this.job = null;
    if (result?.state === "done") {
      await loadData();
      this.error = null;
    } else {
      this.error = result?.error || "ccusage stopped without a result.";
    }
    this.sync();
  }

  // Once a second: the day (past midnight the views move on), and while a refresh runs, its
  // result in job.json, else whether its terminal is still there. Redraws only on a change.
  poll(cx) {
    this.sync();
    if (this.wantRefresh) {
      this.wantRefresh = false;
      this.refresh(cx);
    }
    const job = this.job;
    if (!job || this.polling) return;
    this.polling = true;
    cx.spawn(async (cx) => {
      let changed = false;
      try {
        const j = await readJson(JOB());
        if (j?.id === job.id && j.state !== "running") {
          await this.settle(job, j);
          changed = true;
          return;
        }
        if (job.address && Date.now() - (job.checked ?? 0) > 4000) {
          job.checked = Date.now();
          const g = await core(["get", job.address, "--json"]).catch(() => null);
          let finished = false;
          try { finished = g?.code === 0 && JSON.parse(g.stdout).state === "finished"; } catch {}
          const gone = g && g.code !== 0 && /not_found|no terminal/.test(`${g.stdout}${g.stderr}`);
          if (finished || gone) {
            if (finished) core(["rm", job.address]).catch(() => {});
            const again = await readJson(JOB());
            await this.settle(job, again?.id === job.id ? again : null);
            changed = true;
            return;
          }
        }
        if (Date.now() - job.started > JOB_LIMIT) {
          if (job.address) core(["kill", job.address]).catch(() => {});
          await this.settle(job, { state: "error", error: "ccusage took too long and was stopped." });
          changed = true;
        }
      } finally {
        this.polling = false;
        if (changed) cx.notify();
      }
    });
  }

  key(e, cx) {
    if (e.keystroke === "r") {
      cx.stop_propagation();
      this.refresh(cx);
    } else if (e.keystroke === "shift-r") {
      cx.stop_propagation();
      this.refresh(cx, true);
    }
    // Esc goes on to the dialog, which closes.
  }

  // ---- drawing ----

  status(t) {
    if (this.job) {
      // The refresh button spins beside it.
      const text = this.job.full ? (store.data ? "Reading all logs…" : "Reading all your logs, a few minutes the first time…") : "Updating…";
      return div().text_size(12).text_color(t.muted).child(text);
    }
    if (this.error) {
      return div().id("us-error").max_w(320).truncate().text_size(12).text_color(t.blocked).tooltip(this.error)
        .child(store.data ? "Refresh failed · showing saved numbers" : "Refresh failed");
    }
    const d = store.data;
    if (!d?.updated) return div().text_size(12).text_color(t.dim).child(store.loaded ? "No numbers yet" : "");
    const when = dayKey(new Date(d.updated)) === todayKey() ? clock(d.updated) : `${shortDate(new Date(d.updated))} ${clock(d.updated)}`;
    const took = d.ms ? ` in ${Math.round(d.ms / 1000)} s` : "";
    const full = d.full ? ` All logs last read ${shortDate(new Date(d.full))}.` : "";
    return div().id("us-updated").text_size(12).text_color(t.dim)
      .tooltip(`Read by ${d.runner ?? "ccusage"}${took}.${full} Saved in data/usage-stats/ccusage.json`)
      .child(`Updated ${when}`);
  }

  // A thin bar that slides while ccusage runs (natively; nothing re-renders). Always 2 px tall.
  progress(t) {
    const track = div().h(2).w_full().relative().overflow_hidden().rounded(1);
    if (!this.job) return track;
    const w = Math.max(60, Math.round(this.width * 0.18));
    return track.bg(t.border).child(div().absolute().top(0).h(2).w(w).rounded(1).bg(t.working)
      .loop("left", { from: -w, to: this.width, period: 2400, easing: "ease-in-out" }));
  }

  toggles(t) {
    const p = store.prefs;
    const all = agentsInData();
    const others = all.filter((a) => a !== "claude" && a !== "codex");
    const sources = SOURCES.filter((s) => s.key !== "other" || others.length || p.source === "other").map((s) =>
      s.key === "other" ? { ...s, tip: others.map(agentName).join(", ") || "No other agents" }
        : s.key === "all" ? { ...s, tip: all.map(agentName).join(", ") || "Every agent ccusage finds" } : s);
    return h_flex().items_center().gap(12)
      .child(segmented(t, "us-src", sources, p.source, (k, cx) => this.pick("source", k, cx)))
      .child(div().flex_1())
      .child(segmented(t, "us-metric", [{ key: "tokens", label: "Tokens" }, { key: "cost", label: "Cost" }], p.metric, (k, cx) => this.pick("metric", k, cx)));
  }

  refreshButton(t) {
    return iconButton(t, "us-refresh", "us-refresh", this.job ? "Reading your logs…" : "Refresh (R) · Shift-click re-reads all logs",
      (e, cx) => this.refresh(cx, e.modifiers?.shift), Boolean(this.job));
  }

  content() {
    return v_flex().id("us-content").w_full().gap(14)
      .on_size_change((size, cx) => this.resized(size.width, cx))
      .child(this.heat)
      .child(this.body);
  }

  render() {
    const t = theme();
    const keys = (el) => el.track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx));
    if (this.compact) {
      return keys(v_flex().id("usage-page").w_full().gap(12))
        .child(h_flex().h(28).items_center().gap(8)
          .child(div().text_size(12).font_semibold().text_color(t.dim).child("USAGE & ACTIVITY"))
          .child(div().flex_1())
          .child(this.status(t))
          .child(this.refreshButton(t)))
        .child(this.toggles(t))
        .child(this.progress(t))
        .child(this.content());
    }
    const overlay = this.p.overlay;
    return keys(v_flex().id("usage-page").size_full().bg(t.popover).text_color(t.foreground).text_size(13))
      .child(v_flex().gap(12).px(20).pt(16).pb(12)
        .child(h_flex().items_center().gap(8)
          .child(svg(I("us-flame")).size(17).flex_none().text_color(t.muted))
          .child(div().text_size(17).font_bold().child("Usage & activity"))
          .child(div().flex_1())
          .child(this.status(t))
          .child(this.refreshButton(t))
          .when(Boolean(overlay), (el) => el.child(iconButton(t, "us-close", "us-x", "Close (Esc)", () => closeOverlay(overlay)))))
        .child(this.toggles(t)))
      .child(div().border_b(1).border_color(t.border).child(this.progress(t)))
      .child(v_flex().id("us-body").flex_1().min_h(0).overflow_y_scrollbar()
        .child(div().px(20).pt(16).pb(20).child(this.content())));
  }
}

// For measuring: the pure pieces, with data handed in.
export const bench = { store, series, stats, models, recent, heatModel, calendar, geom, HeatView, BodyView, HoverLayer, todayKey };
