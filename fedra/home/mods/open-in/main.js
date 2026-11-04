// The tab bar's "Open ▾" menu (opened by mods/my-tabs): the editors / IDEs installed here, each
// with its own icon, to open the shown project or worktree in. Picking one also makes it the
// default for the "Open" button (shared "ide.default"). "Look for editors again" re-runs
// detect.mjs. Props: { folder, overlay }.
//
// detect.mjs finds editors and their icons (data/ides.json); open.mjs starts one detached.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, theme, exec, appHome, readTextFile, shared, setShared, notify } from "herdr";

const I = (name) => `mods/open-in/${name}.svg`;
export const scriptOf = (name) => `${appHome().replace(/\\/g, "/")}/mods/open-in/${name}`;

export async function loadIdes() {
  const text = await readTextFile(`${appHome().replace(/\\/g, "/")}/data/ides.json`).catch(() => null);
  return text ? JSON.parse(text) : null;
}

export async function detectIdes() {
  const r = await exec("node", [scriptOf("detect.mjs"), appHome()]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "detection failed");
  return JSON.parse(r.stdout);
}

export async function openIn(ide, folder) {
  const r = await exec("node", [scriptOf("open.mjs"), JSON.stringify(ide), folder]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `couldn't start ${ide.name}`);
}

export default class OpenIn extends View {
  init(_props, cx) {
    this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.data = null;
    this.busy = false;
    cx.spawn(async (cx) => {
      this.data = await loadIdes();
      if (!this.data) await this.rescan(cx);
      cx.notify();
    });
  }

  async rescan(cx) {
    this.busy = true;
    cx.notify();
    try { this.data = await detectIdes(); } catch (e) { this.error = String(e?.message ?? e); }
    this.busy = false;
    cx.notify();
  }

  choose(ide, cx) {
    const p = props();
    setShared("ide.default", ide.id);
    closeOverlay(p.overlay);
    cx.spawn(async () => {
      try { await openIn(ide, p.folder); }
      catch (e) { notify({ title: `Couldn't open ${ide.name}`, body: String(e?.message ?? e), level: "error" }); }
    });
  }

  render() {
    const t = theme();
    const p = props() ?? {};
    const ides = this.data?.ides ?? [];
    const def = shared("ide.default") ?? ides.find((i) => !i.system)?.id;
    const editors = ides.filter((i) => !i.system);
    const system = ides.filter((i) => i.system);
    const row = (ide, i) => h_flex().id(`oi-${ide.id}`).h(31).px(8).gap(9).rounded(7).items_center().cursor_pointer()
      .text_color(t.foreground)
      .when(i === this.at, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.choose(ide, cx))
      .child(ide.icon ? image(ide.icon).w(16).h(16).flex_none() : div().size(16).flex_none().rounded(4).bg(t.raised))
      .child(div().flex_1().truncate().child(ide.name))
      .when(ide.id === def, (el) => el.child(svg(I("check")).size(13).flex_none().text_color(t.accent)));
    const all = [...editors, ...system];
    return v_flex().id("open-in").track_focus(this.handle).w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        if (!all.length) return;
        if (e.key === "down") this.at = (this.at + 1) % all.length;
        else if (e.key === "up") this.at = (this.at + all.length - 1) % all.length;
        else if (e.key === "enter") return this.choose(all[this.at], cx);
        else if (e.key === "escape") return closeOverlay(p.overlay);
        else return;
        cx.notify();
      })
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).truncate().child(`Open ${p.folder?.split(/[\\/]/).pop() ?? "project"} in`))
      .when(!this.data, (el) => el.child(h_flex().h(31).px(8).gap(8).items_center().text_color(t.dim)
        .child(svg(I("spinner")).size(12).spin(900)).child("Looking for editors…")))
      .children(editors.map((ide, i) => row(ide, i)))
      .when(Boolean(this.data) && editors.length === 0, (el) => el.child(div().px(8).py(6).text_color(t.dim).child("No editors found.")))
      .when(system.length > 0, (el) => el.child(div().mx(7).my(4).h(1).bg(t.border)))
      .children(system.map((ide, i) => row(ide, editors.length + i)))
      .child(div().mx(7).my(4).h(1).bg(t.border))
      .child(h_flex().id("oi-rescan").h(28).px(8).gap(9).rounded(7).items_center().cursor_pointer().text_color(t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => cx.spawn(async (cx) => this.rescan(cx)))
        .child(this.busy ? svg(I("spinner")).size(13).spin(900) : svg(I("refresh")).size(13))
        .child(div().text_size(12).child("Look for editors again")));
  }
}
