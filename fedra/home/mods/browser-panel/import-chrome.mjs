// Import from Chrome: copies the person's own Chrome profile data into the browser panel's
// profile (%LOCALAPPDATA%\herdr-browser\profile). Run it while the panel's Chrome is stopped.
//
// The source is only ever read: files are opened read-only and copied into a temp folder;
// nothing in Chrome's own "User Data" folder is written, renamed or deleted. Databases are
// checked (and a half-written transaction rolled back) on the temp copy before they replace
// the panel profile's files; the files they replace are kept in herdr-browser\backup-<time>.
//
// Writes a JSON report (counts only: never cookie values, passwords or URLs).
//
//   node import-chrome.mjs [--report <file>] [--source <User Data dir>] [--dest <profile dir>]
//                          [--profile <source profile folder, default: Local State's last used>]

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

process.removeAllListeners("warning"); // node:sqlite prints an "experimental" warning
const { DatabaseSync } = await import("node:sqlite");

const opt = {};
{
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) if (a[i].startsWith("--")) opt[a[i].slice(2)] = a[i + 1]?.startsWith("--") ? "true" : a[++i];
}
const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const BASE = path.join(LOCAL, "herdr-browser");
const SOURCE = opt.source || path.join(LOCAL, "Google", "Chrome", "User Data");
const DEST = opt.dest || path.join(BASE, "profile");
const REPORT = opt.report || path.join(BASE, "import-report.json");
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const WORK = path.join(path.dirname(DEST), `import-tmp-${STAMP}`);
const BACKUP = path.join(path.dirname(DEST), `backup-${STAMP}`); // only the latest import's is kept

// What comes over, from the profile folder. Caches, extensions and site storage stay behind.
const ITEMS = [
  { name: "Bookmarks", rel: "Bookmarks", kind: "json" },
  { name: "History", rel: "History", kind: "db" },
  { name: "Cookies (site logins)", rel: path.join("Network", "Cookies"), kind: "db" },
  { name: "Saved passwords", rel: "Login Data", kind: "db" },
  { name: "Saved passwords (account)", rel: "Login Data For Account", kind: "db" },
  { name: "Autofill", rel: "Web Data", kind: "db" },
  { name: "Settings", rel: "Preferences", kind: "json" },
  { name: "Settings (protected)", rel: "Secure Preferences", kind: "json" },
  { name: "Site icons", rel: "Favicons", kind: "db" },
  { name: "Top sites", rel: "Top Sites", kind: "db" },
  { name: "Address bar shortcuts", rel: "Shortcuts", kind: "db" },
];

const report = { ok: false, started: new Date().toISOString(), source: SOURCE, profile: null, items: [], counts: {}, backup: null, error: null };

function same(a, b) { return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase(); }

// ---- encryption keys ----
// Chrome encrypts cookies and passwords with an AES key kept in Local State, wrapped with
// Windows DPAPI ("v10" values; this Windows user can unwrap it). Chrome 127+ also seals most
// cookies with app-bound encryption ("v20"), which only that Chrome profile can open.
// This browser keeps its own key (replacing it would make its own cookies and passwords
// unreadable, and Chrome deletes what it can't read), so readable v10 values are re-encrypted
// from your Chrome's key to this browser's key, in memory, on the copies. Nothing is printed.

function dpapiKey(localState) {
  const raw = Buffer.from(localState?.os_crypt?.encrypted_key ?? "", "base64");
  if (raw.subarray(0, 5).toString() !== "DPAPI") return Promise.resolve(null);
  return new Promise((resolve) => {
    const ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Add-Type -AssemblyName System.Security; $b = [Convert]::FromBase64String($env:HERDR_BLOB); [Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b, $null, 'CurrentUser')))"],
      { windowsHide: true, env: { ...process.env, HERDR_BLOB: raw.subarray(5).toString("base64") } });
    let out = "";
    ps.stdout.on("data", (d) => (out += d));
    ps.on("error", () => resolve(null));
    ps.on("close", (code) => {
      const key = code === 0 ? Buffer.from(out.trim(), "base64") : null;
      resolve(key?.length === 32 ? key : null);
    });
  });
}

// "v10" | nonce (12) | AES-256-GCM ciphertext | tag (16)
function rekey(value, from, to) {
  const b = Buffer.from(value);
  if (b.length < 31 || b.subarray(0, 3).toString() !== "v10") return null;
  const d = createDecipheriv("aes-256-gcm", from, b.subarray(3, 15));
  d.setAuthTag(b.subarray(b.length - 16));
  const plain = Buffer.concat([d.update(b.subarray(15, b.length - 16)), d.final()]);
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", to, nonce);
  const out = Buffer.concat([Buffer.from("v10"), nonce, c.update(plain), c.final(), c.getAuthTag()]);
  plain.fill(0);
  return out;
}

// Moves a copied table's readable secrets to this browser's key; drops what can't be read here.
function rekeyTable(file, table, column, from, to) {
  const db = new DatabaseSync(file);
  let moved = 0, dropped = 0;
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) return { moved, dropped };
    const rows = db.prepare(`SELECT rowid id, ${column} v FROM ${table} WHERE CAST(substr(${column}, 1, 3) AS TEXT) = 'v10'`).all();
    const set = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`);
    const del = db.prepare(`DELETE FROM ${table} WHERE rowid = ?`);
    for (const r of rows) {
      let v = null;
      try { v = from && to ? rekey(r.v, from, to) : null; } catch {}
      if (v) { set.run(v, r.id); moved++; } else { del.run(r.id); dropped++; }
    }
  } finally { db.close(); }
  return { moved, dropped };
}

const SECRETS = {
  "Network/Cookies": [["cookies", "encrypted_value"]],
  "Login Data": [["logins", "password_value"]],
  "Login Data For Account": [["logins", "password_value"]],
  "Web Data": [["credit_cards", "card_number_encrypted"], ["token_service", "encrypted_token"]],
};

// Read-only copy: the source is opened with "r" only.
async function readCopy(src, dst) {
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  await pipeline(fs.createReadStream(src, { flags: "r" }), fs.createWriteStream(dst, { flags: "w" }));
}

function why(e) {
  if (["EBUSY", "EPERM", "EACCES"].includes(e?.code) || /lock|busy/i.test(e?.message ?? "")) return "in use by your open Chrome: close Chrome and import again";
  if (e?.code === "ENOENT") return "not in this Chrome profile";
  return String(e?.message ?? e).slice(0, 160);
}

function count(db, sql) {
  try { return db.prepare(sql).all(); } catch { return null; }
}

// Counts for the report, from a database copy. Never values.
function countsFor(rel, file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (rel === "History") return { pages: count(db, "SELECT COUNT(*) n FROM urls")?.[0]?.n, visits: count(db, "SELECT COUNT(*) n FROM visits")?.[0]?.n };
    if (rel.endsWith("Cookies")) {
      const by = count(db, "SELECT CAST(substr(encrypted_value, 1, 3) AS TEXT) v, COUNT(*) n FROM cookies GROUP BY v") ?? [];
      return { cookies: count(db, "SELECT COUNT(*) n FROM cookies")?.[0]?.n, sites: count(db, "SELECT COUNT(DISTINCT host_key) n FROM cookies")?.[0]?.n,
        encryption: Object.fromEntries(by.map((r) => [/^v\d\d$/.test(r.v) ? r.v : "other", r.n])) };
    }
    if (rel.startsWith("Login Data")) {
      const by = count(db, "SELECT CAST(substr(password_value, 1, 3) AS TEXT) v, COUNT(*) n FROM logins GROUP BY v") ?? [];
      const n = (v) => by.filter((r) => r.v === v).reduce((a, r) => a + r.n, 0);
      return { logins: count(db, "SELECT COUNT(*) n FROM logins")?.[0]?.n, readable: n("v10"), appBound: n("v20"),
        noPassword: count(db, "SELECT COUNT(*) n FROM logins WHERE password_value IS NULL OR length(password_value) = 0")?.[0]?.n };
    }
    if (rel === "Web Data") return { autofill: count(db, "SELECT COUNT(*) n FROM autofill")?.[0]?.n };
    return {};
  } finally { db.close(); }
}

function bookmarkCount(json) {
  let n = 0;
  const walk = (node) => { if (!node) return; if (node.type === "url") n++; for (const c of node.children ?? []) walk(c); };
  for (const root of Object.values(json.roots ?? {})) if (root && typeof root === "object") walk(root);
  return n;
}

async function portClosed(port) {
  try { await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) }); return false; } catch { return true; }
}

async function main() {
  if (same(SOURCE, DEST) || same(SOURCE, BASE)) throw new Error("Source and destination are the same folder");
  // The panel's Chrome must be closed: its files are locked while it runs.
  for (let i = 0; i < 20 && !(await portClosed(Number(opt["cdp-port"] ?? 9333))); i++) await new Promise((r) => setTimeout(r, 500));
  if (!(await portClosed(Number(opt["cdp-port"] ?? 9333)))) throw new Error("The panel's Chrome is still running; stop it first");

  const localState = JSON.parse(await fsp.readFile(path.join(SOURCE, "Local State"), { encoding: "utf8", flag: "r" }));
  let profile = opt.profile || localState?.profile?.last_used || "Default";
  if (!fs.existsSync(path.join(SOURCE, profile))) profile = "Default";
  const srcProfile = path.join(SOURCE, profile);
  if (!fs.existsSync(srcProfile)) throw new Error(`No Chrome profile at ${srcProfile}`);
  report.profile = { folder: profile, name: localState?.profile?.info_cache?.[profile]?.name ?? profile };
  const destProfile = path.join(DEST, "Default");
  await fsp.mkdir(destProfile, { recursive: true });
  // One backup is enough: drop the ones earlier imports left beside the profile.
  for (const d of await fsp.readdir(path.dirname(DEST)).catch(() => [])) {
    if (/^(backup|import-tmp)-\d{4}-/.test(d)) await fsp.rm(path.join(path.dirname(DEST), d), { recursive: true, force: true });
  }
  await fsp.mkdir(WORK, { recursive: true });

  const backup = async (file) => {
    if (!fs.existsSync(file)) return;
    const to = path.join(BACKUP, path.relative(DEST, file));
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.copyFile(file, to);
    report.backup = BACKUP;
  };

  // This browser's own key stays; Chrome's readable secrets move to it (see "encryption keys").
  let destLs = null;
  try { destLs = JSON.parse(await fsp.readFile(path.join(DEST, "Local State"), "utf8")); } catch {}
  const srcWrapped = localState?.os_crypt?.encrypted_key;
  const keepKey = Boolean(destLs?.os_crypt?.encrypted_key);
  const moveSecrets = keepKey && srcWrapped && destLs.os_crypt.encrypted_key !== srcWrapped;
  const [fromKey, toKey] = moveSecrets ? await Promise.all([dpapiKey(localState), dpapiKey(destLs)]) : [null, null];
  const secretsMoved = { moved: 0, dropped: 0 };

  for (const item of ITEMS) {
    const src = path.join(srcProfile, item.rel);
    const tmp = path.join(WORK, item.rel);
    const dst = path.join(destProfile, item.rel);
    const entry = { name: item.name, file: item.rel.replace(/\\/g, "/"), status: "skipped" };
    report.items.push(entry);
    try {
      if (!fs.existsSync(src)) { entry.status = "missing"; entry.reason = "not in this Chrome profile"; continue; }
      await readCopy(src, tmp);
      if (item.kind === "db") {
        // A transaction Chrome was in the middle of: copy its journal too, so opening the copy
        // rolls it back to a consistent state (on the copy, never the source).
        if (fs.existsSync(`${src}-journal`) && fs.statSync(`${src}-journal`).size > 0) await readCopy(`${src}-journal`, `${tmp}-journal`);
        const db = new DatabaseSync(tmp);
        const check = db.prepare("PRAGMA quick_check").get();
        db.close();
        if (Object.values(check ?? {})[0] !== "ok") throw new Error("the copy didn't pass SQLite's check (Chrome was writing it); try again");
        await fsp.rm(`${tmp}-journal`, { force: true });
        Object.assign(entry, countsFor(item.rel, tmp));
        if (moveSecrets) {
          let moved = 0;
          for (const [table, column] of SECRETS[item.rel.replace(/\\/g, "/")] ?? []) {
            const r = rekeyTable(tmp, table, column, fromKey, toKey);
            moved += r.moved; secretsMoved.moved += r.moved; secretsMoved.dropped += r.dropped;
          }
          if (entry.readable !== undefined && item.rel.startsWith("Login Data")) entry.readable = moved;
        }
        if (item.rel.endsWith("Cookies")) {
          // Chrome 127+ seals cookies with app-bound encryption ("v20"): only that Chrome profile
          // can read them, and another profile deletes them on start. Keep only readable ones and
          // add them to this profile's cookies, so logins made in this browser stay.
          const db2 = new DatabaseSync(tmp);
          db2.exec("DELETE FROM cookies WHERE CAST(substr(encrypted_value, 1, 3) AS TEXT) = 'v20'");
          entry.readable = db2.prepare("SELECT COUNT(*) n FROM cookies").get().n;
          db2.close();
          entry.appBound = (entry.cookies ?? 0) - entry.readable;
          if (!entry.readable) {
            entry.status = "skipped";
            entry.reason = `all ${entry.cookies} are sealed to your own Chrome (app-bound encryption) and can't be read here: sign in once in this browser instead`;
            continue;
          }
          if (fs.existsSync(dst)) {
            await backup(dst);
            const into = new DatabaseSync(dst);
            into.exec(`ATTACH DATABASE '${tmp.replace(/'/g, "''")}' AS src; INSERT OR REPLACE INTO main.cookies SELECT * FROM src.cookies; DETACH DATABASE src;`);
            into.close();
            entry.status = "imported";
            entry.bytes = fs.statSync(dst).size;
            continue;
          }
        }
      } else {
        const json = JSON.parse(await fsp.readFile(tmp, "utf8"));
        if (item.rel === "Bookmarks") entry.bookmarks = bookmarkCount(json);
      }
      // Replace the panel profile's file (and any journal that belonged to the old one).
      await backup(dst);
      for (const ext of ["-journal", "-wal", "-shm"]) await fsp.rm(`${dst}${ext}`, { force: true });
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      await fsp.copyFile(tmp, dst);
      entry.status = "imported";
      entry.bytes = fs.statSync(dst).size;
    } catch (e) {
      entry.status = "skipped";
      entry.reason = why(e);
      if (/close Chrome/.test(entry.reason)) entry.locked = true;
    }
  }

  if (keepKey) {
    // This browser's Local State (and its key) stays as it is.
    report.items.unshift({ name: "Encryption key", file: "Local State", status: "imported",
      note: moveSecrets
        ? (fromKey && toKey ? `this browser kept its own; ${secretsMoved.moved} readable secrets were moved to it` : "this browser kept its own; Windows couldn't unlock the keys, so passwords stay locked")
        : "this browser already uses your Chrome's key" });
    report.ok = true;
    return;
  }

  // A new profile takes Chrome's Local State (with its key, so v10 passwords read as they are).
  // Chrome opens the profile Local State names as last used, so it's pointed at "Default".
  const ls = structuredClone(localState);
  ls.profile = ls.profile ?? {};
  const info = ls.profile.info_cache?.[profile];
  ls.profile.info_cache = info ? { Default: info } : {};
  ls.profile.last_used = "Default";
  ls.profile.last_active_profiles = ["Default"];
  ls.profile.profiles_order = ["Default"];
  await backup(path.join(DEST, "Local State"));
  await fsp.writeFile(path.join(DEST, "Local State"), JSON.stringify(ls));
  report.items.unshift({ name: "Encryption key", file: "Local State", status: "imported",
    note: "copied from your Chrome (this browser had none yet)" });
  report.ok = true;
}

try { await main(); }
catch (e) { report.error = String(e?.message ?? e); }
finally {
  await fsp.rm(WORK, { recursive: true, force: true }).catch(() => {});
  report.finished = new Date().toISOString();
  await fsp.mkdir(path.dirname(REPORT), { recursive: true });
  await fsp.writeFile(REPORT, JSON.stringify(report, null, 2));
  for (const i of report.items) console.log(`${i.status.padEnd(9)} ${i.name}${i.reason ? ` (${i.reason})` : ""}`);
  if (report.error) console.log("error:", report.error);
  process.exitCode = report.ok ? 0 : 1;
}
