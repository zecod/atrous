// Accounts core: the multi-account state, read and written the same way by the usage card
// (fetches limits, switches automatically) and Settings > Accounts (manages accounts).
// A mod can't import from another mod's folder: this file is kept identical in
// mods/usage-card/, mods/my-settings/ and mods/accounts/ (the sign-in dialog). Change all three.
//
// ONE SOURCE OF TRUTH: ~/.config/atrous/accounts/state.json, also read by accounts/launch.ps1
// at every agent launch:
//   { v: 1,
//     active: { claude: "<id>", codex: "<id>" },          the account new agents start on
//     accounts: [{ tool, id, name?, email?, dir?, pending? }],
//        id "default" = the main ~/.claude / ~/.codex (no dir); name: only when the person named it
//        (else the email shows); pending: a new account whose first login hasn't finished
//     auto: { enabled, threshold },
//     picked: { claude: { id, by: "user" | "auto", at } } }  the last change of `active`
// - Writes go through updateState: one at a time per mod copy (a queue), each one reads the file,
//   applies the edit, and writes only if nobody wrote meanwhile (writeTextFile's compare, then an
//   atomic replace), else reads again. An edit can refuse (return false): setActive uses that to
//   switch only if the account it expects is still the active one.
// - After a write the state is broadcast as shared "accounts.state": every mod redraws from it at
//   once. The usage card also re-reads the file every 20 s, so an edit from outside shows too.
// - shared "accounts.usage" is written only by the usage card that holds the fetch lease (see
//   usage-card/main.js): { "<tool>:<id>": { login, plan, who, rows, blocked, at, error, note,
//   stale, fetching, http, next } }. Everyone draws limits from it; nobody else asks the services.
//
// Tokens are read only to send them to the service that issued them (the card) and never leave
// the credential files otherwise; nothing here writes a credential file.

import { readTextFile, writeTextFile, appHome, home, shared, setShared, run, exec, window } from "atrous";

export const TOOLS = {
  claude: { name: "Claude Code", short: "Claude", icon: "icons/claude.svg", main: ".claude" },
  codex: { name: "Codex", short: "Codex", icon: "icons/codex.svg", main: ".codex" },
};
export const TOOL_KEYS = ["claude", "codex"];

const slash = (p) => String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
export const accountsDir = () => `${slash(appHome())}/accounts`;
export const stateFile = () => `${accountsDir()}/state.json`;
export const keyOf = (a) => `${a.tool}:${a.id}`;
export const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export function normalize(raw) {
  const st = raw && typeof raw === "object" ? JSON.parse(JSON.stringify(raw)) : {};
  st.v = 1;
  st.active = { claude: "default", codex: "default", ...(st.active ?? {}) };
  const list = Array.isArray(st.accounts) ? st.accounts.filter((a) => a && TOOLS[a.tool] && a.id) : [];
  for (const tool of TOOL_KEYS) {
    if (!list.some((a) => a.tool === tool && a.id === "default")) list.unshift({ tool, id: "default" });
  }
  for (const a of list) {
    if (a.id === "default" && a.name === "Main") delete a.name; // the old automatic name: the email shows instead
    if (!a.name) delete a.name;
  }
  st.accounts = list;
  for (const tool of TOOL_KEYS) {
    const a = list.find((x) => x.tool === tool && x.id === st.active[tool]);
    if (!a || a.pending) st.active[tool] = "default";
  }
  const th = Number(st.auto?.threshold);
  st.auto = { enabled: st.auto?.enabled === undefined ? true : Boolean(st.auto.enabled), threshold: Number.isFinite(th) ? Math.max(50, Math.min(100, Math.round(th))) : 95 };
  st.picked = st.picked && typeof st.picked === "object" ? st.picked : {};
  return st;
}

// The state as every mod sees it now (shared), else the defaults until the file is read.
export function currentState() {
  return normalize(shared("accounts.state"));
}

// First use in Atrous: this home has no state.json yet. `profile.mjs migrate` copies herdr-app's
// accounts (the app Atrous forked) over when it has some, junction-safe, leaving herdr's own as
// they are; it does nothing when there are none or this home has a state.json by then. Asked
// once per mod copy, before the first read or write of the state, so an edit never lands first.
let migration = null;
function migrateOnce() {
  migration ??= exec("node", [`${accountsDir()}/profile.mjs`, "migrate"]).catch(() => null);
  return migration;
}

export async function readState() {
  let raw = await readTextFile(stateFile()).catch(() => null);
  if (!raw) {
    await migrateOnce();
    raw = await readTextFile(stateFile()).catch(() => null);
  }
  let parsed = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch {}
  return { st: normalize(parsed), raw };
}

// Broadcasts the file's state when it differs from what mods show.
export function publish(st) {
  if (JSON.stringify(shared("accounts.state")) !== JSON.stringify(st)) setShared("accounts.state", st);
}

let queue = Promise.resolve();

// Reads the file, applies edit(state) (false: leave it as it is), writes it back unless someone
// wrote meanwhile (then again). Resolves with the new state, or null when nothing was written.
export function updateState(edit) {
  const run1 = queue.then(async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const { st, raw } = await readState();
      if (edit(st) === false) { publish(st); return null; }
      const next = normalize(st);
      const text = JSON.stringify(next, null, 2) + "\n";
      if (text === raw) { publish(next); return next; }
      try {
        await writeTextFile(stateFile(), text, raw);
        publish(next);
        return next;
      } catch {}
    }
    return null;
  });
  queue = run1.catch(() => null);
  return run1;
}

// Makes `id` the account new agents of `tool` start on. `onlyIf`: only while that id is still the
// active one (the card's automatic switch: a person's pick made meanwhile wins). Then tells the
// usage card, so it shows that account at once and fetches its numbers if they're due.
export async function setActive(tool, id, by, onlyIf) {
  const next = await updateState((s) => {
    if (onlyIf !== undefined && s.active[tool] !== onlyIf) return false;
    const a = s.accounts.find((x) => x.tool === tool && x.id === id);
    if (!a || a.pending) return false;
    if (s.active[tool] === id) return false;
    s.active[tool] = id;
    s.picked = { ...s.picked, [tool]: { id, by, at: Date.now() } };
  });
  if (next) run("usage-card.accounts");
  return next;
}

export const accountsOf = (st, tool) => st.accounts.filter((a) => a.tool === tool);
export const activeOf = (st, tool) => st.accounts.find((a) => a.tool === tool && a.id === st.active[tool]) ?? { tool, id: "default" };
export const homeOf = (a) => (a.id === "default" || !a.dir ? `${slash(home())}/${TOOLS[a.tool].main}` : slash(a.dir));

// What people see: the name they gave it, else the email it's signed in with.
export function displayName(a, email) {
  return a?.name || email || a?.email || (a?.id === "default" ? "Main" : "New account");
}
// For tight places (the sidebar card): the name, else the email's part before the @.
export function shortName(a, email) {
  if (a?.name) return a.name;
  const e = email || a?.email;
  return e ? e.split("@")[0] : a?.id === "default" ? "Main" : "New";
}

async function readJson(path) {
  try {
    const text = await readTextFile(path);
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

// ---- logins (from the credential files' non-secret fields) ----

// { state: "in" | "out" | "expired" | "apikey", plan, fresh (the access token works now), creds }
// `creds` is what the card sends to the service; callers that only show state ignore it.
// macOS keeps Claude Code's login in the Keychain instead of .credentials.json. The main
// account's item is "Claude Code-credentials"; an account folder (CLAUDE_CONFIG_DIR) gets its own
// item, tried as "Claude Code-credentials-<first 8 hex of sha256(folder)>" (best effort). The first
// read may ask the person to allow access. Values are only used to ask the service for usage.
async function claudeOauth(a) {
  const file = (await readJson(`${homeOf(a)}/.credentials.json`))?.claudeAiOauth;
  if (file || window()?.platform !== "macos") return file ?? null;
  const script = a.id === "default"
    ? 'security find-generic-password -s "Claude Code-credentials" -w'
    : 'security find-generic-password -s "Claude Code-credentials-$(printf %s "$1" | shasum -a 256 | cut -c1-8)" -w';
  try {
    const r = await exec("sh", ["-c", script, "keychain", homeOf(a)]);
    if (r.code === 0 && r.stdout.trim()) return JSON.parse(r.stdout.trim())?.claudeAiOauth ?? null;
  } catch {}
  return null;
}

export async function readLogin(a) {
  if (a.tool === "claude") {
    const o = await claudeOauth(a);
    if (!o?.accessToken && !o?.refreshToken) return { state: "out" };
    const tier = /max_(\d+x)/.exec(o.rateLimitTier ?? "")?.[1];
    const plan = [cap(o.subscriptionType), tier].filter(Boolean).join(" ");
    if (o.refreshTokenExpiresAt && o.refreshTokenExpiresAt < Date.now()) return { state: "expired", plan };
    const fresh = Boolean(o.accessToken) && (!o.expiresAt || o.expiresAt > Date.now() + 60000);
    return { state: "in", plan, fresh, creds: o };
  }
  const auth = await readJson(`${homeOf(a)}/auth.json`);
  if (auth?.tokens?.access_token) {
    const claims = jwtClaims(auth.tokens.id_token);
    const plan = cap(claims?.["https://api.openai.com/auth"]?.chatgpt_plan_type ?? "");
    // Access tokens last 10 days; Codex renews them when it runs on that account.
    const exp = jwtClaims(auth.tokens.access_token)?.exp;
    const fresh = !exp || exp * 1000 > Date.now() + 60000;
    return { state: "in", plan, fresh, creds: auth.tokens };
  }
  if (auth?.OPENAI_API_KEY) return { state: "apikey" };
  return { state: "out" };
}

// The email the account is signed in with (Claude: its .claude.json's oauthAccount; Codex: the
// id token's email claim), or null.
export async function readEmail(a) {
  if (a.tool === "claude") {
    const file = a.id === "default" || !a.dir ? `${slash(home())}/.claude.json` : `${homeOf(a)}/.claude.json`;
    return (await readJson(file))?.oauthAccount?.emailAddress ?? null;
  }
  const auth = await readJson(`${homeOf(a)}/auth.json`);
  return jwtClaims(auth?.tokens?.id_token)?.email ?? null;
}

function b64url(s) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const bytes = [];
  let bits = 0, val = 0;
  for (const ch of s) {
    const i = chars.indexOf(ch === "+" ? "-" : ch === "/" ? "_" : ch);
    if (i < 0) continue;
    val = ((val << 6) | i) & 0xffffff;
    bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push((val >> bits) & 0xff); }
  }
  let out = "";
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i++];
    if (b < 0x80) out += String.fromCharCode(b);
    else if (b < 0xe0) out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i++] & 0x3f));
    else if (b < 0xf0) out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
    else out += String.fromCodePoint(((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
  }
  return out;
}

// The payload of a JWT (only its non-secret claims are used: email, plan, exp).
function jwtClaims(token) {
  try { return JSON.parse(b64url(String(token ?? "").split(".")[1] ?? "")); } catch { return null; }
}

// ---- limits ----

// A per-model limit binds only if the user runs that model (settings.json "model", e.g.
// "claude-fable-5-1" for the Fable limit; "opus" leaves it out).
export function modelMatches(model, label) {
  const m = String(model ?? "").toLowerCase();
  const word = String(label ?? "").toLowerCase().split(/\s+/)[0];
  return Boolean(m && word && m.includes(word));
}

// The limit that binds now: { pct, label, kind, resets, reached }. A window that has reset since
// the numbers were read counts as 0.
export function binding(tool, u, model) {
  const now = Date.now();
  let best = { pct: 0, label: null, kind: null, resets: null };
  for (const r of u?.rows ?? []) {
    if (tool === "claude" && r.kind === "model" && !modelMatches(model, r.label)) continue;
    const pct = r.resets && r.resets < now ? 0 : Math.max(0, r.pct ?? 0);
    if (pct > best.pct || best.label === null) best = { pct, label: r.label, kind: r.kind, resets: r.resets };
  }
  const fresh = u?.at && now - u.at < 15 * 60000;
  return { ...best, reached: Boolean(fresh && u?.blocked) || best.pct >= 100 };
}

export function limitName(b) {
  if (!b?.label) return "usage";
  if (b.kind === "session" || b.label === "5h") return "5-hour";
  if (b.kind === "week" || b.label === "Week") return "weekly";
  return `${b.label} weekly`;
}

// The two limits that matter now: 5h + week while a 5-hour window runs, else week + the first
// per-model limit (Claude) or the first two (Codex).
export function pairRows(tool, rows) {
  rows = rows ?? [];
  if (tool !== "claude") return rows.slice(0, 2);
  const by = (kind) => rows.find((r) => r.kind === kind);
  const session = by("session");
  return (session ? [session, by("week")] : [by("week"), by("model")]).filter(Boolean);
}
