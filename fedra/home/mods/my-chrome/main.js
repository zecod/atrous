// Personal copy of the shipped `workspace-chrome` mod (cloned from 0.1.12). Change: the
// footer's Settings opens mods/my-settings (Settings plus a "Usage & activity" tab).
import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, props, window, shared, setShared, updates, layout } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

export default class WorkspaceChrome extends View {
  button(id, label, action) {
    const t = theme();
    return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(label);
  }
  render() {
    const t = theme();
    const collapsed = narrow();
    if (props()?.footer) {
      const row = (id, icon, label, dim, action) => h_flex().id(id).h(28).px(8).gap(9).items_center().rounded(8)
        .text_color(dim ? t.dim : t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)).cursor_pointer()
        .on_click(action).child(svg(`mods/my-chrome/${icon}.svg`).size(14))
        .when(!collapsed, el => el.child(label));
      return v_flex().size_full().bg(t.chrome).border_t(1).border_color(t.border).px(8).pt(4).pb(8).text_size(13)
        .child(row("settings", "settings", "Settings", false, () => run("mod.open", { name: "my-settings" }))
          .when(Boolean(updates().app.ready), el => el.child(div().size(6).rounded_full().bg(t.accent))))
        .child(row("machine", "plus", "Add machine", true, () => run("mod.open", { name: "machine-add" })));
    }
    return h_flex().size_full().bg(t.chrome).pl(collapsed ? 6 : 14).pr(10).gap(4).items_center().text_size(13.5)
      .when(window()?.platform === "macos" && !window()?.fullscreen && !collapsed, el => el.pl(76))
      .when(!collapsed, el => el.child(h_flex().flex_1().gap(8).items_center().child(image("frame/welcome/herdr.png").size(20).rounded(5)).child(div().font_semibold().text_color(t.foreground).child("Herdr"))))
      .when(!collapsed, el => el.child(this.button("search", svg("mods/my-chrome/search.svg").size(15), () => run("mod.open", { name: "picker" }))))
      // On the macOS rail the traffic lights fill the row; the agents list's » unfolds it.
      .when(!(collapsed && window()?.platform === "macos"), el => el.child(this.button("sidebar-toggle", svg("mods/my-chrome/sidebar.svg").size(15), toggleSidebar)));
  }
}

// >>> PERF-PROBE (temporary, remove) >>>
import { writeTextFile as __pwrite, appHome as __phome, props as __pprops } from "herdr";
import * as __pfs from "fs/promises";
{
  const P = WorkspaceChrome.prototype, r0 = P.render, i0 = P.init;
  const dir = `${String(__phome()).replace(/\\/g, "/")}/data/zz-perf-probe`;
  P.render = function (cx) {
    const S = this.__probe ??= { renders: 0, ms: 0, max: 0, slow: 0 };
    const t = Date.now();
    try { return r0.call(this, cx); }
    finally { const d = Date.now() - t; S.renders++; S.ms += d; if (d > S.max) S.max = d; if (d >= 16) S.slow++; }
  };
  P.init = function (props, cx) {
    const out = i0 ? i0.call(this, props, cx) : undefined;
    const S = this.__probe ??= { renders: 0, ms: 0, max: 0, slow: 0 };
    let label = "";
    try { const p = __pprops() ?? {}; label = p.part ?? (p.footer ? "footer" : "") ?? ""; } catch {}
    const id = `my-chrome${label ? "-" + label : ""}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const born = Date.now();
    let last = null;
    cx.timer.every(5000, (cx) => {
      cx.spawn(async () => {
        try {
          await __pfs.mkdir(dir, { recursive: true }).catch(() => {});
          const text = JSON.stringify({ mod: "my-chrome", label, id, born, at: Date.now(), ...S });
          await __pwrite(`${dir}/${id}.json`, text, last);
          last = text;
        } catch {}
      });
    });
    return out;
  };
}
// <<< PERF-PROBE <<<
