// Settings > Accounts: more than one Claude Code / Codex login, like profiles. One card per tool:
// a row per account (avatar, name and email, plan, its two limits that matter now, a radio for the
// one new agents start on, a "..." menu for Rename / Log in again / Remove), and a dashed row to
// add one. Below, the automatic-switching setting.
//
// State: accounts/state.json through accounts-core.js (same file in mods/usage-card): this page
// draws from shared "accounts.state" and "accounts.usage" (the usage card's numbers; this page
// asks no service) and changes things only with updateState / setActive, which write the file
// (compare, then atomic replace) and broadcast it. A pick here reaches the card and the next
// launch at once.
//
// Adding an account: `node accounts/profile.mjs create` makes its folder, the state gets
// { pending: true } (never active, never shown by the card), and the sign-in dialog (mods/accounts,
// role "signin") runs the tool's login in a background terminal named login-<tool>-<id> and walks
// the person through it. The login doesn't depend on any window: hiding the dialog or closing
// Settings leaves it waiting for the browser. This page only watches (that terminal by name, the
// account's credentials) and never removes an account by itself:
// - credentials appear: pending goes, "Logged in as <email>" shows with a button to use it;
// - the sign-in runs: the row says so, with Open (the dialog again) and Cancel;
// - it ended without credentials (the dialog shows why): the row offers Finish login / Discard.
// An account is removed only by Cancel, Discard, Remove, or Close in the dialog after a failure.
// Removing an account: state first (no new agent starts on it), then its folder.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Popover } from "gpui-base";
import { exec, core, theme, shared, terminals, openOverlay, run } from "atrous";
import { TOOLS, TOOL_KEYS, keyOf, readState, updateState, publish, currentState, setActive, accountsOf, activeOf, readLogin, readEmail, pairRows, displayName, accountsDir } from "./accounts-core.js";

const I = (name) => `mods/my-settings/${name}.svg`;
const SPINNER = "mods/workspace-chrome/spinner.svg";
const loginName = (a) => `login-${a.tool}-${a.id}`.slice(0, 32);
const lastJson = (text) => {
  try { return JSON.parse(String(text ?? "").trim().split(/\r?\n/).pop()); } catch { return null; }
};
// No quotes or control characters (the name is shown in a terminal title); "" = use the email.
const cleanName = (s) => String(s ?? "").replace(/[\u0000-\u001f"'`]/g, "").replace(/\s+/g, " ").trim().replace(/^-+\s*/, "").slice(0, 40);

function initials(name, email) {
  if (name && !name.includes("@")) {
    const words = name.split(/\s+/).filter(Boolean);
    return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? "")).toUpperCase() || "?";
  }
  return (email || name || "?")[0].toUpperCase();
}

// A theme color picked from the email, so an account keeps its color.
function tint(t, seed) {
  const palette = [t.ansi4, t.ansi5, t.ansi6, t.ansi2, t.ansi3, t.ansi1].filter(Boolean);
  let h = 0;
  for (const ch of String(seed ?? "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[h % palette.length] ?? t.accent;
}
const alpha = (hex, aa) => (/^#[0-9a-f]{6}$/i.test(hex ?? "") ? `${hex}${aa}` : hex);

export class AccountsPage extends View {
  init(props, cx) {
    this.p = props ?? {};
    this.info = {}; // "<tool>:<id>" -> { state, plan, email } from the account's own files
    this.menu = null; // the account whose "..." menu is open
    this.edit = null; // { key, action: "rename" | "remove" }
    this.logins = {}; // "<tool>:<id>" -> { address, since, fresh, done }
    this.busy = {}; // tool -> "adding"; key -> "removing"
    this.notes = {}; // tool -> { kind: "success" | "cancel" | "error", key?, email?, text?, at }
    this.thDraft = null;
    this.thToken = 0;
    this.ticks = 0;
    this.checking = false;
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Name" });
    this.input.on("submit", (_e, cx) => this.saveRename(cx));
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    this.loginSeen = this.p.login?.n;
    this.wantLogin = this.p.login ?? null; // my-settings.login:<tool>:<id>, opened by the next poll
    this.load(cx);
    cx.timer.every(2000, (cx) => this.poll(cx));
  }

  update(props) {
    this.p = props ?? {};
    if (this.p.login && this.p.login.n !== this.loginSeen) {
      this.loginSeen = this.p.login.n;
      this.wantLogin = this.p.login;
    }
  }

  // atrous-core's live terminals ({ address, name }), straight from `atc ls`: login terminals run
  // outside every space, so this doesn't rely on what the app's terminals() list includes.
  async liveTerminals() {
    try {
      const r = await core(["ls", "--json"]);
      return r.code === 0 ? (JSON.parse(r.stdout).terminals ?? []).filter((t) => t.state === "live") : null;
    } catch {
      return null;
    }
  }

  liveLogin(a, live) {
    const L = this.logins[keyOf(a)];
    return (live ?? []).find((t) => t.name === loginName(a) || (L && t.address === L.address)) ?? null;
  }

  // Each account's login, plan and email; logins still running (Settings was closed meanwhile).
  load(cx) {
    cx.spawn(async (cx) => {
      const { st } = await readState();
      publish(st);
      const live = st.accounts.some((a) => a.id !== "default") ? await this.liveTerminals() : [];
      // Finished sign-in terminals (the dialog keeps them for its details) whose account no longer
      // waits for a sign-in: tidy them away.
      try {
        const all = await core(["ls", "--all", "--json"]);
        for (const t of JSON.parse(all.stdout).terminals ?? []) {
          const m = /^login-(claude|codex)-(.+)$/.exec(t.name ?? "");
          if (!m || t.state === "live") continue;
          if (!st.accounts.find((x) => x.tool === m[1] && x.id === m[2])?.pending) core(["rm", t.address]).catch(() => null);
        }
      } catch {}
      const emails = {};
      const finished = [];
      for (const a of st.accounts) {
        const key = keyOf(a);
        const login = await readLogin(a).catch(() => ({ state: "out" }));
        const email = login.state === "in" ? await readEmail(a).catch(() => null) : null;
        this.info[key] = { state: login.state, plan: login.plan ?? "", email };
        if (email && email !== a.email) emails[key] = email;
        if (a.pending && login.state === "in") finished.push(key);
        const t = this.liveLogin(a, live);
        if (t && !this.logins[key]) this.logins[key] = { address: t.address, since: Date.now(), fresh: Boolean(a.pending) };
      }
      this.loaded = true;
      if (Object.keys(emails).length || finished.length) {
        await updateState((s) => {
          for (const a of s.accounts) {
            const key = keyOf(a);
            if (emails[key]) a.email = emails[key];
            if (finished.includes(key)) delete a.pending;
          }
        });
      }
      cx.notify();
    });
  }

  poll(cx) {
    this.ticks++;
    for (const [tool, n] of Object.entries(this.notes)) {
      if (n && n.kind !== "success" && Date.now() - n.at > 8000) { delete this.notes[tool]; cx.notify(); }
    }
    if (this.wantLogin) {
      const w = this.wantLogin;
      this.wantLogin = null;
      const a = currentState().accounts.find((x) => x.tool === w.tool && x.id === w.id);
      if (a && a.id !== "default" && a.dir) cx.spawn(async (cx) => this.startLogin(a, Boolean(a.pending), cx));
      return;
    }
    if (Object.keys(this.logins).length) {
      if (this.checking) return;
      this.checking = true;
      cx.spawn(async (cx) => {
        try {
          const live = await this.liveTerminals();
          for (const key of Object.keys(this.logins)) await this.checkLogin(key, live, cx);
        } finally {
          this.checking = false;
          cx.notify();
        }
      });
    } else if (this.ticks % 10 === 0) this.load(cx);
  }

  // A running sign-in: credentials appeared (done), or its terminal ended without them (the row
  // then offers Finish login / Discard; nothing is removed here).
  async checkLogin(key, liveList, cx) {
    const L = this.logins[key];
    const a = currentState().accounts.find((x) => keyOf(x) === key);
    if (!L) return;
    if (!a) { delete this.logins[key]; return; }
    const t = (liveList ?? []).find((x) => x.name === loginName(a) || (L.address && x.address === L.address));
    if (t) { L.address = t.address; L.seen = true; }
    if (!L.done) {
      const login = await readLogin(a).catch(() => ({ state: "out" }));
      if (login.state === "in") {
        L.done = true;
        const email = await readEmail(a).catch(() => null);
        this.info[key] = { state: "in", plan: login.plan ?? "", email };
        await updateState((s) => {
          const x = s.accounts.find((y) => keyOf(y) === key);
          if (!x) return false;
          delete x.pending;
          if (email) x.email = email;
        });
        this.notes[a.tool] = { kind: "success", key, email, at: Date.now() };
        run("usage-card.accounts");
      }
    }
    if (!liveList) return; // atc didn't answer: decide next time
    // Ended: it was seen running and is gone, or it never showed up within 20 s.
    if (t || (!L.seen && Date.now() - L.since < 20000)) return;
    delete this.logins[key];
  }

  // ---- actions ----

  use(a, cx) {
    this.menu = null;
    cx.spawn(async (cx) => {
      await setActive(a.tool, a.id, "user");
      if (this.notes[a.tool]?.key === keyOf(a)) delete this.notes[a.tool];
      cx.notify();
    });
  }

  // A new account: its folder, a pending entry, then the login dialog.
  add(tool, cx) {
    if (this.busy[tool]) return;
    this.busy[tool] = "adding";
    delete this.notes[tool];
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const id = `${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 6)}`;
        const r = await exec("node", [`${accountsDir()}/profile.mjs`, "create", tool, id]);
        const out = lastJson(r.stdout);
        if (!out?.ok) throw new Error(out?.error || r.stderr.trim() || "Couldn't set up the account.");
        const acc = { tool, id, dir: out.dir, pending: Date.now() };
        if (!(await updateState((s) => { s.accounts.push(acc); }))) {
          await exec("node", [`${accountsDir()}/profile.mjs`, "remove", tool, id]).catch(() => null);
          throw new Error("Couldn't save the account list.");
        }
        this.info[keyOf(acc)] = { state: "out", plan: "", email: null };
        await this.startLogin(acc, true, cx);
      } catch (e) {
        this.notes[tool] = { kind: "error", text: String(e?.message ?? e), at: Date.now() };
      } finally {
        delete this.busy[tool];
        cx.notify();
      }
    });
  }

  // The sign-in dialog (mods/accounts): it starts the tool's login in a background terminal, or
  // follows the one already running for this account. `fresh`: a new account, which the dialog
  // removes again only on Cancel or on Close after a failure.
  async startLogin(a, fresh, cx) {
    const key = keyOf(a);
    this.menu = null;
    const L = this.logins[key];
    this.logins[key] = { address: L?.address ?? null, seen: L?.seen ?? false, since: Date.now(), fresh: Boolean(fresh || a.pending), done: false };
    openOverlay({ mod: "accounts", kind: "dialog", modal: true, width: 480, props: { role: "signin", tool: a.tool, id: a.id, fresh: Boolean(fresh || a.pending) } });
    cx.notify();
  }

  // Ends the running sign-in; a new account goes with it.
  cancelLogin(a, cx) {
    const key = keyOf(a);
    this.busy[key] = "cancelling";
    cx.notify();
    cx.spawn(async (cx) => {
      const t = this.liveLogin(a, await this.liveTerminals());
      if (t) {
        await core(["kill", t.address]).catch(() => null);
        await core(["rm", t.address]).catch(() => null);
      }
      delete this.logins[key];
      if (a.pending) await this.discard(a, cx);
      delete this.busy[key];
      cx.notify();
    });
  }

  // Out of the state first (no new agent starts on it), then its folder (profile.mjs deletes the
  // links as links, never what they point to).
  async discard(a, cx) {
    const key = keyOf(a);
    if (a.id === "default") return false;
    const st = await updateState((s) => {
      s.accounts = s.accounts.filter((x) => keyOf(x) !== key);
      if (s.active[a.tool] === a.id) s.active[a.tool] = "default";
    });
    const r = await exec("node", [`${accountsDir()}/profile.mjs`, "remove", a.tool, a.id]).catch((e) => ({ stdout: "", stderr: String(e) }));
    const out = lastJson(r.stdout);
    delete this.info[key];
    delete this.logins[key];
    run("usage-card.accounts");
    if (!st || !out?.ok) {
      this.notes[a.tool] = { kind: "error", text: `Couldn't remove that account completely${out?.error ? `: ${out.error}` : "."}`, at: Date.now() };
      return false;
    }
    return true;
  }

  remove(a, cx) {
    const key = keyOf(a);
    this.edit = null;
    this.busy[key] = "removing";
    cx.notify();
    cx.spawn(async (cx) => {
      await this.discard(a, cx);
      delete this.busy[key];
      this.handle.focus();
      cx.notify();
    });
  }

  startRename(a, cx) {
    this.menu = null;
    this.edit = { key: keyOf(a), action: "rename" };
    this.input.set_value(a.name ?? "");
    this.input.focus();
    cx.notify();
  }

  saveRename(cx) {
    const e = this.edit;
    if (e?.action !== "rename") return;
    const name = cleanName(this.input.value());
    this.edit = null;
    this.handle.focus();
    cx.spawn(async (cx) => {
      await updateState((s) => {
        const a = s.accounts.find((x) => keyOf(x) === e.key);
        if (!a || (a.name ?? "") === name) return false;
        if (name) a.name = name;
        else delete a.name;
      });
      cx.notify();
    });
    cx.notify();
  }

  cancelEdit(cx) {
    this.edit = null;
    this.menu = null;
    this.handle.focus();
    cx.notify();
  }

  toggleAuto(cx) {
    cx.spawn(async (cx) => {
      await updateState((s) => { s.auto.enabled = !s.auto.enabled; });
      cx.notify();
    });
  }

  // The threshold is written once the clicks stop (one write, not one per click).
  bumpThreshold(d, cx) {
    const now = this.thDraft ?? currentState().auto.threshold;
    this.thDraft = Math.max(50, Math.min(100, now + d));
    const token = ++this.thToken;
    cx.notify();
    cx.timer.after(450, (cx) => {
      if (token !== this.thToken) return;
      const v = this.thDraft;
      cx.spawn(async (cx) => {
        await updateState((s) => {
          if (s.auto.threshold === v) return false;
          s.auto.threshold = v;
        });
        if (token === this.thToken) this.thDraft = null;
        cx.notify();
      });
    });
  }

  // ---- pieces ----

  heading(t, text) {
    return div().pt(6).pb(8).text_size(12).font_semibold().text_color(t.dim).child(text.toUpperCase());
  }

  // Atrous's switch (Settings > Alerts).
  toggle(t, id, on, onClick) {
    return div().id(id).w(36).h(20).rounded(10).p(2).cursor_pointer().bg(on ? t.accent : t.hover).flex()
      .when(on, (el) => el.justify_end())
      .on_click(onClick)
      .child(div().w(16).h(16).rounded(8).bg(on ? t.accent_foreground : t.muted));
  }

  smallButton(t, id, label, onClick, kind) {
    return div().id(id).flex_none().px(10).py(4).rounded(6).cursor_pointer().text_size(12.5)
      .when(kind === "primary", (el) => el.bg(t.accent).text_color(t.accent_foreground).font_medium().hover((s) => s.opacity(0.9)))
      .when(kind === "danger", (el) => el.border_1().border_color(t.blocked).text_color(t.blocked).hover((s) => s.bg(t.hover)))
      .when(!kind, (el) => el.border_1().border_color(t.border).bg(t.raised).text_color(t.foreground).hover((s) => s.bg(t.hover)))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(onClick)
      .child(label);
  }

  spinner(t) {
    return svg(SPINNER).size(12).flex_none().text_color(t.muted).spin(900);
  }

  avatar(t, seed, name, email, dim) {
    // Nobody to show yet (a login in progress): an empty dashed circle.
    if (!name && !email) return div().size(32).flex_none().rounded(16).border_1().border_dashed().border_color(t.input);
    const c = tint(t, seed);
    return div().size(32).flex_none().rounded(16).flex().items_center().justify_center()
      .bg(alpha(c, "26")).border_1().border_color(alpha(c, "4d"))
      .when(Boolean(dim), (el) => el.opacity(0.55))
      .text_size(12.5).font_semibold().text_color(c).child(initials(name, email));
  }

  // The filled radio of the active account, an empty one for the others.
  radio(t, key, on, onClick) {
    const el = div().id(`ac-radio-${key}`).size(18).flex_none().rounded(9).flex().items_center().justify_center();
    if (on) return el.bg(t.accent).tooltip("New agents start on this account").child(svg(I("check")).size(11).text_color(t.accent_foreground));
    if (!onClick) return el.border_2().border_color(t.border).opacity(0.5);
    return el.border_2().border_color(t.input).cursor_pointer().hover((s) => s.border_color(t.accent)).tooltip("Use for new agents").on_click(onClick);
  }

  // The two limits that matter now, as the sidebar card draws them.
  limits(t, a, u) {
    const rows = pairRows(a.tool, u?.rows);
    const box = v_flex().id(`ac-lim-${keyOf(a)}`).w(150).flex_none().gap(5);
    if (!rows.length) {
      const text = u?.fetching ? "Updating…" : u?.note ? "Updates on next use" : u?.error && u.error !== "Not logged in" ? u.error : "";
      return box.child(div().text_size(11.5).text_color(t.dim).truncate().child(text));
    }
    const color = (p) => (p >= 90 ? t.blocked : p >= 70 ? t.ansi3 : t.accent);
    const tip = (u.rows ?? []).map((r) => `${r.label} ${Math.round(r.pct ?? 0)}%`).join(" · ") + (u.fetching ? " · updating…" : u.stale ? " · not updated" : "");
    return box.tooltip(tip).when(Boolean(u.fetching || u.stale), (el) => el.opacity(0.6)).children(rows.map((r) => {
      const pct = Math.max(0, Math.min(100, r.pct ?? 0));
      return h_flex().h(12).gap(7).items_center().text_size(11)
        .child(div().w(30).flex_none().text_color(t.dim).child(r.label))
        .child(div().flex_1().h(4).rounded(2).bg(t.border)
          .when(pct > 0, (el) => el.child(div().h_full().w(`${Math.max(pct, 3)}%`).rounded(2).bg(color(pct)))))
        .child(div().w(30).flex_none().text_right().font_medium().text_color(pct >= 70 ? color(pct) : t.muted).child(`${Math.round(pct)}%`));
    }));
  }

  moreMenu(t, a) {
    const key = keyOf(a);
    const item = (id, label, onClick, danger) => div().id(id).px(10).py(6).rounded(6).cursor_pointer().text_size(13)
      .text_color(danger ? t.blocked : t.foreground).hover((s) => s.bg(t.hover)).on_click(onClick).child(label);
    const items = [item(`ac-m-rename-${key}`, "Rename", (_e, cx) => this.startRename(a, cx))];
    if (a.id !== "default") {
      items.push(item(`ac-m-login-${key}`, "Log in again", (_e, cx) => cx.spawn(async (cx) => this.startLogin(a, false, cx))));
      items.push(div().my(3).h(1).bg(t.border));
      items.push(item(`ac-m-remove-${key}`, "Remove…", (_e, cx) => { this.menu = null; this.edit = { key, action: "remove" }; cx.notify(); }, true));
    }
    return Popover.new(`ac-menu-${key}`).anchor("top_right").open(this.menu === key)
      .on_open_change((open, cx) => { this.menu = open ? key : this.menu === key ? null : this.menu; cx.notify(); })
      .trigger(div().id(`ac-more-${key}`).size(28).flex_none().rounded(6).flex().items_center().justify_center().text_color(t.muted)
        .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).child(svg(I("ac-more")).size(16)))
      .content(v_flex().w(168).p(4).rounded(8).border_1().border_color(t.border).bg(t.popover).shadow_lg().children(items));
  }

  // ---- the page ----

  accountRow(t, st, a, u, running) {
    const key = keyOf(a);
    const info = this.info[key] ?? {};
    const email = info.email ?? a.email ?? null;
    const name = displayName(a, email);
    const active = st.active[a.tool] === a.id;
    const login = this.logins[key];
    const waiting = Boolean(a.pending && login && !login.done);
    const unfinished = Boolean(this.loaded && a.pending && !login && info.state !== "in");
    const checking = Boolean(!this.loaded && a.pending && !login);
    const loggedIn = info.state === "in" || (!info.state && u?.login === "in");
    const pickable = !active && loggedIn && !a.pending;
    const edit = this.edit?.key === key ? this.edit : null;
    const plan = info.plan || u?.plan || "";

    let second = null;
    if (waiting) second = h_flex().gap(6).items_center().child(this.spinner(t)).child(div().text_size(12).text_color(t.muted).child("Waiting for you to sign in…"));
    else if (unfinished) second = div().text_size(12).text_color(t.dim).child("The sign-in didn't finish");
    else if (checking) second = h_flex().gap(6).items_center().child(this.spinner(t)).child(div().text_size(12).text_color(t.muted).child("Checking…"));
    else if (login && !login.done) second = h_flex().gap(6).items_center().child(this.spinner(t)).child(div().text_size(12).text_color(t.muted).child("Logging in…"));
    else if (info.state === "expired") second = div().text_size(12).text_color(t.blocked).child(email ? `${email} · login expired` : "Login expired");
    else if (info.state === "out" && !a.pending) second = div().text_size(12).text_color(t.dim).child("Not logged in");
    else {
      const bits = [name !== email ? email : null, running ? `${running} agent${running === 1 ? "" : "s"} running` : null].filter(Boolean);
      if (bits.length) second = div().text_size(12).text_color(t.dim).truncate().child(bits.join(" · "));
    }

    const nameLine = edit?.action === "rename"
      ? h_flex().gap(6).items_center()
        .child(Input.new(this.input).w(220).h(26).px(8).rounded(6).border_1().border_color(this.inputFocused ? t.accent : t.input).bg(t.background).text_size(13).text_color(t.foreground))
        .child(div().text_size(11.5).text_color(t.dim).child(email ? "Empty: show the email" : ""))
      : h_flex().gap(8).items_center().min_w(0)
        .child(div().min_w(0).truncate().text_size(13.5).font_semibold().text_color(t.foreground).child(a.pending && !email ? `New ${TOOLS[a.tool].name} account` : name))
        .when(Boolean(plan) && !a.pending, (el) => el.child(div().flex_none().px(6).py(1).rounded(5).border_1().border_color(t.border).text_size(10.5).font_medium().text_color(t.muted).child(plan)));

    // Left: avatar, name, email, limits (a click here picks the account).
    const left = h_flex().id(`ac-pick-${key}`).flex_1().min_w(0).gap(12).items_center()
      .when(pickable && !edit, (el) => el.cursor_pointer().on_click((_e, cx) => this.use(a, cx)))
      .child(this.avatar(t, email ?? key, a.name, email, a.pending || !loggedIn))
      .child(v_flex().flex_1().min_w(0).gap(2).child(nameLine).when(Boolean(second), (el) => el.child(second)))
      .when(!a.pending && !edit, (el) => el.child(this.limits(t, a, u)));

    // Right: what can be done now.
    const right = h_flex().flex_none().gap(8).items_center();
    if (this.busy[key]) right.child(this.spinner(t)).child(div().text_size(12).text_color(t.muted).child(this.busy[key] === "cancelling" ? "Cancelling…" : "Removing…"));
    else if (edit?.action === "rename") right.child(this.smallButton(t, `ac-rn-cancel-${key}`, "Cancel", (_e, cx) => this.cancelEdit(cx))).child(this.smallButton(t, `ac-rn-save-${key}`, "Save", (_e, cx) => this.saveRename(cx), "primary"));
    else if (edit?.action === "remove") {
      right.child(div().text_size(12.5).text_color(t.muted).child(running ? `${running} agent${running === 1 ? " uses" : "s use"} it. Remove?` : "Remove this account?"))
        .child(this.smallButton(t, `ac-rm-cancel-${key}`, "Cancel", (_e, cx) => this.cancelEdit(cx)))
        .child(this.smallButton(t, `ac-rm-go-${key}`, "Remove", (_e, cx) => this.remove(a, cx), "danger"));
    } else if (waiting) {
      right.child(this.smallButton(t, `ac-wait-cancel-${key}`, "Cancel", (_e, cx) => this.cancelLogin(a, cx)))
        .child(this.smallButton(t, `ac-wait-open-${key}`, "Open", (_e, cx) => this.startLogin(a, true, cx), "primary"));
    }
    else if (unfinished) {
      right.child(this.smallButton(t, `ac-discard-${key}`, "Discard", (_e, cx) => cx.spawn(async (cx) => { await this.discard(a, cx); cx.notify(); })))
        .child(this.smallButton(t, `ac-finish-${key}`, "Finish login", (_e, cx) => cx.spawn(async (cx) => this.startLogin(a, true, cx)), "primary"));
    } else {
      if (a.id !== "default" && (info.state === "out" || info.state === "expired") && !login) {
        right.child(this.smallButton(t, `ac-relogin-${key}`, "Log in", (_e, cx) => cx.spawn(async (cx) => this.startLogin(a, false, cx)), "primary"));
      }
      right.child(this.moreMenu(t, a)).child(this.radio(t, key, active, pickable ? (_e, cx) => this.use(a, cx) : null));
    }

    return h_flex().id(`ac-row-${key}`).w_full().px(16).py(12).gap(14).items_center().border_b(1).border_color(t.border)
      .when(pickable && !edit, (el) => el.hover((s) => s.bg(t.hover)))
      .child(left)
      .child(right);
  }

  note(t, tool, st) {
    const n = this.notes[tool];
    if (!n) return null;
    if (n.kind === "success") {
      const a = st.accounts.find((x) => keyOf(x) === n.key);
      const active = a && st.active[tool] === a.id;
      return h_flex().w_full().px(16).py(10).gap(10).items_center().border_b(1).border_color(t.border).bg(alpha(t.accent, "14"))
        .child(svg(I("check")).size(14).flex_none().text_color(t.accent))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(n.email ? `Logged in as ${n.email}` : "Logged in"))
        .when(Boolean(a) && !active, (el) => el.child(this.smallButton(t, `ac-note-use-${tool}`, "Use for new agents", (_e, cx) => { this.use(a, cx); delete this.notes[tool]; }, "primary")))
        .child(this.smallButton(t, `ac-note-ok-${tool}`, active ? "Done" : "Not now", (_e, cx) => { delete this.notes[tool]; cx.notify(); }));
    }
    return h_flex().w_full().px(16).py(9).border_b(1).border_color(t.border)
      .child(div().text_size(12.5).text_color(n.kind === "error" ? t.blocked : t.dim).child(n.text));
  }

  card(t, st, tool, usage, running) {
    const accs = accountsOf(st, tool);
    const active = activeOf(st, tool);
    const activeName = displayName(active, this.info[keyOf(active)]?.email);
    const adding = this.busy[tool] === "adding";
    const note = this.note(t, tool, st);
    return v_flex().w_full().rounded(10).border_1().border_color(t.border).bg(t.surface).overflow_hidden()
      .child(h_flex().h(46).px(16).gap(10).items_center().border_b(1).border_color(t.border)
        .child(image(TOOLS[tool].icon).size(18).flex_none())
        .child(div().flex_none().text_size(14).font_semibold().text_color(t.foreground).child(TOOLS[tool].name))
        .child(div().flex_1())
        .child(div().min_w(0).truncate().text_size(12.5).text_color(t.dim).child(`New agents use ${activeName}`)))
      .children(accs.map((a) => this.accountRow(t, st, a, usage[keyOf(a)], running[keyOf(a)] ?? 0)))
      .when(Boolean(note), (el) => el.child(note))
      .child(div().p(12).child(
        h_flex().id(`ac-add-${tool}`).w_full().h(38).gap(7).items_center().justify_center().rounded(8)
          .border_1().border_dashed().border_color(t.input).text_size(13).text_color(t.muted)
          .when(!adding, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.add(tool, cx)))
          .child(adding ? this.spinner(t) : svg(I("ac-plus")).size(14))
          .child(adding ? "Setting it up…" : `Add another ${TOOLS[tool].name} account`)));
  }

  autoRow(t, st) {
    const on = st.auto.enabled;
    const th = this.thDraft ?? st.auto.threshold;
    const step = (k, label, d) => div().id(`ac-th-${k}`).w(26).h(26).flex().items_center().justify_center().cursor_pointer()
      .text_size(14).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.bumpThreshold(d, cx)).child(label);
    const stepper = h_flex().items_center().rounded(7).border_1().border_color(t.border).bg(t.raised).overflow_hidden()
      .when(!on, (el) => el.opacity(0.45))
      .child(step("minus", "−", -5))
      .child(div().w(44).flex().justify_center().text_size(12.5).text_color(t.foreground).child(`${th}%`))
      .child(step("plus", "+", 5));
    return h_flex().w_full().gap(16).py(12).items_center()
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(div().text_size(14).text_color(t.foreground).child("Switch accounts automatically"))
        .child(div().text_size(12.5).line_height("18px").text_color(t.dim)
          .child(`When the account in use reaches ${th}% of its limit, new agents start on the next account with room.`)))
      .child(h_flex().flex_none().gap(14).items_center()
        .child(stepper)
        .child(this.toggle(t, "ac-auto", on, (_e, cx) => this.toggleAuto(cx))));
  }

  render() {
    const t = theme();
    const st = currentState();
    const usage = shared("accounts.usage") ?? {};
    const running = {};
    for (const term of terminals()) {
      const v = term.labels?.["atrous-account"];
      if (v && term.state === "live") running[v] = (running[v] ?? 0) + 1;
    }
    return v_flex().id("acct-page").track_focus(this.handle).w_full()
      .on_key_down((e, cx) => {
        if (e.key !== "escape" || (!this.edit && !this.menu)) return;
        cx.stop_propagation();
        this.cancelEdit(cx);
      })
      .child(this.heading(t, "Accounts"))
      .child(div().pb(16).text_size(12.5).line_height("18px").text_color(t.dim)
        .child("Use more than one Claude Code or Codex login. New agents start on the account picked here; agents already running keep theirs."))
      .child(v_flex().w_full().gap(16).children(TOOL_KEYS.map((tool) => this.card(t, st, tool, usage, running))))
      .child(div().h(22))
      .child(this.heading(t, "Switching"))
      .child(this.autoRow(t, st));
  }
}
