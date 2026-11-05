// devtools-dom-ui.js: small pieces the debug drawer's Elements and Application tabs share (devtools-elements.js,
// devtools-app.js): the helper's API, buttons, and a windowed list that builds only the rows on
// screen (its rows may carry their own click and hover handlers, which a virtual list's can't).

import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { props, settings, theme } from "herdr";

export const I = (name) => `mods/browser-panel/icons/${name}.svg`;

// The tabs keep their state and handlers on the Browser view (this.dte, this.dta, dte*/dta*
// methods): the registry's init puts the methods there, so main.js needs no change.
export function mixin(view, methods) {
  for (const [k, f] of Object.entries(methods)) if (!(k in view)) view[k] = f;
}
export const mono = () => settings()?.font_family || "JetBrains Mono";
export const stop = (_e, cx) => cx.stop_propagation();
export const clip = (s, n) => { const t = String(s ?? ""); return t.length > n ? `${t.slice(0, n)}…` : t; };
export const bytes = (n) => (n == null ? "" : n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(n >= 10240 ? 0 : 1)} kB` : `${n} B`);
export const syntax = (t = theme()) => ({ keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 });

// The helper's local API, on this panel's port (props.apiPort).
export const apiBase = () => `http://127.0.0.1:${Number(props()?.apiPort) || 9334}`;
async function answer(r) {
  let j;
  try { j = await r.json(); } catch { j = { ok: false, error: `The helper answered ${r.status}` }; }
  // An older helper doesn't know these routes yet.
  if (r.status === 404 && /^Unknown (GET |POST )?\/(dom|app)\//.test(String(j?.error ?? ""))) j.old = true;
  return j ?? { ok: false };
}
export async function apiGet(path) {
  try { return await answer(await fetch(`${apiBase()}${path}`)); }
  catch (e) { return { ok: false, error: "The browser helper isn't answering", offline: true }; }
}
export async function apiPost(path, body) {
  try { return await answer(await fetch(`${apiBase()}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) })); }
  catch (e) { return { ok: false, error: "The browser helper isn't answering", offline: true }; }
}

export function iconBtn(id, name, tip, action, t, o = {}) {
  return div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(6)
    .bg(o.active ? t.selected : t.background).text_color(o.active ? t.accent : t.muted)
    .when(Boolean(o.disabled), (el) => el.opacity(0.4))
    .when(!o.disabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop).on_click(action))
    .tooltip(tip).child(svg(I(name)).size(o.size ?? 13));
}

export function textBtn(id, label, action, t, o = {}) {
  const fg = o.primary ? t.solid_foreground : o.danger ? t.blocked : t.foreground;
  return h_flex().id(id).h(o.h ?? 22).px(o.px ?? 8).gap(5).flex_none().items_center().rounded(5).text_size(o.size ?? 11.5)
    .bg(o.primary ? t.solid : o.on ? t.selected : t.background).text_color(o.on ? t.foreground : fg)
    .when(!o.primary, (el) => el.border_1().border_color(o.on ? t.accent : t.input))
    .when(Boolean(o.disabled), (el) => el.opacity(0.45))
    .when(!o.disabled, (el) => el.cursor_pointer().hover((s) => (o.primary ? s.opacity(0.88) : s.bg(t.hover))).on_mouse_down("left", stop).on_click(action))
    .when(Boolean(o.tip), (el) => el.tooltip(o.tip))
    .when(Boolean(o.icon), (el) => el.child(svg(I(o.icon)).size(11)))
    .child(label);
}

export function notice(t, text, kind = "info", extra = null) {
  const c = kind === "error" ? t.blocked : kind === "warn" ? t.ansi3 : t.muted;
  return h_flex().flex_none().px(8).py(4).gap(8).items_center().border_b(1).border_color(t.border)
    .bg(kind === "error" ? `${t.blocked}14` : t.surface).text_size(11.5).text_color(c)
    .child(div().flex_1().min_w(0).child(text))
    .when(Boolean(extra), (el) => el.children(Array.isArray(extra) ? extra : [extra]));
}

// A list that builds only the rows in view. `s` is the caller's scroll state: { top, viewH }.
// render(i) returns row i's element (handlers allowed); every row is `rowH` tall.
export function windowed(id, total, rowH, s, render, t, onChange) {
  const viewH = Math.max(rowH, s.viewH || 200);
  const full = total * rowH;
  const maxTop = Math.max(0, full - viewH);
  const top = Math.max(0, Math.min(s.top || 0, maxTop));
  if (top !== s.top) s.top = top;
  const first = Math.floor(top / rowH), last = Math.min(total, first + Math.ceil(viewH / rowH) + 1);
  const rows = [];
  for (let i = first; i < last; i++) rows.push(render(i));
  const thumbH = full > viewH ? Math.max(18, (viewH * viewH) / full) : 0;
  const thumbTop = maxTop ? (top / maxTop) * (viewH - thumbH) : 0;
  const scrollTo = (y, cx) => { s.top = Math.max(0, Math.min(maxTop, y)); onChange?.(cx); cx.notify(); };
  return div().id(id).relative().flex_1().min_h(0).min_w(0).overflow_hidden()
    .on_size_change((size, cx) => {
      if (Math.abs((s.viewH || 0) - size.height) >= 1 || Math.abs((s.viewW || 0) - size.width) >= 1) { s.viewH = size.height; s.viewW = size.width; onChange?.(cx); cx.notify(); }
    })
    .on_scroll_wheel((e, cx) => {
      cx.stop_propagation();
      const dy = e.delta?.y ?? 0; // GPUI: positive scrolls up
      if (dy && maxTop) scrollTo(top - dy, cx);
    })
    .child(v_flex().absolute().left(0).right(0).top(first * rowH - top).children(rows))
    .when(thumbH > 0, (el) => el.child(div().id(`${id}-bar`).absolute().top(0).bottom(0).right(0).w(9)
      .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); const y = e.local_position?.y ?? 0; scrollTo((y / viewH) * full - viewH / 2, cx); })
      .child(div().absolute().right(1).w(6).top(thumbTop).h(thumbH).rounded(3).bg(t.input))));
}

// Keeps row `index` in view (centered when it was off screen).
export function scrollInto(s, index, rowH) {
  if (index < 0) return false;
  const y = index * rowH, viewH = s.viewH || 200;
  if (y >= (s.top || 0) && y + rowH <= (s.top || 0) + viewH) return false;
  s.top = Math.max(0, y - viewH / 2 + rowH / 2);
  return true;
}
