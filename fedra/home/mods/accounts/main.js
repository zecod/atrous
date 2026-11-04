// Accounts: the sign-in dialog of Settings > Accounts, and the `mod.open accounts` launcher.
// (The Accounts page is mods/my-settings/accounts.js; launchers and account folders live in
// ~/.config/herdr-app/accounts/. accounts-core.js here is the same file as in my-settings and
// usage-card.)
//
// - `mod.open accounts` (the palette, a key, the usage card's toast): opens Settings on its
//   Accounts section and closes its own invisible popup (mod.json: 2x2 px, no frame).
// - props { role: "signin", tool, id, fresh }: the sign-in dialog. It runs the tool's own login in a
//   background herdr-core terminal named login-<tool>-<id> (accounts/login.ps1, login.sh on
//   macOS / Linux) and never shows that terminal unless asked ("Show details"):
//     waiting  "Sign in to <tool> in your browser": Copy link / Open again (the link read from the
//              terminal with `hc read`) / Cancel; Claude Code also takes a pasted code, typed into
//              the terminal with `hc send`;
//     success  credentials appeared in the account's folder: "Signed in as <email> · <plan>",
//              Use for new agents / Done (the account stops being pending);
//     failure  the terminal ended without them: one plain line, Try again / Close.
//   Hiding the dialog (its x, Esc) never stops the sign-in: the CLI keeps its callback server
//   running, so the browser can still come back to it; the Accounts row shows it as waiting.
//   A new account (`fresh`) is removed only by Cancel or by Close after a failure.
//   Only one sign-in per tool runs at a time: two `codex login`s share localhost:1455 and the
//   second cancels the first, so a second one is refused, and a cancelled one says so.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, openOverlay, closeOverlay, theme, hc, home, exec, window, run } from "herdr";
import { TOOLS, keyOf, currentState, updateState, setActive, readLogin, readEmail, displayName, accountsDir } from "./accounts-core.js";

const I = (name) => `mods/accounts/${name}.svg`;
const loginName = (tool, id) => `login-${tool}-${id}`.slice(0, 32);
const URL_RE = /https:\/\/[^\s"'<>]+/;
const alpha = (hex, aa) => (/^#[0-9a-f]{6}$/i.test(hex ?? "") ? `${hex}${aa}` : hex);

// What went wrong, in one plain line, from the end of the CLI's output.
function reasonFrom(screen, tool) {
  const s = String(screen ?? "");
  if (/Login cancelled/i.test(s)) return tool === "codex" ? "Another Codex sign-in started on this computer and replaced this one." : "The sign-in was cancelled.";
  if (/access[_ ]denied|denied|cancell?ed/i.test(s)) return "The sign-in was cancelled in the browser.";
  if (/address already in use|os error 10048|failed to start login server/i.test(s)) return "Another sign-in is using the login port. Close it, then try again.";
  if (/timed? ?out/i.test(s)) return "The sign-in timed out.";
  if (/invalid[_ ]?(code|grant)|code.*(invalid|expired)/i.test(s)) return "That code didn't work. Try again and paste the new one.";
  if (/ENOTFOUND|ECONNREFUSED|network|could not connect|failed to connect/i.test(s)) return "Couldn't reach the sign-in service. Check your connection.";
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^herdr-login:/.test(l) && !/^https?:\/\//.test(l));
  return lines.length ? `It stopped with: ${lines[lines.length - 1].slice(0, 120)}` : "The sign-in didn't finish.";
}

export default class Accounts extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.role = p.role === "signin" ? "signin" : "launcher";
    if (this.role === "launcher") {
      openOverlay({ mod: "my-settings", kind: "dialog", width: 960, height: 660, props: { section: "accounts" } });
      if (p.overlay) closeOverlay(p.overlay);
      return;
    }
    this.tool = p.tool;
    this.id = p.id;
    this.fresh = Boolean(p.fresh);
    this.phase = "starting"; // starting | waiting | success | failure
    this.address = null;
    this.screen = "";
    this.url = null;
    this.reason = null;
    this.email = null;
    this.plan = "";
    this.details = false;
    this.copied = 0;
    this.sent = 0;
    this.polling = false;
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.code = InputState.new({ placeholder: "Paste the code" });
    this.code.on("submit", (_e, cx) => this.sendCode(cx));
    cx.spawn(async (cx) => {
      await this.start();
      cx.notify();
    });
    cx.timer.every(1000, (cx) => this.poll(cx));
  }

  account() {
    return currentState().accounts.find((a) => a.tool === this.tool && a.id === this.id) ?? null;
  }

  async liveTerminals() {
    try {
      const r = await hc(["ls", "--json"]);
      return r.code === 0 ? (JSON.parse(r.stdout).terminals ?? []).filter((t) => t.state === "live") : null;
    } catch {
      return null;
    }
  }

  // Codex's login server always listens on localhost:1455: someone else's there means a second
  // `codex login` would cancel theirs (or theirs, ours). Windows only; elsewhere the name check does.
  async portBusy() {
    if (this.tool !== "codex" || window()?.platform !== "windows") return false;
    try {
      const r = await exec("netstat", ["-ano", "-p", "TCP"]);
      return /:1455\s+\S+\s+LISTENING/i.test(r.stdout);
    } catch {
      return false;
    }
  }

  // Follows the account's running sign-in, or starts one.
  async start() {
    const a = this.account();
    if (!a?.dir) return this.fail("This account isn't there anymore.");
    this.phase = "starting";
    this.url = null;
    this.screen = "";
    const live = await this.liveTerminals();
    if (live === null) return this.fail("herdr-core didn't answer. Try again in a moment.");
    const mine = live.find((t) => t.name === loginName(a.tool, a.id));
    if (mine) {
      this.address = mine.address;
      this.phase = "waiting";
      return;
    }
    if (live.some((t) => String(t.name ?? "").startsWith(`login-${a.tool}-`)) || (await this.portBusy())) {
      return this.fail(`Another ${TOOLS[a.tool].name} sign-in is running on this computer. Finish or cancel it, then try again.`);
    }
    const script = window()?.platform === "windows"
      ? ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", `${accountsDir()}/login.ps1`]
      : ["sh", `${accountsDir()}/login.sh`];
    try {
      const r = await hc(["run", "--bg", "--json", "--no-parent", "--no-notify", "--name", loginName(a.tool, a.id), "--cwd", home(), "--", ...script, a.tool, a.dir]);
      if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
      this.address = JSON.parse(r.stdout).address;
      this.phase = "waiting";
    } catch (e) {
      this.fail(`Couldn't start the sign-in${e?.message ? `: ${String(e.message).slice(0, 100)}` : "."}`);
    }
  }

  // Once a second: the account's credentials (done?), the terminal (ended?), its text (the link,
  // Claude Code's code prompt, the details).
  poll(cx) {
    if (this.role !== "signin" || this.polling || !this.address) return;
    if (this.phase !== "waiting" && !this.details) return;
    this.polling = true;
    cx.spawn(async (cx) => {
      try {
        const a = this.account();
        if (!a) return this.fail("This account isn't there anymore.");
        const login = this.phase === "waiting" ? await readLogin(a).catch(() => ({ state: "out" })) : null;
        const g = await hc(["get", this.address, "--json"]).then((r) => (r.code === 0 ? JSON.parse(r.stdout) : null)).catch(() => null);
        const text = await hc(["read", this.address, "--lines", "80"]).then((r) => (r.code === 0 ? r.stdout : null)).catch(() => null);
        if (text != null) {
          this.screen = text;
          const m = URL_RE.exec(text);
          if (m) this.url = m[0].replace(/[).,;]+$/, "");
          // Claude Code answers a pasted code on the prompt's line and asks again.
          const at = text.lastIndexOf("Paste code here");
          this.codeError = at >= 0 && /invalid code|invalid_grant|expired/i.test(text.slice(at)) ? "That code didn't work. Copy the whole code from the page and paste it again." : null;
        }
        if (login?.state === "in") await this.succeed(a, login);
        else if (this.phase === "waiting" && g && g.state !== "live") {
          const again = await readLogin(a).catch(() => ({ state: "out" }));
          if (again.state === "in") await this.succeed(a, again);
          else this.fail(reasonFrom(this.screen, this.tool));
        }
      } finally {
        this.polling = false;
        cx.notify();
      }
    });
  }

  async succeed(a, login) {
    if (this.phase === "success") return;
    this.phase = "success";
    this.plan = login.plan ?? "";
    this.email = await readEmail(a).catch(() => null);
    await updateState((s) => {
      const x = s.accounts.find((y) => keyOf(y) === keyOf(a));
      if (!x || (!x.pending && (!this.email || x.email === this.email))) return false;
      delete x.pending;
      if (this.email) x.email = this.email;
    });
    run("usage-card.accounts");
  }

  fail(reason) {
    this.phase = "failure";
    this.reason = reason;
  }

  // ---- actions ----

  async removeTerminal() {
    if (!this.address) return;
    const address = this.address;
    const g = await hc(["get", address, "--json"]).then((r) => JSON.parse(r.stdout)).catch(() => null);
    if (g?.state === "live") await hc(["kill", address]).catch(() => null);
    await hc(["rm", address]).catch(() => null);
    this.address = null;
  }

  // A new account that didn't get a login: out of the state, then its folder (links deleted as
  // links, never what they point to).
  async discard() {
    const a = this.account();
    if (!this.fresh || !a || a.id === "default" || !a.pending) return;
    await updateState((s) => {
      s.accounts = s.accounts.filter((x) => keyOf(x) !== keyOf(a));
      if (s.active[a.tool] === a.id) s.active[a.tool] = "default";
    });
    await exec("node", [`${accountsDir()}/profile.mjs`, "remove", a.tool, a.id]).catch(() => null);
    run("usage-card.accounts");
  }

  close() {
    const o = props()?.overlay;
    if (o) closeOverlay(o);
  }

  cancel(cx) {
    this.phase = "closing";
    cx.notify();
    cx.spawn(async () => {
      await this.removeTerminal();
      await this.discard();
      this.close();
    });
  }

  closeAfterFailure(cx) {
    this.phase = "closing";
    cx.notify();
    cx.spawn(async () => {
      await this.removeTerminal();
      await this.discard();
      this.close();
    });
  }

  done(cx, use) {
    cx.spawn(async () => {
      if (use) await setActive(this.tool, this.id, "user");
      await this.removeTerminal();
      this.close();
    });
  }

  tryAgain(cx) {
    this.reason = null;
    this.phase = "starting";
    cx.notify();
    cx.spawn(async (cx) => {
      await this.removeTerminal();
      await this.start();
      cx.notify();
    });
  }

  sendCode(cx) {
    const code = this.code.value().trim();
    if (!code || !this.address) return;
    this.code.set_value("");
    this.sent = Date.now();
    cx.spawn(async (cx) => {
      await hc(["send", this.address, code]).catch(() => null);
      cx.notify();
    });
    cx.notify();
  }

  // ---- drawing ----
  // Simple on purpose: a header (tool, title, x), one status line with a short hint, and a
  // footer bar: "Details" on the left, the buttons on the right. The dialog takes its content's
  // height (no fixed height), so there is no empty block.

  button(t, id, label, onClick, kind, disabled) {
    return div().id(id).flex_none().h(30).px(12).flex().items_center().rounded(7).text_size(12.5).font_medium()
      .when(Boolean(disabled), (el) => el.opacity(0.45))
      .when(!disabled, (el) => el.cursor_pointer().on_click(onClick))
      .when(kind === "primary", (el) => el.bg(t.solid).text_color(t.solid_foreground).when(!disabled, (e) => e.hover((s) => s.opacity(0.88))))
      .when(kind === "ghost", (el) => el.text_color(t.muted).when(!disabled, (e) => e.hover((s) => s.bg(t.hover).text_color(t.foreground))))
      .when(!kind, (el) => el.border_1().border_color(t.border).text_color(t.foreground).when(!disabled, (e) => e.hover((s) => s.bg(t.hover))))
      .child(label);
  }

  // The state as one small mark before the title: a spinner, a check, or an x.
  mark(t, kind) {
    const round = (c) => div().size(20).flex_none().rounded_full().bg(alpha(c, "2e")).flex().items_center().justify_center();
    if (kind === "ok") return round(t.ansi2).child(svg(I("check")).size(12).text_color(t.ansi2));
    if (kind === "bad") return round(t.blocked).child(svg(I("x")).size(11).text_color(t.blocked));
    return div().size(20).flex_none().flex().items_center().justify_center().child(svg(I("spinner")).size(15).text_color(t.muted).spin(900));
  }

  status(t, kind, title, hint) {
    return h_flex().gap(12).items_start()
      .child(this.mark(t, kind))
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(div().text_size(14).font_medium().line_height("20px").text_color(t.foreground).child(title))
        .when(Boolean(hint), (el) => el.child(div().text_size(12.5).line_height("18px").text_color(t.dim).child(hint))));
  }

  waiting(t, name) {
    const claude = this.tool === "claude";
    return v_flex().gap(14)
      .child(this.status(t, "wait", this.phase === "starting" ? "Opening your browser…" : `Sign in to ${name} in your browser`,
        "Signed in to another account there? Switch first, or open the link in a private window."))
      .when(claude && this.phase === "waiting", (el) => el.child(v_flex().gap(6).pl(32)
        .child(div().text_size(12).text_color(this.codeError ? t.blocked : t.dim)
          .child(this.codeError ?? (this.sent ? "Code sent. Finishing the sign-in…" : "Got a code instead? Paste it here.")))
        .child(h_flex().gap(8).items_center()
          .child(Input.new(this.code).flex_1().min_w(0).h(30).px(10).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(13).text_color(t.foreground))
          .child(this.button(t, "si-send", "Submit", (_e, cx) => this.sendCode(cx))))));
  }

  waitingButtons(t) {
    const linkReady = Boolean(this.url);
    return [
      this.button(t, "si-copy", Date.now() - this.copied < 2000 ? "Copied" : "Copy link",
        (_e, cx) => { cx.write_to_clipboard(this.url); this.copied = Date.now(); cx.notify(); }, "ghost", !linkReady),
      this.button(t, "si-open", "Open again", (_e, cx) => cx.open_url(this.url), "ghost", !linkReady),
      this.button(t, "si-cancel", "Cancel", (_e, cx) => this.cancel(cx)),
    ];
  }

  success(t) {
    const a = this.account();
    return this.status(t, "ok", "Signed in", [this.email ?? displayName(a), this.plan].filter(Boolean).join(" · "));
  }

  successButtons(t) {
    const a = this.account();
    const active = a && currentState().active[a.tool] === a.id;
    return active
      ? [this.button(t, "si-done", "Done", (_e, cx) => this.done(cx, false), "primary")]
      : [this.button(t, "si-done", "Done", (_e, cx) => this.done(cx, false)),
         this.button(t, "si-use", "Use for new agents", (_e, cx) => this.done(cx, true), "primary")];
  }

  failure(t) {
    return this.status(t, "bad", "The sign-in didn't finish", this.reason ?? "");
  }

  failureButtons(t) {
    return [
      this.button(t, "si-close", "Close", (_e, cx) => this.closeAfterFailure(cx)),
      this.button(t, "si-retry", "Try again", (_e, cx) => this.tryAgain(cx), "primary"),
    ];
  }

  detailsBox(t) {
    const lines = String(this.screen ?? "").split(/\r?\n/).map((l) => l.replace(/\s+$/, "")).filter((l, i, all) => l || (i > 0 && all[i - 1]));
    return div().id("si-log").h(140).p(10).rounded(8).border_1().border_color(t.border).bg(t.background).overflow_y_scroll()
      .child(v_flex().children((lines.length ? lines.slice(-40) : ["(nothing yet)"]).map((l) =>
        div().font_family("JetBrains Mono").text_size(11).line_height("16px").text_color(t.muted).child(l.length > 220 ? `${l.slice(0, 220)}…` : l || " "))));
  }

  render() {
    if (this.role !== "signin") return div();
    const t = theme();
    const name = TOOLS[this.tool]?.name ?? "the tool";
    const closing = this.phase === "closing";
    const body = this.phase === "success" ? this.success(t)
      : this.phase === "failure" ? this.failure(t)
      : closing ? this.status(t, "wait", "Closing…", null)
      : this.waiting(t, name);
    const buttons = this.phase === "success" ? this.successButtons(t)
      : this.phase === "failure" ? this.failureButtons(t)
      : closing ? [] : this.waitingButtons(t);
    return v_flex().id("signin").track_focus(this.handle).w_full().bg(t.popover)
      // header
      .child(h_flex().px(20).pt(14).gap(10).items_center()
        .child(image(TOOLS[this.tool]?.icon ?? "icons/agent.svg").size(16).flex_none())
        .child(div().flex_1().text_size(13).font_semibold().text_color(t.foreground)
          .child(this.fresh ? `Add a ${name} account` : `${name} · ${displayName(this.account())}`))
        .child(div().id("si-hide").size(24).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
          .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip(this.phase === "waiting" ? "Hide: the sign-in keeps waiting for your browser" : "Close")
          .on_click((_e, cx) => (this.phase === "failure" ? this.closeAfterFailure(cx) : this.phase === "success" ? this.done(cx, false) : this.close()))
          .child(svg(I("x")).size(12))))
      // body
      .child(v_flex().px(20).pt(16).pb(20).gap(12)
        .child(body)
        .when(this.details, (el) => el.child(this.detailsBox(t))))
      // footer
      .child(h_flex().px(16).py(10).gap(6).items_center().border_t(1).border_color(t.border)
        .child(div().id("si-details").px(4).text_size(12).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { this.details = !this.details; cx.notify(); this.poll(cx); })
          .child(this.details ? "Hide details" : "Details"))
        .child(div().flex_1())
        .children(buttons));
  }
}
