// Settings > Skills: browse and search the skills.sh directory, check a skill (its audits, its
// SKILL.md) before installing it, and install or remove it for Claude Code and Codex.
//
// Left, a list: a search box (debounced, `owner:<github owner>` filters to one owner as
// `npx skills find --owner` does) over Trending · Hot · All time · Installed. Right, the selected
// skill: links, audits, the install / remove flow and its SKILL.md.
//
// Where things come from (all fetched in tasks; a render never waits on the network):
// - search: GET <SKILLS_API_URL or https://skills.sh>/api/search?q=&owner=&limit= (what the CLI's
//   `find` calls; public, no token);
// - leaderboards: the skills.sh pages themselves (/, /trending, /hot): their HTML carries the list
//   as `"initialSkills":[...]` inside Next.js payload strings. Best effort: parsed defensively,
//   cached 10 minutes in data/skills/board-<tab>.json; if the format changes the list says so and
//   search still works;
// - audits: GET https://skills.sh/api/v1/skills/audit/<source>/<skillId> (404: none yet);
// - SKILL.md: raw.githubusercontent.com (skills/<id>/, <id>/, the root), then the repo's tree;
//   a domain source's /.well-known/skills/<id>/SKILL.md; installed skills: the file on disk;
// - installed: ~/.claude/skills, ~/.agents/skills and ~/.codex/skills, merged by folder name.
//   The skills CLI records what it installed in ~/.agents/.skill-lock.json (or
//   $XDG_STATE_HOME/skills/): those get Remove, everything else is "Local" (Open folder only).
// Every request sends a plain `herdr/1.0` user agent and nothing about the person.
//
// Installing and removing run the Vercel `skills` CLI (`npx -y skills add|remove ...`) through
// skills-run.mjs in a background herdr-core terminal (exec stops at 30 s; npx plus a clone can take
// longer), with `--home` set to the folder this page lists (so the CLI installs where the page
// looks, whatever profile herdr-core's terminals start with). The page polls the job file it
// writes, shows the CLI's current step, then the result, with the full output a click away.
// DISABLE_TELEMETRY=1 when Herdr's own telemetry is off.
// One job at a time; data/skills/job.json lets a reopened Settings follow one still running.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list, VirtualListScrollHandle, TextView } from "gpui-base";
import { exec, hc, home, appHome, readTextFile, theme, telemetry, settings, window } from "herdr";
import * as fs from "fs/promises";

const I = (name) => `mods/my-settings/${name}.svg`;
const SPINNER = "mods/workspace-chrome/spinner.svg";
const MONO = "JetBrains Mono";
const HEADERS = { "User-Agent": "herdr/1.0" };
const SKILLS_SH = "https://skills.sh";
const PAGES = "https://www.skills.sh"; // skills.sh redirects pages here
const CACHE_MS = 10 * 60000;
const JOB_LIMIT = 6 * 60000; // skills-run.mjs stops the CLI after 5 minutes
const ROW_H = 46;
const MAX_MD = 80000;
const OWNER = /^[a-z0-9](?:[a-z0-9-]{0,38})$/i;

const TABS = [
  { id: "trending", label: "Trending", path: "/trending", window: "24h", note: "Installs in the last 24 hours" },
  { id: "hot", label: "Hot", path: "/hot", window: "1h", note: "Installs in the last hour" },
  { id: "all", label: "All time", path: "/", window: null, note: "All-time installs" },
  { id: "installed", label: "Installed" },
];
const AGENTS = [
  { id: "claude-code", label: "Claude Code", icon: "icons/claude.svg" },
  { id: "codex", label: "Codex", icon: "icons/codex.svg" },
];
// Where agents read global skills from, and whose they are.
const FOLDERS = [
  { dir: ".claude/skills", agent: "Claude Code" },
  { dir: ".agents/skills", agent: "Codex" },
  { dir: ".codex/skills", agent: "Codex" },
];

const slash = (p) => String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
const root = () => slash(appHome());
const DIR = () => `${root()}/data/skills`;
const CURRENT = () => `${DIR()}/job.json`;
const RUNNER = () => `${root()}/mods/my-settings/skills-run.mjs`;
const userHome = () => slash(home());
const tilde = (p) => { const h = userHome(); return p && h && p.toLowerCase().startsWith(h.toLowerCase()) ? `~${p.slice(h.length)}` : p; };
const alpha = (hex, aa) => (/^#[0-9a-f]{6}$/i.test(hex ?? "") ? `${hex}${aa}` : hex);
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s);
const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s ?? "");
const isRepo = (source) => /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(source ?? "");
const ownerOf = (source) => (isRepo(source) ? source.split("/")[0] : null);
const enc = (s) => String(s).split("/").map(encodeURIComponent).join("/");
const normSource = (s) => String(s ?? "").toLowerCase().replace(/^https?:\/\//, "").replace(/^wellknown\//, "").replace(/\.git$/, "").replace(/\/+$/, "");
const pageUrl = (it) => (isRepo(it.source) ? `${SKILLS_SH}/${enc(it.source)}/${enc(it.skillId)}` : `${SKILLS_SH}/site/${enc(it.source)}/${enc(it.skillId)}`);
const installSource = (it) => (isRepo(it.source) ? it.source : `https://${it.source}/`);
const trimZero = (s) => s.replace(/\.0$/, "");

// 1309632 -> 1.3M, 29012 -> 29k, 1234 -> 1.2k, 17 -> 17
export function fmtInstalls(n) {
  n = Number(n);
  if (!Number.isFinite(n)) return "";
  if (n >= 999500) { const m = n / 1e6; return `${m >= 99.95 ? Math.round(m) : trimZero(m.toFixed(1))}M`; }
  if (n >= 1000) { const k = n / 1e3; return k >= 9.95 ? `${Math.round(k)}k` : `${trimZero(k.toFixed(1))}k`; }
  return String(Math.max(0, Math.round(n)));
}

async function readJson(path) {
  try { const text = await readTextFile(path); return text ? JSON.parse(text) : null; } catch { return null; }
}

async function writeJson(path, value) {
  try {
    await fs.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true }).catch(() => {});
    await fs.writeFile(path, JSON.stringify(value));
  } catch {}
}

// A SKILL.md's frontmatter (top-level `key: value`, quoted, folded or literal) and the rest.
export function frontmatter(text) {
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text ?? "");
  if (!m) return { fm: {}, body: text ?? "" };
  const fm = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const k = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(lines[i]);
    if (!k) continue;
    let v = k[2].trim();
    const more = [];
    while (i + 1 < lines.length && (/^[ \t]+\S/.test(lines[i + 1]) || (lines[i + 1].trim() === "" && /^[>|]/.test(v)))) more.push(lines[++i].trim());
    if (/^[>|][+-]?$/.test(v)) v = v[0] === ">" ? more.join(" ") : more.join("\n");
    else {
      if (more.length) v = [v, ...more].join(" ");
      if (/^(["']).*\1$/s.test(v)) v = v[0] === '"' ? v.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, " ") : v.slice(1, -1).replace(/''/g, "'");
    }
    fm[k[1]] = v.replace(/\s+/g, " ").trim();
  }
  return { fm, body: text.slice(m[0].length) };
}

// The leaderboard skills.sh embeds in its page: `"initialSkills":[{"source",...}]`, inside a
// Next.js payload string (so its quotes are escaped), or plain if that ever changes. Walks the
// text as the JSON reads to find where the array ends; anything unexpected gives null.
export function parseBoard(html) {
  let at = html.indexOf('\\"initialSkills\\":[');
  let escaped = true;
  if (at < 0) { at = html.indexOf('"initialSkills":['); escaped = false; }
  if (at < 0) return null;
  const start = html.indexOf("[", at);
  // Fast: the entries are flat objects (an all-time entry's weekly counts end in "]", never "}]"),
  // so the first "}]" closes the list. Native searches and parses; a page that doesn't fit this
  // takes the careful walk below.
  try {
    const close = html.indexOf("}]", start);
    if (close > start) {
      const raw = html.slice(start, close + 2);
      const list = JSON.parse(escaped ? JSON.parse(`"${raw}"`) : raw);
      if (Array.isArray(list)) return list;
    }
  } catch {}
  const end = Math.min(html.length, start + 4000000);
  const out = [];
  let depth = 0, inStr = false, esc = false, j = start;
  for (; j < end; j++) {
    let c = html[j];
    if (escaped) {
      if (c === '"') return null; // the payload string ended before the array did
      if (c === "\\") {
        const n = html[++j];
        if (n === "u") { c = String.fromCharCode(parseInt(html.slice(j + 1, j + 5), 16)); j += 4; }
        else c = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" }[n] ?? n;
      }
    }
    out.push(c);
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") { if (--depth === 0) break; }
  }
  if (depth !== 0) return null;
  let list;
  try { list = JSON.parse(out.join("")); } catch { return null; }
  return Array.isArray(list) ? list : null;
}

// A directory entry as the list shows it; `window`: the installs count's period ("24h", "1h") or
// null for all-time.
function normalize(s, window) {
  if (!s || typeof s.source !== "string" || typeof s.skillId !== "string" || !s.source || !s.skillId) return null;
  const id = typeof s.id === "string" && s.id ? s.id : `${s.source}/${s.skillId}`;
  return { key: id, id, source: s.source, skillId: s.skillId, name: typeof s.name === "string" && s.name ? s.name : s.skillId, installs: Number.isFinite(Number(s.installs)) ? Number(s.installs) : null, window: window ?? null };
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((x) => x && !seen.has(x.key) && seen.add(x.key));
}

async function getText(url, headers) {
  try {
    const r = await fetch(url, { headers: { ...HEADERS, ...(headers ?? {}) } });
    return { status: r.status, ok: r.ok, text: r.ok ? await r.text() : "" };
  } catch (e) {
    return { status: 0, ok: false, text: "", error: String(e?.message ?? e) };
  }
}

// A SKILL.md, or null (missing, an HTML page that answered 200, empty).
async function getSkillMd(url) {
  const r = await getText(url);
  if (!r.ok || !r.text.trim() || /^\s*</.test(r.text)) return null;
  return r.text.length > MAX_MD ? `${r.text.slice(0, MAX_MD)}\n\n*… shortened here; the rest is on GitHub.*` : r.text;
}

const sameName = (a, b) => String(a ?? "").toLowerCase().replace(/[\s_]+/g, "-") === String(b ?? "").toLowerCase().replace(/[\s_]+/g, "-");

async function remotePreview(it) {
  const id = it.skillId;
  const cands = [];
  if (isRepo(it.source)) {
    const raw = `https://raw.githubusercontent.com/${it.source}/HEAD/`;
    cands.push({ url: `${raw}skills/${enc(id)}/SKILL.md`, dir: `skills/${id}` });
    cands.push({ url: `${raw}${enc(id)}/SKILL.md`, dir: id });
    cands.push({ url: `${raw}SKILL.md`, dir: "", strict: true });
  } else {
    cands.push({ url: `https://${it.source}/.well-known/skills/${enc(id)}/SKILL.md`, web: `https://${it.source}/.well-known/skills/${enc(id)}/` });
    cands.push({ url: `https://${it.source}/.well-known/agent-skills/${enc(id)}/SKILL.md`, web: `https://${it.source}/.well-known/agent-skills/${enc(id)}/` });
  }
  const found = (c, text) => {
    const p = frontmatter(text);
    const base = c.web ?? `https://github.com/${it.source}/blob/HEAD/${c.dir ? `${enc(c.dir)}/` : ""}`;
    const tree = isRepo(it.source) ? `https://github.com/${it.source}/tree/HEAD/${c.dir ? enc(c.dir) : ""}`.replace(/\/$/, "") : null;
    return { state: "ok", fm: p.fm, body: p.body, base, tree };
  };
  for (const c of cands) {
    const text = await getSkillMd(c.url);
    if (text == null) continue;
    if (c.strict && !sameName(frontmatter(text).fm.name, id) && !sameName(frontmatter(text).fm.name, it.name)) continue;
    return found(c, text);
  }
  // Elsewhere in the repo: its tree, for a folder named like the skill (one GitHub API call).
  if (isRepo(it.source)) {
    const r = await getText(`https://api.github.com/repos/${it.source}/git/trees/HEAD?recursive=1`, { Accept: "application/vnd.github+json" });
    let paths = [];
    try { paths = (JSON.parse(r.text).tree ?? []).map((x) => x?.path).filter((p) => typeof p === "string"); } catch {}
    const want = `/${id.toLowerCase()}/skill.md`;
    const hit = paths.filter((p) => `/${p.toLowerCase()}`.endsWith(want)).sort((a, b) => a.length - b.length)[0];
    if (hit) {
      const dir = hit.slice(0, -"/SKILL.md".length);
      const text = await getSkillMd(`https://raw.githubusercontent.com/${it.source}/HEAD/${enc(hit)}`);
      if (text != null) return found({ dir }, text);
    }
  }
  return { state: "none", message: isRepo(it.source) ? "Couldn't find its SKILL.md on GitHub." : "Couldn't read its SKILL.md." };
}

async function localPreview(it) {
  for (const p of it.places ?? []) {
    const text = await readTextFile(`${p.path}/SKILL.md`).catch(() => null);
    if (text == null) continue;
    const short = text.length > MAX_MD ? `${text.slice(0, MAX_MD)}\n\n*… shortened here.*` : text;
    const f = frontmatter(short);
    return { state: "ok", fm: f.fm, body: f.body, base: null, tree: null };
  }
  return { state: "none", message: "Couldn't read its SKILL.md." };
}

async function fetchAudits(it) {
  const r = await getText(`${SKILLS_SH}/api/v1/skills/audit/${enc(it.source)}/${encodeURIComponent(it.skillId)}`);
  if (r.status === 404) return { state: "none" };
  if (!r.ok) return { state: "error" };
  try {
    const list = (JSON.parse(r.text)?.audits ?? [])
      .filter((a) => a && typeof a.provider === "string")
      .map((a) => ({ provider: a.provider, status: String(a.status ?? "").toLowerCase(), summary: typeof a.summary === "string" ? a.summary : "", risk: typeof a.riskLevel === "string" ? a.riskLevel : null, at: a.auditedAt ?? null }));
    return list.length ? { state: "ok", list } : { state: "none" };
  } catch {
    return { state: "error" };
  }
}

// ---- the SKILL.md preview: a retained view, so the page re-rendering (typing, polling) never
// lays the markdown out again ----

class PreviewView extends View {
  init(props) { this.p = props ?? {}; }
  update(props) { this.p = props ?? {}; }

  render() {
    const t = theme();
    const p = this.p;
    const note = (children) => v_flex().size_full().items_center().justify_center().gap(8).px(24).children(children);
    if (!p.key) return div().size_full();
    if (p.state === "loading")
      return note([h_flex().gap(8).items_center().child(svg(SPINNER).size(12).text_color(t.muted).spin(900)).child(div().text_size(12.5).text_color(t.dim).child("Reading SKILL.md…"))]);
    if (p.state !== "ok")
      return note([div().text_size(12.5).text_color(t.dim).child(p.message || "No SKILL.md to show.")]);
    const base = p.base;
    return v_flex().size_full().min_h(0).px(18).pt(10).pb(2).text_size(13)
      .child(TextView.markdown(`sk-md-${p.key}`, p.body || "*Empty SKILL.md.*").flex_1().min_h(0).scrollable(true).selectable(true)
        .on_link_click((url, cx) => {
          const abs = /^https?:\/\//i.test(url) ? url : base && !/^[a-z]+:/i.test(url) && !url.startsWith("#") ? base + url.replace(/^\.\//, "") : null;
          if (abs) cx.open_url(abs);
        }));
  }
}

// ---- the page ----

export class SkillsPage extends View {
  init(props, cx) {
    this.p = props ?? {};
    this.tab = "trending";
    this.boards = {}; // tab -> { items, at, loading, error }
    this.typed = ""; // the search box, trimmed
    this.query = null; // the search in effect: { text, q, owner }
    this.results = null; // { key, items, loading, error, type, hint }
    this.searches = new Map(); // key -> results, for going back and forth
    this.installed = null; // { items, byName }
    this.sel = null; // the selected item
    this.info = {}; // item key -> { audits, preview, total }
    this.confirm = null; // { kind: "install" | "remove", key, agents: { "claude-code": true, codex: true } }
    this.job = null; // the running install / remove
    this.outcome = null; // the last finished one: { key, kind, ok, name, error, path, agents, log, show }
    this.apiBase = SKILLS_SH;
    this.lockPath = `${userHome()}/.agents/.skill-lock.json`;
    this.scroll = VirtualListScrollHandle.new();
    this.input = InputState.new({ placeholder: "Search skills.sh" });
    this.input.on("change", (_e, cx) => this.typing(cx));
    this.input.on("submit", (_e, cx) => { this.debounce?.cancel(); this.applySearch(cx); });
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    this.preview = cx.new(PreviewView, {});
    this.focusToken = this.p.focus;
    if (this.p.focus) this.input.focus();
    cx.spawn(async (cx) => {
      await this.readEnv();
      this.loadInstalled(cx);
    });
    this.loadBoard(this.tab, cx, false);
    this.resumeJob(cx);
  }

  update(props) {
    this.p = props ?? {};
    if (this.p.focus !== this.focusToken) {
      this.focusToken = this.p.focus;
      this.input.focus();
    }
  }

  // SKILLS_API_URL (a mirror, as the CLI honors it for search) and XDG_STATE_HOME (where the CLI
  // then keeps its lock file), from the environment agents and the CLI run in.
  async readEnv() {
    try {
      const r = await exec("node", ["-p", "JSON.stringify({api:process.env.SKILLS_API_URL||'',xdg:process.env.XDG_STATE_HOME||''})"]);
      const v = JSON.parse(r.stdout.trim());
      if (/^https?:\/\/[^\s/]+/i.test(v.api ?? "")) this.apiBase = v.api.trim().replace(/\/+$/, "");
      if (v.xdg) this.lockPath = `${slash(v.xdg)}/skills/.skill-lock.json`;
    } catch {}
  }

  // ---- lists ----

  list() {
    if (this.query) return this.results?.items ?? [];
    if (this.tab === "installed") return this.installed?.items ?? [];
    return this.boards[this.tab]?.items ?? [];
  }

  listId() {
    return this.query ? "search" : this.tab;
  }

  // The first row is selected when nothing is, so the right side is never empty for long.
  afterList(cx) {
    if (this.sel) return;
    const first = this.list()[0];
    if (first) this.select(first, cx);
  }

  pickTab(id, cx) {
    if (this.typed || this.query) {
      this.debounce?.cancel();
      this.input.set_value("");
      this.typed = "";
      this.query = null;
      this.results = null;
    }
    this.tab = id;
    if (id === "installed") this.loadInstalled(cx);
    else this.loadBoard(id, cx, false);
    this.afterList(cx);
    cx.notify();
  }

  loadBoard(id, cx, force) {
    const tab = TABS.find((x) => x.id === id);
    if (!tab?.path) return;
    const b = (this.boards[id] ??= { items: null, at: 0, loading: false, error: null });
    if (b.loading || (!force && b.items && Date.now() - b.at < CACHE_MS)) return;
    b.loading = true;
    b.error = null;
    cx.spawn(async (cx) => {
      try {
        if (!b.items) {
          const c = await readJson(`${DIR()}/board-${id}.json`);
          if (Array.isArray(c?.items) && c.items.length) {
            b.items = dedupe(c.items.map((s) => normalize(s, tab.window)));
            b.at = Number(c.at) || 0;
            this.afterList(cx);
            cx.notify();
            if (!force && Date.now() - b.at < CACHE_MS) return;
          }
        }
        const r = await getText(`${PAGES}${tab.path}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const raw = parseBoard(r.text);
        const items = dedupe((raw ?? []).map((s) => normalize(s, tab.window)));
        if (!items.length) throw new Error("format");
        b.items = items;
        b.at = Date.now();
        await writeJson(`${DIR()}/board-${id}.json`, { at: b.at, items: items.map(({ source, skillId, name, installs }) => ({ source, skillId, name, installs })) });
      } catch {
        b.error = b.items ? "Couldn't refresh the leaderboard." : "Couldn't load the leaderboard; search still works.";
      } finally {
        b.loading = false;
        this.afterList(cx);
        cx.notify();
      }
    });
  }

  loadInstalled(cx) {
    if (this.installedLoading) return;
    this.installedLoading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        this.installed = await this.scanInstalled();
      } catch {}
      this.installedLoading = false;
      // The selection is kept as an object: point it at the fresh entry, so its pane follows.
      if (this.sel?.places) this.sel = this.installed?.byName.get(this.sel.folder.toLowerCase()) ?? this.sel;
      this.afterList(cx);
      cx.notify();
    });
  }

  async scanInstalled() {
    const lock = (await readJson(this.lockPath))?.skills ?? {};
    const byName = new Map();
    const h = userHome();
    for (const f of FOLDERS) {
      const dir = `${h}/${f.dir}`;
      let names = [];
      try { names = await fs.readdir(dir); } catch { continue; }
      const found = await Promise.all(names.filter((n) => typeof n === "string" && !n.startsWith(".")).map(async (n) => {
        const text = await readTextFile(`${dir}/${n}/SKILL.md`).catch(() => null);
        return text == null ? null : { n, text };
      }));
      for (const x of found) {
        if (!x) continue;
        const k = x.n.toLowerCase();
        let e = byName.get(k);
        if (!e) {
          const { fm } = frontmatter(x.text.slice(0, 8000));
          const lk = lock[x.n] ?? Object.entries(lock).find(([name]) => name.toLowerCase() === k)?.[1] ?? null;
          e = { key: `installed:${k}`, folder: x.n, name: fm.name || x.n, description: fm.description || "", places: [], agents: [], lock: lk && typeof lk.source === "string" ? lk : null };
          e.source = e.lock ? e.lock.source.replace(/^wellknown\//, "") : null;
          e.skillId = x.n;
          e.local = !e.lock;
          byName.set(k, e);
        }
        e.places.push({ dir: f.dir, path: `${dir}/${x.n}`, agent: f.agent });
        if (!e.agents.includes(f.agent)) e.agents.push(f.agent);
      }
    }
    const items = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    return { items, byName };
  }

  // The installed copy of a directory entry: same name, and the CLI installed it from the same source.
  installedOf(it) {
    if (!this.installed) return null;
    if (it.places) return this.installed.byName.get(it.folder.toLowerCase()) ?? null;
    const e = this.installed.byName.get(it.skillId.toLowerCase()) ?? this.installed.byName.get(String(it.name).toLowerCase());
    return e && e.lock && normSource(e.lock.source) === normSource(it.source) ? e : null;
  }

  // A different skill already installed under this name (installing would replace it).
  clashOf(it) {
    if (!this.installed || it.places) return null;
    const e = this.installed.byName.get(it.skillId.toLowerCase()) ?? this.installed.byName.get(String(it.name).toLowerCase());
    return e && !(e.lock && normSource(e.lock.source) === normSource(it.source)) ? e : null;
  }

  // ---- search ----

  typing(cx) {
    const text = this.input.value().trim();
    const was = this.typed;
    this.typed = text;
    this.debounce?.cancel();
    this.debounce = cx.timer.after(300, (cx) => this.applySearch(cx));
    if (Boolean(was) !== Boolean(text)) cx.notify();
  }

  // "owner:vercel-labs react" -> { q: "react", owner: "vercel-labs" }
  parseQuery(text) {
    let owner = null;
    const words = [];
    for (const w of text.split(/\s+/).filter(Boolean)) {
      const m = /^owner:(.*)$/i.exec(w);
      if (m) owner = m[1].toLowerCase();
      else words.push(w);
    }
    return { text, q: words.join(" "), owner };
  }

  applySearch(cx) {
    this.debounce = null;
    const text = this.typed;
    if (!text) {
      if (this.query) {
        this.query = null;
        this.results = null;
        this.afterList(cx);
        cx.notify();
      }
      return;
    }
    const qy = this.parseQuery(text);
    this.query = qy;
    if (qy.owner !== null && !OWNER.test(qy.owner)) {
      this.results = { key: null, items: [], hint: "owner: takes a GitHub owner, like owner:vercel-labs" };
      cx.notify();
      return;
    }
    // Only an owner: the API wants a query, and the owner's own name lists their skills.
    const q = qy.q.length >= 2 ? qy.q : qy.owner && !qy.q ? qy.owner : qy.q;
    if (q.length < 2) {
      this.results = { key: null, items: [], hint: "Type at least 2 characters." };
      cx.notify();
      return;
    }
    const key = `${qy.owner ?? ""}|${q.toLowerCase()}`;
    if (this.results?.key === key && !this.results.error) return cx.notify();
    const cached = this.searches.get(key);
    if (cached && Date.now() - cached.at < CACHE_MS) {
      this.results = cached;
      cx.notify();
      return;
    }
    const res = { key, owner: qy.owner, items: this.results?.items ?? null, loading: true, error: null, type: null, at: 0 };
    this.results = res;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const qs = `q=${encodeURIComponent(q)}&limit=60${qy.owner ? `&owner=${encodeURIComponent(qy.owner)}` : ""}`;
        const r = await getText(`${this.apiBase}/api/search?${qs}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = JSON.parse(r.text);
        res.items = dedupe((j.skills ?? []).map((s) => normalize(s, null)));
        res.type = j.searchType ?? null;
        res.at = Date.now();
        this.searches.set(key, res);
        if (this.searches.size > 40) this.searches.delete(this.searches.keys().next().value);
      } catch {
        res.items = [];
        res.error = "Search didn't answer. Check your connection and try again.";
      }
      res.loading = false;
      if (this.results === res) cx.notify();
    });
  }

  searchOwner(owner, cx) {
    this.input.set_value(`owner:${owner}`);
    this.typed = `owner:${owner}`;
    this.debounce?.cancel();
    this.applySearch(cx);
    this.input.focus();
  }

  clearSearch(cx) {
    this.debounce?.cancel();
    this.input.set_value("");
    this.typed = "";
    this.applySearch(cx);
    this.input.focus();
  }

  // ---- the selected skill ----

  select(it, cx) {
    if (this.sel?.key === it.key) return;
    this.sel = it;
    if (this.confirm && this.confirm.key !== it.key) this.confirm = null;
    this.ensureInfo(it, cx);
    this.syncPreview();
    cx.notify();
  }

  ensureInfo(it, cx) {
    if (this.info[it.key]) return;
    const keys = Object.keys(this.info);
    if (keys.length > 120) for (const k of keys.slice(0, 40)) delete this.info[k];
    const info = (this.info[it.key] = { audits: null, preview: { state: "loading" }, total: null });
    const changed = (cx) => {
      if (this.sel?.key !== it.key) return;
      this.syncPreview();
      cx.notify();
    };
    cx.spawn(async (cx) => {
      info.preview = it.places ? await localPreview(it) : await remotePreview(it);
      changed(cx);
    });
    if (it.source) {
      info.audits = { state: "loading" };
      cx.spawn(async (cx) => {
        info.audits = await fetchAudits(it);
        changed(cx);
      });
      // Trending / Hot count a window and installed skills carry no count: the all-time number.
      if (it.window || it.installs == null) cx.spawn(async (cx) => {
        info.total = await this.lookupTotal(it);
        changed(cx);
      });
    }
  }

  async lookupTotal(it) {
    const owner = ownerOf(it.source);
    const q = it.skillId.length >= 2 ? it.skillId : it.name;
    const r = await getText(`${this.apiBase}/api/search?q=${encodeURIComponent(q)}&limit=25${owner ? `&owner=${encodeURIComponent(owner.toLowerCase())}` : ""}`);
    try {
      const want = `${normSource(it.source)}/${it.skillId.toLowerCase()}`;
      const hit = (JSON.parse(r.text).skills ?? []).find((s) => `${normSource(s.source)}/${String(s.skillId).toLowerCase()}` === want);
      return hit && Number.isFinite(Number(hit.installs)) ? Number(hit.installs) : null;
    } catch {
      return null;
    }
  }

  syncPreview() {
    const it = this.sel;
    const pv = it ? this.info[it.key]?.preview : null;
    const p = it ? { key: it.key, state: pv?.state ?? "loading", body: pv?.body ?? "", base: pv?.base ?? null, message: pv?.message ?? null } : {};
    const sig = `${p.key}|${p.state}|${p.body?.length ?? 0}`;
    if (sig === this.previewSig) return;
    this.previewSig = sig;
    this.preview.set_props(p);
  }

  openFolder(it, cx) {
    const path = it.places?.[0]?.path;
    if (!path) return;
    const os = window()?.platform;
    cx.spawn(async () => {
      try {
        if (os === "windows") await exec("explorer.exe", [path.replace(/\//g, "\\")]);
        else await exec(os === "macos" ? "open" : "xdg-open", [path]);
      } catch {}
    });
  }

  // ---- install / remove ----

  noTelemetry() {
    const tm = telemetry();
    return tm?.setting === false || settings()?.telemetry === false;
  }

  installArgs(it, agents) {
    const args = ["add", installSource(it), "-s", it.skillId, "-g", "-a", ...agents, "-y"];
    if (isRepo(it.source)) args.push("--json"); // the CLI has no JSON output for well-known sources
    return args;
  }

  removeArgs(e) {
    return ["remove", "-s", e.folder, "-g", "-y"];
  }

  commandText(args) {
    return `${this.noTelemetry() ? "DISABLE_TELEMETRY=1 " : ""}npx -y skills ${args.join(" ")}`;
  }

  askInstall(it, cx) {
    this.confirm = { kind: "install", key: it.key, agents: { "claude-code": true, codex: true } };
    this.copied = null;
    if (this.outcome?.key === it.key) this.outcome = null;
    cx.notify();
  }

  askRemove(it, cx) {
    this.confirm = { kind: "remove", key: it.key };
    this.copied = null;
    if (this.outcome?.key === it.key) this.outcome = null;
    cx.notify();
  }

  startJob(kind, it, args, cx) {
    if (this.job) return;
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const file = `${DIR()}/jobs/${id}.json`;
    const agents = kind === "install" ? AGENTS.filter((a) => this.confirm?.agents?.[a.id]).map((a) => a.label) : [];
    const job = { id, kind, key: it.key, name: kind === "remove" ? (this.installedOf(it)?.folder ?? it.name) : it.name, file, log: `${DIR()}/jobs/${id}.log`, started: Date.now(), line: kind === "install" ? "Fetching the skill…" : "Running the skills CLI…", agents, address: null, item: it };
    this.job = job;
    this.confirm = null;
    this.outcome = null;
    const noTel = this.noTelemetry();
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await fs.mkdir(`${DIR()}/jobs`, { recursive: true }).catch(() => {});
        await this.pruneJobs();
        await fs.writeFile(file, JSON.stringify({ id, state: "running", line: job.line }));
        const r = await hc(["run", "--bg", "--rm", "--json", "--no-parent", "--no-notify", "--name", `skills-${id}`.slice(0, 32), "--cwd", DIR(), "--",
          "node", RUNNER(), file, "--home", userHome(), ...(noTel ? ["--no-telemetry"] : []), "--", ...args]);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || "Couldn't start the skills CLI.");
        job.address = JSON.parse(r.stdout).address ?? null;
        await writeJson(CURRENT(), job);
        if (this.job === job) this.jobTimer = cx.timer.every(700, (cx) => this.pollJob(cx));
      } catch (e) {
        await this.settle(job, { state: "error", error: String(e?.message ?? e) }, cx);
        cx.notify();
      }
    });
  }

  // Keeps the last few jobs' files (their output), drops older ones.
  async pruneJobs() {
    try {
      const files = (await fs.readdir(`${DIR()}/jobs`)).filter((f) => /\.(json|log)$/.test(f)).sort();
      const ids = [...new Set(files.map((f) => f.replace(/\.(json|log)$/, "")))];
      for (const old of ids.slice(0, Math.max(0, ids.length - 8))) {
        for (const ext of [".json", ".log"]) await fs.unlink(`${DIR()}/jobs/${old}${ext}`).catch(() => {});
      }
    } catch {}
  }

  // A job a closed Settings left running: follow it again.
  resumeJob(cx) {
    cx.spawn(async (cx) => {
      const cur = await readJson(CURRENT());
      if (!cur?.file || !cur.started || Date.now() - cur.started > JOB_LIMIT || this.job) return;
      const j = await readJson(cur.file);
      if (j?.state !== "running") { await fs.unlink(CURRENT()).catch(() => {}); return; }
      this.job = { ...cur, line: j.line || cur.line };
      this.jobTimer = cx.timer.every(700, (cx) => this.pollJob(cx));
      if (cur.item?.key) { this.sel = null; this.select(cur.item, cx); }
      cx.notify();
    });
  }

  pollJob(cx) {
    const job = this.job;
    if (!job || this.polling) return;
    this.polling = true;
    cx.spawn(async (cx) => {
      let changed = false;
      try {
        const j = await readJson(job.file);
        if (j?.state && j.state !== "running") {
          await this.settle(job, j, cx);
          changed = true;
          return;
        }
        if (j?.line && j.line !== job.line) { job.line = j.line; changed = true; }
        if (job.address && Date.now() - (job.checked ?? 0) > 3000) {
          job.checked = Date.now();
          const g = await hc(["get", job.address, "--json"]).catch(() => null);
          let finished = false;
          try { finished = g?.code === 0 && JSON.parse(g.stdout).state !== "live"; } catch {}
          const gone = g && g.code !== 0;
          if (finished || gone) {
            const again = await readJson(job.file);
            await this.settle(job, again?.state && again.state !== "running" ? again : { state: "error", error: "The skills CLI stopped without a result." }, cx);
            changed = true;
            return;
          }
        }
        if (Date.now() - job.started > JOB_LIMIT) {
          if (job.address) await hc(["kill", job.address]).catch(() => null);
          await this.settle(job, { state: "error", error: "It took too long and was stopped." }, cx);
          changed = true;
        }
      } finally {
        this.polling = false;
        if (changed) cx.notify();
      }
    });
  }

  async settle(job, j, cx) {
    if (this.job !== job) return;
    this.job = null;
    this.jobTimer?.cancel();
    this.jobTimer = null;
    const log = (await readTextFile(job.log).catch(() => null)) ?? "";
    const r = Array.isArray(j?.result) ? j.result[0] : null;
    this.outcome = {
      key: job.key, kind: job.kind, name: job.name, ok: j?.state === "done", error: j?.error ?? null,
      path: typeof r?.path === "string" ? slash(r.path) : null, agents: Array.isArray(r?.agents) ? r.agents : job.agents,
      log: log.length > 16000 ? log.slice(-16000) : log, show: false,
    };
    await fs.unlink(CURRENT()).catch(() => {});
    if (job.address) hc(["rm", job.address]).catch(() => null);
    this.loadInstalled(cx);
  }

  // ---- pieces ----

  heading(t, text) {
    return div().text_size(11).font_semibold().text_color(t.dim).child(text.toUpperCase());
  }

  spinner(t, size = 12) {
    return svg(SPINNER).size(size).flex_none().text_color(t.muted).spin(900);
  }

  button(t, id, label, onClick, opts = {}) {
    const { kind, icon, disabled, tip } = opts;
    return h_flex().id(id).flex_none().h(28).px(10).gap(6).items_center().rounded(6).text_size(12.5)
      .when(kind === "primary", (el) => el.bg(t.accent).text_color(t.accent_foreground).font_medium())
      .when(kind === "danger", (el) => el.border_1().border_color(alpha(t.blocked, "99")).text_color(t.blocked))
      .when(!kind, (el) => el.border_1().border_color(t.border).bg(t.raised).text_color(t.foreground))
      .when(Boolean(disabled), (el) => el.opacity(0.45))
      .when(!disabled, (el) => el.cursor_pointer().hover((s) => (kind === "primary" ? s.opacity(0.9) : s.bg(t.hover))).on_click(onClick))
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .when(Boolean(icon), (el) => el.child(svg(I(icon)).size(13).flex_none()))
      .child(label);
  }

  pill(t, label, color) {
    const c = color ?? t.muted;
    return div().flex_none().px(6).py(0.5).rounded(5).border_1().border_color(color ? alpha(c, "66") : t.border)
      .when(Boolean(color), (el) => el.bg(alpha(c, "18")))
      .text_size(10.5).font_medium().text_color(c).child(label);
  }

  statusColor(t, status) {
    return status === "pass" ? t.ansi2 : status === "warn" ? t.ansi3 : status === "fail" ? t.blocked : t.dim;
  }

  riskText(risk) {
    if (!risk) return null;
    const r = risk.toUpperCase();
    return r === "SAFE" ? "Safe" : r === "NONE" ? "No risk" : `${cap(r)} risk`;
  }

  // ---- left: search, tabs, list ----

  searchBox(t) {
    return h_flex().id("sk-search").h(32).px(10).gap(8).items_center().rounded(7).border_1()
      .border_color(this.inputFocused ? t.accent : t.input).bg(t.background).cursor_text()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => this.input.focus())
      .child(div().id("sk-search-icon").flex_none().tooltip("owner:vercel-labs react searches one owner's skills").child(svg(I("sk-search")).size(14).text_color(t.dim)))
      .child(Input.new(this.input).flex_1().min_w(0).h_full().text_size(13).text_color(t.foreground))
      .when(Boolean(this.typed), (el) => el.child(
        div().id("sk-search-clear").flex_none().size(18).rounded(4).flex().items_center().justify_center().cursor_pointer()
          .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => this.clearSearch(cx)).child(svg(I("us-x")).size(12))));
  }

  segmented(t) {
    const searching = Boolean(this.query || this.typed);
    return h_flex().p(2).gap(2).rounded(8).border_1().border_color(t.border).bg(t.background)
      .children(TABS.map((tab) => {
        const on = !searching && tab.id === this.tab;
        return div().id(`sk-tab-${tab.id}`).flex_1().flex().justify_center().py(3).rounded(6).border_1().text_size(12).cursor_pointer()
          .border_color(on ? t.border : "#00000000")
          .when(on, (el) => el.bg(t.raised).text_color(t.foreground))
          .when(!on, (el) => el.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
          .on_click((_e, cx) => this.pickTab(tab.id, cx))
          .child(tab.label);
      }));
  }

  row(t, it) {
    const sel = this.sel?.key === it.key;
    let pill = null;
    let sub = it.source;
    if (it.places) {
      if (it.local) { pill = this.pill(t, "Local"); sub = it.agents.join(" · "); }
    } else if (this.installedOf(it)) pill = this.pill(t, "Installed", t.accent);
    return h_flex().h(ROW_H).px(12).gap(10).items_center()
      .bg(sel ? t.raised : "#00000000")
      .hover((s) => s.bg(sel ? t.raised : t.hover))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(h_flex().gap(6).items_center().min_w(0)
          .child(div().min_w(0).truncate().text_size(13).text_color(t.foreground).when(sel, (el) => el.font_medium()).child(it.name))
          .when(Boolean(pill), (el) => el.child(pill)))
        .child(div().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(sub ?? "")))
      .when(it.installs != null, (el) => el.child(div().flex_none().text_size(12).text_color(t.muted).child(fmtInstalls(it.installs))));
  }

  listState(t) {
    const center = (children) => v_flex().size_full().items_center().justify_center().gap(10).px(20).children(children);
    const text = (s, color) => div().text_size(12.5).line_height("18px").text_color(color ?? t.dim).text_center().child(s);
    const loading = (s) => center([h_flex().gap(8).items_center().child(this.spinner(t)).child(text(s))]);
    if (this.query) {
      const r = this.results;
      if (r?.hint) return center([text(r.hint)]);
      if (!r || (r.loading && !r.items?.length)) return loading("Searching…");
      if (r.error) return center([text(r.error), this.button(t, "sk-search-retry", "Try again", (_e, cx) => { this.results = null; this.applySearch(cx); })]);
      return center([text(`No skills match “${this.query.q || this.query.owner}”${this.query.owner && this.query.q ? ` from ${this.query.owner}` : ""}.`)]);
    }
    if (this.tab === "installed") {
      if (!this.installed) return loading("Reading your skills…");
      return center([text("No skills installed yet. Find one in Trending or search above.")]);
    }
    const b = this.boards[this.tab];
    if (b?.error) return center([text(b.error), this.button(t, "sk-board-retry", "Try again", (_e, cx) => this.loadBoard(this.tab, cx, true))]);
    return loading("Loading the leaderboard…");
  }

  footer(t) {
    let label = "";
    let busy = false;
    let refresh = null;
    if (this.query) {
      const r = this.results;
      busy = Boolean(r?.loading);
      if (r?.items && !r.hint && !r.error) label = `${r.items.length} result${r.items.length === 1 ? "" : "s"}${r.owner ? ` from ${r.owner}` : ""}`;
    } else if (this.tab === "installed") {
      busy = Boolean(this.installedLoading);
      const n = this.installed?.items.length ?? 0;
      label = this.installed ? `${n} skill${n === 1 ? "" : "s"} in ~/.claude, ~/.agents, ~/.codex` : "";
      refresh = (_e, cx) => this.loadInstalled(cx);
    } else {
      const b = this.boards[this.tab];
      busy = Boolean(b?.loading);
      label = b?.items ? (b.error && !busy ? b.error : TABS.find((x) => x.id === this.tab).note) : "";
      refresh = (_e, cx) => this.loadBoard(this.tab, cx, true);
    }
    if (this.job) {
      label = `${this.job.kind === "remove" ? "Removing" : "Installing"} ${this.job.name}…`;
      busy = true;
    }
    return h_flex().flex_none().h(30).pl(12).pr(6).gap(6).items_center().border_t(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(label))
      .when(busy, (el) => el.child(this.spinner(t, 11)))
      .when(Boolean(refresh) && !busy, (el) => el.child(
        div().id("sk-refresh").size(22).flex_none().rounded(5).flex().items_center().justify_center().cursor_pointer()
          .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Refresh")
          .on_click(refresh).child(svg(I("us-refresh")).size(12))));
  }

  listPane(t) {
    const items = this.list();
    const id = `sk-list-${this.listId()}`;
    const body = items.length
      ? v_flex().flex_1().min_h(0).relative()
        .child(v_virtual_list(id, items.length, ROW_H, (i) => items[i].key, (range) => items.slice(range.start, range.end).map((it) => this.row(t, it)))
          .size_full().track_scroll(this.scroll)
          .on_item_click((key, cx) => {
            const it = this.list().find((x) => x.key === key);
            if (it) this.select(it, cx);
          }))
        .child(Scrollbar.vertical(id).absolute().inset_0())
      : div().flex_1().min_h(0).child(this.listState(t));
    return v_flex().w(286).flex_none().h_full().border_r(1).border_color(t.border)
      .child(v_flex().flex_none().p(10).gap(8).border_b(1).border_color(t.border).child(this.searchBox(t)).child(this.segmented(t)))
      .child(body)
      .child(this.footer(t));
  }

  // ---- right: the selected skill ----

  installsLine(it, info) {
    const total = it.window ? info?.total : it.installs ?? info?.total;
    const parts = [];
    if (total != null) parts.push(`${fmtInstalls(total)} installs`);
    if (it.window && it.installs != null) parts.push(`${fmtInstalls(it.installs)} in the last ${it.window === "1h" ? "hour" : "24 hours"}`);
    return parts;
  }

  header(t, it, info, entry) {
    const pv = info?.preview;
    const description = it.description || pv?.fm?.description || "";
    const owner = ownerOf(it.source);
    const sub = div().min_w(0).truncate().text_size(12.5).text_color(t.dim)
      .child([it.source ?? "Local skill", ...this.installsLine(it, info)].join("  ·  "));
    const more = owner && !(this.query?.owner === owner.toLowerCase() && !this.query.q)
      ? div().id("sk-more-owner").flex_none().text_size(12).text_color(t.accent).cursor_pointer().hover((s) => s.opacity(0.8))
        .on_click((_e, cx) => this.searchOwner(owner.toLowerCase(), cx)).child(`More from ${owner}`)
      : null;
    const agentsTip = entry?.agents?.length ? `For ${entry.agents.join(" and ")}` : null;

    const busyHere = this.job?.key === it.key;
    const otherBusy = Boolean(this.job) && !busyHere;
    const buttons = h_flex().gap(6).items_center().pt(4);
    // The skill's own folder when known (where its SKILL.md was found, or the CLI's record), else the repo.
    const lockDir = typeof entry?.lock?.skillPath === "string" ? entry.lock.skillPath.replace(/\/?SKILL\.md$/i, "") : null;
    const gh = pv?.tree ?? (isRepo(it.source) && lockDir !== null ? `https://github.com/${it.source}/tree/HEAD/${enc(lockDir)}`.replace(/\/$/, "") : `https://github.com/${it.source}`);
    if (isRepo(it.source)) buttons.child(this.button(t, "sk-gh", "GitHub", (_e, cx) => cx.open_url(gh), { icon: "sk-github" }));
    if (it.source) buttons.child(this.button(t, "sk-page", "skills.sh", (_e, cx) => cx.open_url(pageUrl(it)), { icon: "sk-external" }));
    if (entry?.places) buttons.child(this.button(t, "sk-open", "Open folder", (_e, cx) => this.openFolder(entry, cx), { icon: "sk-folder" }));
    buttons.child(div().flex_1());
    if (!busyHere && this.confirm?.key !== it.key) {
      if (entry?.lock) buttons.child(this.button(t, "sk-remove", "Remove", (_e, cx) => this.askRemove(it, cx), { kind: "danger", disabled: otherBusy, tip: otherBusy ? "Another install is running" : null }));
      else if (!entry && it.source) buttons.child(this.button(t, "sk-install", "Install", (_e, cx) => this.askInstall(it, cx), { kind: "primary", icon: "sk-download", disabled: otherBusy, tip: otherBusy ? "Another install is running" : null }));
    }
    return v_flex().flex_none().px(18).pt(16).pb(14).gap(6).border_b(1).border_color(t.border)
      .child(h_flex().gap(8).items_center().min_w(0)
        .child(div().min_w(0).truncate().text_size(17).font_semibold().text_color(t.foreground).child(it.name))
        .when(Boolean(entry), (el) => el.child(div().id("sk-pill").flex_none().when(Boolean(agentsTip), (p) => p.tooltip(agentsTip))
          .child(entry.local ? this.pill(t, "Local") : this.pill(t, "Installed", t.accent))))
        .child(div().flex_1())
        .when(Boolean(more), (el) => el.child(more)))
      .child(sub)
      .when(Boolean(description), (el) => el.child(div().text_size(12.5).line_height("18px").text_color(t.muted).child(clip(description, 190))))
      .child(buttons);
  }

  auditChip(t, a, i) {
    const color = this.statusColor(t, a.status);
    const risk = this.riskText(a.risk);
    const when = a.at ? new Date(a.at) : null;
    const tip = [a.summary, when && !isNaN(when) ? `Audited ${when.toLocaleDateString()}` : null].filter(Boolean).join("\n");
    return h_flex().id(`sk-audit-${i}`).flex_none().h(24).px(8).gap(6).items_center().rounded(6).border_1().border_color(t.border).bg(t.background)
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .child(div().size(7).flex_none().rounded(4).bg(color))
      .child(div().text_size(12).text_color(t.foreground).child(a.provider))
      .child(div().text_size(12).font_medium().text_color(color).child(cap(a.status) || "?"))
      .when(Boolean(risk), (el) => el.child(div().text_size(12).text_color(t.dim).child(risk)));
  }

  audits(t, info) {
    const a = info?.audits;
    let body;
    if (!a || a.state === "loading") body = h_flex().gap(8).items_center().child(this.spinner(t)).child(div().text_size(12.5).text_color(t.dim).child("Checking audits…"));
    else if (a.state === "none") body = div().text_size(12.5).text_color(t.dim).child("Not audited yet.");
    else if (a.state === "error") body = div().text_size(12.5).text_color(t.dim).child("Couldn't load its audits.");
    else body = h_flex().flex_wrap().gap(6).children(a.list.map((x, i) => this.auditChip(t, x, i)));
    return v_flex().flex_none().px(18).py(12).gap(8).border_b(1).border_color(t.border)
      .child(this.heading(t, "Audits"))
      .child(body);
  }

  // The audit verdicts in one line: "3 passed · 1 warning · 1 failed".
  auditSummary(t, info) {
    const a = info?.audits;
    if (!a || a.state === "loading") return h_flex().gap(6).items_center().child(this.spinner(t, 11)).child(div().text_size(12).text_color(t.dim).child("Checking audits…"));
    if (a.state !== "ok") return div().text_size(12).text_color(t.dim).child(a.state === "none" ? "Not audited yet." : "Audits unavailable.");
    const n = (s) => a.list.filter((x) => x.status === s).length;
    const parts = [["pass", n("pass"), "passed"], ["warn", n("warn"), n("warn") === 1 ? "warning" : "warnings"], ["fail", n("fail"), "failed"]].filter(([, c]) => c > 0);
    const row = h_flex().gap(6).items_center().text_size(12);
    parts.forEach(([s, c, word], i) => {
      if (i) row.child(div().text_color(t.dim).child("·"));
      row.child(div().text_color(this.statusColor(t, s)).child(`${c} ${word}`));
    });
    return row;
  }

  checkbox(t, id, label, icon, on, onClick) {
    return h_flex().id(id).gap(7).items_center().cursor_pointer().on_click(onClick)
      .child(div().size(16).flex_none().rounded(4).flex().items_center().justify_center()
        .when(on, (el) => el.bg(t.accent).child(svg(I("check")).size(11).text_color(t.accent_foreground)))
        .when(!on, (el) => el.border_1().border_color(t.input).hover((s) => s.border_color(t.accent))))
      .child(image(icon).size(14).flex_none())
      .child(div().text_size(12.5).text_color(t.foreground).child(label));
  }

  commandBox(t, id, cmd) {
    return v_flex().gap(5)
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(11.5).text_color(t.dim).child("Command"))
        .child(div().id(`${id}-copy`).text_size(11.5).text_color(t.accent).cursor_pointer().hover((s) => s.opacity(0.8))
          .on_click((_e, cx) => { cx.write_to_clipboard(cmd); this.copied = id; cx.notify(); })
          .child(this.copied === id ? "Copied" : "Copy")))
      .child(div().id(id).px(9).py(7).rounded(6).border_1().border_color(t.border).bg(t.surface)
        .font_family(MONO).text_size(11.5).line_height("17px").text_color(t.muted).child(cmd));
  }

  card(t, children) {
    return div().flex_none().px(18).py(12).border_b(1).border_color(t.border)
      .child(v_flex().w_full().p(12).gap(10).rounded(8).border_1().border_color(t.border).bg(t.background).children(children));
  }

  installConfirm(t, it, info) {
    const c = this.confirm;
    const picked = AGENTS.filter((a) => c.agents[a.id]).map((a) => a.id);
    const clash = this.clashOf(it);
    const cancel = this.button(t, "sk-ic-cancel", "Cancel", (_e, cx) => { this.confirm = null; cx.notify(); });
    const go = this.button(t, "sk-ic-go", clash ? "Replace and install" : "Install", (_e, cx) => this.startJob("install", it, this.installArgs(it, picked), cx), { kind: "primary", disabled: !picked.length });
    return this.card(t, [
      div().text_size(13.5).font_semibold().text_color(t.foreground).child(`Install ${it.name}`),
      h_flex().gap(16).items_center()
        .child(div().w(46).text_size(12).text_color(t.dim).child("For"))
        .children(AGENTS.map((a) => this.checkbox(t, `sk-ic-${a.id}`, a.label, a.icon, Boolean(c.agents[a.id]), (_e, cx) => { c.agents[a.id] = !c.agents[a.id]; cx.notify(); }))),
      h_flex().gap(16).items_center()
        .child(div().w(46).text_size(12).text_color(t.dim).child("Audits"))
        .child(this.auditSummary(t, info)),
      this.commandBox(t, "sk-ic-cmd", this.commandText(this.installArgs(it, picked.length ? picked : ["…"]))),
      ...(clash ? [h_flex().gap(7).items_start()
        .child(svg(I("sk-alert")).size(14).flex_none().mt(1).text_color(t.ansi3))
        .child(div().flex_1().min_w(0).text_size(12).line_height("17px").text_color(t.ansi3)
          .child(`${clash.folder} is already installed${clash.lock ? ` from ${clash.lock.source.replace(/^wellknown\//, "")}` : " as a local skill"}. Installing this one replaces it for the agents picked.`))] : []),
      h_flex().gap(6).justify_end().child(cancel).child(go),
    ]);
  }

  removeConfirm(t, it, entry) {
    const others = entry.places.filter((p) => p.dir !== ".agents/skills").map((p) => tilde(p.path));
    return this.card(t, [
      div().text_size(13.5).font_semibold().text_color(t.foreground).child(`Remove ${entry.folder}?`),
      div().text_size(12.5).line_height("18px").text_color(t.muted)
        .child(`Deletes ${tilde(`${userHome()}/.agents/skills/${entry.folder}`)}${others.length ? ` and ${others.join(", ")}` : ""}, for every agent.`),
      this.commandBox(t, "sk-rc-cmd", this.commandText(this.removeArgs(entry))),
      h_flex().gap(6).justify_end()
        .child(this.button(t, "sk-rc-cancel", "Cancel", (_e, cx) => { this.confirm = null; cx.notify(); }))
        .child(this.button(t, "sk-rc-go", "Remove", (_e, cx) => this.startJob("remove", it, this.removeArgs(entry), cx), { kind: "danger" })),
    ]);
  }

  progress(t) {
    const j = this.job;
    return this.card(t, [
      h_flex().gap(10).items_center()
        .child(this.spinner(t, 14))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().text_size(13).text_color(t.foreground).child(`${j.kind === "remove" ? "Removing" : "Installing"} ${j.name}…`))
          .child(div().truncate().text_size(12).text_color(t.dim).child(j.line || "Running the skills CLI…"))),
    ]);
  }

  outcomeCard(t) {
    const o = this.outcome;
    const dismiss = this.button(t, "sk-oc-ok", o.ok ? "Done" : "Dismiss", (_e, cx) => { this.outcome = null; cx.notify(); });
    if (o.ok) {
      const text = o.kind === "remove" ? `Removed ${o.name}.` : `Installed for ${o.agents.length ? o.agents.join(" and ") : "your agents"}.`;
      return div().flex_none().px(18).py(12).border_b(1).border_color(t.border)
        .child(h_flex().w_full().px(12).py(9).gap(10).items_center().rounded(8).border_1().border_color(alpha(t.ansi2, "55")).bg(alpha(t.ansi2, "14"))
          .child(svg(I("check")).size(14).flex_none().text_color(t.ansi2))
          .child(v_flex().flex_1().min_w(0).gap(1)
            .child(div().text_size(12.5).text_color(t.foreground).child(text))
            .when(Boolean(o.path) && o.kind !== "remove", (el) => el.child(div().truncate().text_size(11.5).text_color(t.dim).child(tilde(o.path)))))
          .child(dismiss));
    }
    const lines = (o.log || "No output.").split(/\r?\n/).slice(-300);
    return div().flex_none().px(18).py(12).border_b(1).border_color(t.border)
      .child(v_flex().w_full().p(12).gap(10).rounded(8).border_1().border_color(alpha(t.blocked, "66")).bg(alpha(t.blocked, "10"))
        .child(h_flex().gap(10).items_start()
          .child(svg(I("sk-alert")).size(14).flex_none().mt(1).text_color(t.blocked))
          .child(v_flex().flex_1().min_w(0).gap(2)
            .child(div().text_size(12.5).text_color(t.foreground).child(`Couldn't ${o.kind === "remove" ? "remove" : "install"} ${o.name}.`))
            .when(Boolean(o.error), (el) => el.child(div().text_size(12).line_height("17px").text_color(t.muted).child(clip(o.error, 300))))))
        .child(h_flex().gap(6).justify_end()
          .child(this.button(t, "sk-oc-out", o.show ? "Hide output" : "Show output", (_e, cx) => { o.show = !o.show; cx.notify(); }))
          .child(dismiss))
        .when(o.show, (el) => el.child(
          v_flex().id("sk-oc-log").h(150).p(8).rounded(6).border_1().border_color(t.border).bg(t.surface).overflow_y_scrollbar()
            .on_scroll_wheel((_e, cx) => cx.stop_propagation())
            .children(lines.map((l) => div().font_family(MONO).text_size(11).line_height("16px").text_color(t.muted).child(l || " "))))));
  }

  places(t, entry) {
    return v_flex().flex_none().px(18).py(12).gap(6).border_b(1).border_color(t.border)
      .child(this.heading(t, "Location"))
      .children(entry.places.map((p) => h_flex().gap(10).items_center()
        .child(div().flex_1().min_w(0).truncate().font_family(MONO).text_size(11.5).text_color(t.muted).child(tilde(p.path)))
        .child(div().flex_none().text_size(11.5).text_color(t.dim).child(p.agent))));
  }

  detail(t) {
    const it = this.sel;
    if (!it)
      return v_flex().flex_1().min_w(0).h_full().items_center().justify_center().gap(10)
        .child(svg(I("sk-skills")).size(22).text_color(t.dim))
        .child(div().text_size(12.5).text_color(t.dim).child("Pick a skill to see what it does."));
    const info = this.info[it.key];
    const entry = this.installedOf(it);
    let action = null;
    if (this.job?.key === it.key) action = this.progress(t);
    else if (this.confirm?.key === it.key && this.confirm.kind === "install" && !entry && it.source) action = this.installConfirm(t, it, info);
    else if (this.confirm?.key === it.key && this.confirm.kind === "remove" && entry?.lock) action = this.removeConfirm(t, it, entry);
    else if (this.outcome?.key === it.key) action = this.outcomeCard(t);
    const showAudits = Boolean(it.source) && !(this.confirm?.key === it.key && this.confirm.kind === "install");
    return v_flex().flex_1().min_w(0).h_full()
      .child(this.header(t, it, info, entry))
      .when(Boolean(action), (el) => el.child(action))
      .when(Boolean(it.places) && Boolean(entry), (el) => el.child(this.places(t, entry)))
      .when(showAudits, (el) => el.child(this.audits(t, info)))
      .child(div().flex_1().min_h(0).child(this.preview));
  }

  // ---- keys ----

  key(e, cx) {
    const k = e.key;
    if (k === "escape") {
      if (this.confirm) this.confirm = null;
      else if (this.input.value()) { this.clearSearch(cx); }
      else return;
      cx.stop_propagation();
      cx.notify();
      return;
    }
    if (k === "down" || k === "up") {
      const items = this.list();
      if (!items.length) return;
      let i = items.findIndex((x) => x.key === this.sel?.key);
      i = k === "down" ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1);
      this.select(items[i], cx);
      this.scroll.scroll_to_item(i);
      cx.stop_propagation();
    }
  }

  render(cx) {
    const t = theme();
    return v_flex().id("sk-page").size_full().px(28).pt(22).pb(22)
      .on_key_down((e, cx) => this.key(e, cx))
      .child(div().pt(6).pb(8).text_size(12).font_semibold().text_color(t.dim).child("SKILLS"))
      .child(div().pb(14).text_size(12.5).line_height("18px").text_color(t.dim)
        .child("Find skills on skills.sh, check them, and install them for Claude Code and Codex."))
      .child(h_flex().flex_1().min_h(0).w_full().rounded(10).border_1().border_color(t.border).bg(t.surface).overflow_hidden()
        .child(this.listPane(t))
        .child(this.detail(t)));
  }
}
