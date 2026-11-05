// Small builders for the devtools drawer's tabs (debug.js and the tab files), so every tab looks
// the same. They only describe elements: call them from render, never keep a cx.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";

export const ICON = (name) => `mods/browser-panel/icons/${name}.svg`;
export const stop = (_e, cx) => cx.stop_propagation();

export const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(n >= 10240 ? 0 : 1)} kB` : `${n ?? 0} B`);
export const ms = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 2)} s` : `${Math.round(n)} ms`);

// A request's name as DevTools shows it: the last path segment and the query.
export function nameOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol === "data:") return url.slice(0, 60);
    const seg = u.pathname.split("/").filter(Boolean).pop();
    return (seg ? decodeURIComponent(seg) : u.pathname === "/" ? u.host : u.pathname) + u.search;
  } catch { return url; }
}

// Hard-wraps text to `cols` columns (monospace), for rows whose height must be known up front.
export function wrap(text, cols, maxLines = 400) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    if (out.length >= maxLines) break;
    if (line.length <= cols) { out.push(line); continue; }
    for (let i = 0; i < line.length && out.length < maxLines; i += cols) out.push(line.slice(i, i + cols));
  }
  return out;
}

// Merges an incremental list answer (/devtools/console, /devtools/net) into s.{byN, list, gen, ver}:
// rows are keyed by n, which only grows; `first` is the oldest the helper still keeps.
export function mergeList(s, r) {
  if (r.reset || r.gen !== s.gen) {
    s.byN = new Map();
    for (const e of r.entries ?? []) s.byN.set(e.n, e);
  } else {
    for (const e of r.entries ?? []) s.byN.set(e.n, e);
    if (r.first) for (const n of s.byN.keys()) { if (n >= r.first) break; s.byN.delete(n); }
  }
  s.list = [...s.byN.values()];
  s.gen = r.gen;
  s.ver = r.ver;
}

export function ui(t) {
  const chip = (id, label, on, action, tip) => h_flex().id(id).h(22).px(7).flex_none().items_center().rounded(5).text_size(11)
    .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted)
    .cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click(action)
    .when(Boolean(tip), (el) => el.tooltip(tip)).child(label);
  const icon = (id, name, tip, action, opts = {}) => div().id(id).size(opts.size ?? 24).flex_none().flex().items_center().justify_center().rounded(6)
    .text_color(opts.color ?? t.muted).when(!opts.disabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(action))
    .when(Boolean(opts.disabled), (el) => el.opacity(0.4)).tooltip(tip).child(svg(ICON(name)).size(opts.icon ?? 13));
  const button = (id, label, action, opts = {}) => h_flex().id(id).h(opts.h ?? 24).px(opts.px ?? 9).gap(5).flex_none().items_center().rounded(6).text_size(11.5)
    .border_1().border_color(opts.primary ? t.solid : opts.danger ? t.blocked : t.input)
    .bg(opts.primary ? t.solid : t.raised).text_color(opts.primary ? t.solid_foreground : opts.danger ? t.blocked : t.foreground)
    .when(!opts.disabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.85)).on_click(action))
    .when(Boolean(opts.disabled), (el) => el.opacity(0.45))
    .when(Boolean(opts.tip), (el) => el.tooltip(opts.tip))
    .when(Boolean(opts.icon), (el) => el.child(svg(ICON(opts.icon)).size(12)))
    .child(label);
  // A checkbox-like toggle: a small box and its label.
  const toggle = (id, label, on, action, tip) => h_flex().id(id).h(22).px(5).gap(5).flex_none().items_center().rounded(5).text_size(11)
    .text_color(on ? t.foreground : t.muted).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(action)
    .when(Boolean(tip), (el) => el.tooltip(tip))
    .child(div().size(12).flex_none().rounded(3).border_1().border_color(on ? t.accent : t.input).bg(on ? t.accent : t.background)
      .flex().items_center().justify_center().text_size(9).text_color(t.accent_foreground ?? t.background).child(on ? "✓" : ""))
    .child(label);
  // A two-or-more-way choice drawn as joined pills.
  const segmented = (id, options, value, pick) => h_flex().id(id).h(22).flex_none().rounded(6).border_1().border_color(t.input).overflow_hidden()
    .children(options.map(([v, label, tip], i) => h_flex().id(`${id}-${v}`).h_full().px(8).items_center().text_size(11)
      .when(i > 0, (el) => el.border_l(1).border_color(t.input))
      .bg(value === v ? t.selected : t.background).text_color(value === v ? t.foreground : t.muted)
      .cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => pick(v, cx))
      .when(Boolean(tip), (el) => el.tooltip(tip)).child(label)));
  const tabs = (id, list, value, pick) => h_flex().id(id).h(28).flex_none().gap(2).items_center()
    .children(list.map(([v, label]) => h_flex().id(`${id}-${v}`).h_full().px(8).items_center().text_size(11.5)
      .border_b(2).border_color(value === v ? t.accent : t.background).text_color(value === v ? t.foreground : t.muted)
      .cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => pick(v, cx)).child(label)));
  const empty = (text, sub) => v_flex().flex_1().p(14).gap(4).text_size(12).text_color(t.dim).child(div().child(text))
    .when(Boolean(sub), (el) => el.child(div().text_size(11.5).text_color(t.dim).child(sub)));
  const section = (title, extra) => h_flex().h(24).mt(4).flex_none().items_center().gap(8)
    .child(div().text_size(11.5).font_semibold().text_color(t.foreground).child(title))
    .when(Boolean(extra), (el) => el.child(div().min_w(0).truncate().text_color(t.dim).text_size(11).child(String(extra))));
  // name: value rows, the value wrapping
  const kv = (rows, mono, keyW = 150) => v_flex().gap(1).children(rows.map(([k, v], i) => h_flex().id(`kv-${i}-${k}`).items_start().gap(10).py(1).text_size(11.5)
    .font_family(mono)
    .child(div().w(keyW).flex_none().text_color(t.muted).child(String(k)))
    .child(div().flex_1().min_w(0).text_color(t.foreground).child(String(v === "" ? " " : v)))));
  const tag = (text, color) => div().flex_none().px(5).h(16).rounded(4).border_1().border_color(color ?? t.border).text_size(10)
    .text_color(color ?? t.dim).flex().items_center().child(text);
  return { chip, icon, button, toggle, segmented, tabs, empty, section, kv, tag };
}
