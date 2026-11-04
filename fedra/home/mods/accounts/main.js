// Accounts: two small jobs for the multi-account feature (Settings > Accounts lives in
// mods/my-settings/accounts.js; the launcher and profiles in ~/.config/herdr-app/accounts/).
//
// - `mod.open accounts` (the palette, a key, the usage card's switch toast): opens Settings on
//   its Accounts section and closes its own invisible popup (mod.json: 2x2 px, no frame), like
//   usage-stats does for Usage & activity.
// - props { role: "titlebar", terminal, title }: the bar on top of the login dialog Settings
//   opens over a login terminal (accounts/login.ps1). The dialog's Esc goes to the terminal, so
//   this bar's x is the way out: it ends the terminal (the dialog closes with it).

import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { props, openOverlay, closeOverlay, run, theme } from "herdr";

export default class Accounts extends View {
  init() {
    const p = props() ?? {};
    if (p.role === "titlebar") return;
    openOverlay({ mod: "my-settings", kind: "dialog", width: 960, height: 660, props: { section: "accounts" } });
    if (p.overlay) closeOverlay(p.overlay);
  }

  close_login() {
    const p = props() ?? {};
    if (p.terminal) run("terminal.kill", { terminal: p.terminal });
    if (p.overlay) closeOverlay(p.overlay);
  }

  render() {
    const p = props() ?? {};
    if (p.role !== "titlebar") return div();
    const t = theme();
    return h_flex().id("acct-bar").size_full().px(12).gap(8).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_medium().text_color(t.foreground).child(p.title ?? "Log in"))
      .child(div().text_size(11.5).text_color(t.dim).child("Esc goes to the terminal"))
      .child(div().id("acct-close").size(22).flex_none().flex().items_center().justify_center().rounded(5)
        .text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip("Cancel and close")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => this.close_login())
        .child(svg("mods/accounts/x.svg").size(13)));
  }
}
