// The browser panel's UI inside the page (native view): the pick and annotate outlines, the pick
// action buttons, the note editor, the numbered badges and the annotations card.
//
// The helper (helper.mjs) runs this in an isolated world named "atrous" of every page it shows:
// the page's own scripts can't see these globals or the __atrousUi binding (it exists only in this
// world). Everything is drawn in one closed shadow root under a [data-atrous] element, which element
// screenshots, copied HTML and the page HTML sent to agents leave out. Drawn by the page itself,
// it moves with the page at its own frame rate: the panel never swaps the page for a still.
//
// Helper -> page: globalThis.__atrous.{init, mode, setNotes, picked, target, shotHide, shotShow, flash}
// Page -> helper: __atrousUi(JSON): {type: "pick" | "key" | "escape" | "copy" | "shot" | "note-save" |
//   "note-cancel" | "note-delete" | "send" | "copy-all" | "clear" | "collapse", ...}
(() => {
  if (globalThis.__atrous) return;
  const send = (o) => { try { globalThis.__atrousUi(JSON.stringify(o)); } catch {} };
  const NS = "http://www.w3.org/2000/svg";

  let theme = {
    bg: "#1c1e23", raised: "#26292f", border: "#383b42", fg: "#e7e8ea", muted: "#a6aab1", dim: "#80848c",
    accent: "#4c8dff", solid: "#e7e8ea", solidFg: "#141519", hover: "#2c2f36", input: "#41454d", danger: "#f0716b",
  };
  let icons = {}; // name -> { attrs, kids: [[tag, attrs]] }
  let mode = "off"; // "pick" | "annotate" | "off"
  let notes = []; // [{ n, id, tag, label, text, intent, url, here }]
  const marks = new Map(); // note id -> element on this page
  let collapsed = false, confirmClear = false;
  let hoverEl = null, selEl = null, flashEl = null;
  let editor = null; // { el, id, intent, title, selector }
  let shotHidden = [];
  const docId = Math.random().toString(36).slice(2, 8);
  let pickCount = 0;

  // ---- building blocks ----
  const h = (tag, cls, ...kids) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    for (const k of kids) if (k !== null && k !== undefined && k !== false) e.append(k);
    return e;
  };
  const icon = (name, size = 14) => {
    const s = document.createElementNS(NS, "svg");
    const spec = icons[name];
    s.setAttribute("viewBox", spec?.attrs?.viewBox || "0 0 24 24");
    s.setAttribute("width", size); s.setAttribute("height", size);
    for (const [k, v] of Object.entries({ fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" })) s.setAttribute(k, v);
    for (const [tag, attrs] of spec?.kids ?? []) {
      const c = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) c.setAttribute(k, v);
      s.append(c);
    }
    return s;
  };
  const button = (cls, iconName, label, onClick, title) => {
    const b = h("button", cls, iconName ? icon(iconName, cls.includes("ibtn") ? 13 : 13) : null, label ? h("span", null, label) : null);
    b.type = "button";
    if (title) b.title = title;
    b.addEventListener("click", (e) => { e.preventDefault(); onClick(e); });
    return b;
  };
  const clip = (s, n) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.root { position: fixed; left: 0; top: 0; width: 0; height: 0; font: 12.5px/1.35 "Segoe UI", system-ui, -apple-system, sans-serif; color: var(--fg); }
.box { position: fixed; display: none; border: 2px solid #fff; border-radius: 4px; pointer-events: none;
  box-shadow: 0 0 0 1px rgba(0,0,0,.7), inset 0 0 0 1px rgba(0,0,0,.7); }
.box.sel { border-color: var(--accent); }
.box.flash { border-color: var(--accent); border-style: dashed; }
.chip { position: fixed; display: none; height: 21px; padding: 0 7px; border-radius: 5px; pointer-events: none;
  background: rgba(17,20,24,.93); border: 1px solid rgba(255,255,255,.25); color: #fff;
  font: 11px/19px "JetBrains Mono", Consolas, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hint { position: fixed; top: 10px; left: 50%; transform: translateX(-50%); display: none; max-width: calc(100vw - 24px);
  padding: 5px 12px; border-radius: 14px; background: rgba(28,30,35,.92); border: 1px solid var(--border); color: var(--muted);
  font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none; box-shadow: 0 4px 14px rgba(0,0,0,.3); }
.hint b { color: var(--fg); font-weight: 600; }
.actions { position: fixed; display: none; gap: 6px; pointer-events: auto; }
.btn { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 11px; border-radius: 14px; cursor: pointer;
  border: 1px solid var(--border); background: var(--bg); color: var(--fg); font: 500 12px/1 "Segoe UI", system-ui, sans-serif;
  white-space: nowrap; box-shadow: 0 4px 14px rgba(0,0,0,.35); }
.btn:hover { background: var(--hover); }
.btn.primary { background: var(--solid); color: var(--solidFg); border-color: var(--solid); }
.btn.primary:hover { opacity: .9; }
.btn.danger { color: var(--danger); }
.btn.small { height: 26px; padding: 0 9px; border-radius: 7px; box-shadow: none; }
.btn svg { flex: none; }
.ibtn { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 24px; height: 24px; padding: 0;
  border: 0; border-radius: 6px; background: transparent; color: var(--dim); cursor: pointer; }
.ibtn:hover { background: var(--hover); color: var(--fg); }
.ibtn.del:hover { color: var(--danger); }
.editor { position: fixed; display: none; flex-direction: column; gap: 9px; width: 320px; padding: 12px; border-radius: 10px;
  border: 1px solid var(--border); background: var(--bg); box-shadow: 0 10px 30px rgba(0,0,0,.45); pointer-events: auto; }
.editor .title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.editor .selector { margin-top: -5px; font: 11px/1.3 "JetBrains Mono", Consolas, monospace; color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.editor textarea { width: 100%; min-height: 64px; max-height: 170px; resize: none; padding: 6px 8px; border-radius: 7px; outline: none;
  border: 1px solid var(--input); background: #141519; color: var(--fg); font: 12.5px/1.4 "Segoe UI", system-ui, sans-serif; }
.editor textarea:focus { border-color: var(--accent); }
.seg { display: flex; gap: 2px; padding: 2px; border-radius: 8px; border: 1px solid var(--border); }
.seg button { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 26px; border: 0; border-radius: 6px;
  background: transparent; color: var(--muted); font: 12px "Segoe UI", system-ui, sans-serif; cursor: pointer; }
.seg button.on { background: var(--raised); color: var(--fg); }
.row { display: flex; align-items: center; gap: 6px; }
.row.end { justify-content: flex-end; }
.kbd { font-size: 10.5px; opacity: .6; }
.marks { position: fixed; left: 0; top: 0; pointer-events: none; }
.mark { position: fixed; display: none; min-width: 18px; height: 18px; padding: 0 4px; border-radius: 9px; background: #2f6feb; color: #fff;
  font: 600 11px/18px system-ui, sans-serif; text-align: center; box-shadow: 0 1px 4px rgba(0,0,0,.45); outline: 1.5px solid #fff; }
.card { position: fixed; right: 12px; bottom: 12px; display: none; flex-direction: column; width: 300px; max-width: calc(100vw - 24px);
  border-radius: 10px; border: 1px solid var(--border); background: var(--bg); box-shadow: 0 10px 30px rgba(0,0,0,.45); pointer-events: auto; overflow: hidden; }
.card .head { display: flex; align-items: center; gap: 7px; height: 36px; padding: 0 6px 0 11px; border-bottom: 1px solid var(--border); }
.card .head .name { font-weight: 600; flex: 1; }
.count { min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: var(--raised); color: var(--muted); font: 600 11px/18px system-ui, sans-serif; text-align: center; }
.list { overflow-y: auto; padding: 4px; scrollbar-width: thin; scrollbar-color: #4a4e56 transparent; }
.item { display: flex; align-items: flex-start; gap: 8px; padding: 6px 4px 6px 7px; border-radius: 7px; cursor: pointer; }
.item:hover { background: var(--hover); }
.item .num { flex: none; width: 18px; height: 18px; margin-top: 1px; border-radius: 9px; background: #2f6feb; color: #fff; font: 600 10.5px/18px system-ui, sans-serif; text-align: center; }
.item .main { flex: 1; min-width: 0; }
.item .what { font-size: 11px; color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.item .text { color: var(--fg); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; word-break: break-word; }
.item .tools { display: flex; gap: 1px; flex: none; }
.foot { display: flex; align-items: center; gap: 6px; padding: 8px; border-top: 1px solid var(--border); }
.foot .grow { flex: 1; }
.foot .ask { flex: 1; color: var(--muted); font-size: 12px; }
.pill { position: fixed; right: 12px; bottom: 12px; display: none; align-items: center; gap: 7px; height: 30px; padding: 0 10px 0 8px; border-radius: 15px; cursor: pointer;
  border: 1px solid var(--border); background: var(--bg); color: var(--fg); font: 500 12px "Segoe UI", system-ui, sans-serif; box-shadow: 0 6px 20px rgba(0,0,0,.4); pointer-events: auto; }
.pill:hover { background: var(--hover); }
.up svg { transform: rotate(180deg); }
`;

  // ---- the shadow root ----
  let host = null, root = null, el = {};
  function build() {
    host = document.createElement("div");
    host.setAttribute("data-atrous", "ui");
    host.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;display:block;";
    root = host.attachShadow({ mode: "closed" });
    try { const sheet = new CSSStyleSheet(); sheet.replaceSync(CSS); root.adoptedStyleSheets = [sheet]; }
    catch { const st = document.createElement("style"); st.textContent = CSS; root.append(st); }
    const r = h("div", "root");
    el.root = r;
    el.hover = h("div", "box"); el.chip = h("div", "chip");
    el.sel = h("div", "box sel"); el.flash = h("div", "box flash");
    el.marks = h("div", "marks");
    el.hint = h("div", "hint");
    el.actions = h("div", "actions");
    el.copyBtn = button("btn", "code", "Copy HTML", () => { send({ type: "copy" }); });
    el.shotBtn = button("btn", "camera", "Screenshot", () => { send({ type: "shot" }); });
    el.actions.append(el.copyBtn, el.shotBtn);
    el.editor = buildEditor();
    el.card = h("div", "card");
    el.pill = h("div", "pill");
    el.pill.addEventListener("click", () => { collapsed = false; send({ type: "collapse", collapsed }); render(); });
    r.append(el.marks, el.hover, el.chip, el.flash, el.sel, el.hint, el.actions, el.editor, el.card, el.pill);
    root.append(r);
    // Keys, clicks and wheels inside this UI are its own: the page's handlers never see them.
    for (const t of ["keydown", "keyup", "keypress", "input", "beforeinput", "paste", "copy", "cut", "pointerdown", "pointerup",
      "mousedown", "mouseup", "click", "dblclick", "contextmenu", "wheel", "focusin", "focusout"]) host.addEventListener(t, (e) => e.stopPropagation());
    applyTheme();
  }
  // Into <html>, after <body>. At document start there is no <html> yet: appending to the document
  // then would make this the document's element and the page would never build. So it waits.
  let waiting = false;
  function attach() {
    const parent = document.documentElement;
    if (!parent) {
      if (!waiting) {
        waiting = true;
        const go = () => { if (!document.documentElement) return; waiting = false; document.removeEventListener("readystatechange", go); render(); };
        document.addEventListener("readystatechange", go);
      }
      return false;
    }
    if (!host) build();
    if (host.parentNode !== parent || host.nextSibling) parent.appendChild(host);
    return true;
  }
  function applyTheme() {
    if (!el.root) return;
    for (const [k, v] of Object.entries(theme)) el.root.style.setProperty(`--${k}`, v);
  }

  // ---- the note editor ----
  function buildEditor() {
    const box = h("div", "editor ui");
    el.edTitle = h("div", "title");
    el.edSel = h("div", "selector");
    el.edText = document.createElement("textarea");
    el.edText.placeholder = "Describe a change, or ask a question…";
    el.edText.rows = 3;
    el.edText.addEventListener("input", () => { el.edText.style.height = "auto"; el.edText.style.height = Math.min(170, el.edText.scrollHeight + 2) + "px"; place(); });
    el.edText.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); cancelEditor(); }
      else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveEditor(); }
    });
    el.segChange = button("", "pencil", "Change", () => { editor.intent = "change"; renderEditor(); });
    el.segQuestion = button("", "question", "Question", () => { editor.intent = "question"; renderEditor(); });
    const seg = h("div", "seg", el.segChange, el.segQuestion);
    el.edCancel = button("btn small", null, "Cancel", () => cancelEditor());
    el.edSave = button("btn small primary", null, "Add", () => saveEditor());
    el.edSave.append(h("span", "kbd", "Ctrl↵"));
    box.append(el.edTitle, el.edSel, el.edText, seg, h("div", "row end", el.edCancel, el.edSave));
    return box;
  }
  function renderEditor() {
    if (!editor) { el.editor.style.display = "none"; return; }
    el.editor.style.display = "flex";
    el.edTitle.textContent = editor.title || "";
    el.edSel.textContent = editor.selector || "";
    el.segChange.classList.toggle("on", editor.intent !== "question");
    el.segQuestion.classList.toggle("on", editor.intent === "question");
    el.edSave.firstChild.textContent = editor.id ? "Save" : "Add";
  }
  function openEditor(target, note, pickId = null) {
    const info = describe(target);
    editor = { el: target, id: note?.id ?? null, pickId, intent: note?.intent ?? "change",
      title: note ? (note.label || `<${note.tag}>`) : info.title, selector: note ? note.tag : info.selector };
    el.edText.value = note?.text ?? "";
    el.edText.style.height = "auto";
    renderEditor();
    place();
    requestAnimationFrame(() => { try { el.edText.focus({ preventScroll: true }); } catch {} });
  }
  function cancelEditor() {
    if (!editor) return;
    const wasNew = !editor.id, pickId = editor.pickId;
    editor = null; selEl = null;
    renderEditor(); place();
    if (wasNew) send({ type: "note-cancel", pickId });
  }
  function saveEditor() {
    if (!editor) return;
    const text = el.edText.value.trim();
    if (!text) { el.edText.focus(); return; }
    send({ type: "note-save", text, intent: editor.intent, edit: editor.id, pickId: editor.pickId });
    editor = null; selEl = null;
    renderEditor(); place();
  }

  // ---- the annotations card ----
  function renderCard() {
    const n = notes.length;
    el.card.replaceChildren(); el.pill.replaceChildren();
    if (!n) { el.card.style.display = "none"; el.pill.style.display = "none"; return; }
    if (collapsed) {
      el.card.style.display = "none";
      el.pill.style.display = "inline-flex";
      el.pill.append(h("span", "count", String(n)), h("span", null, `annotation${n === 1 ? "" : "s"}`), h("span", "up", icon("chevron-down", 13)));
      return;
    }
    el.pill.style.display = "none";
    el.card.style.display = "flex";
    const head = h("div", "head", h("span", "name", "Annotations"), h("span", "count", String(n)),
      button("ibtn", "chevron-down", null, () => { collapsed = true; confirmClear = false; send({ type: "collapse", collapsed }); render(); }, "Collapse"));
    const list = h("div", "list");
    list.style.maxHeight = Math.max(80, Math.min(260, innerHeight - 170)) + "px";
    for (const note of notes) {
      const target = marks.get(note.id);
      const what = `${note.intent === "question" ? "Question" : "Change"} · <${note.tag}>${note.label ? " " + note.label : ""}${note.here || target ? "" : ` · ${note.host || "another page"}`}`;
      const row = h("div", "item",
        h("span", "num", String(note.n)),
        h("div", "main", h("div", "what", clip(what, 90)), h("div", "text", note.text)),
        h("div", "tools",
          button("ibtn", "pencil", null, () => openEditor(marks.get(note.id) ?? null, note), "Edit"),
          button("ibtn del", "trash", null, () => send({ type: "note-delete", id: note.id }), "Delete")));
      row.addEventListener("mouseenter", () => { flashEl = marks.get(note.id) ?? null; place(); });
      row.addEventListener("mouseleave", () => { flashEl = null; place(); });
      row.addEventListener("click", (e) => {
        if (e.target.closest && e.target.closest(".tools")) return;
        const t = marks.get(note.id);
        if (t) t.scrollIntoView({ block: "center", behavior: "smooth" });
      });
      list.append(row);
    }
    const foot = h("div", "foot");
    if (confirmClear) {
      foot.append(h("span", "ask", `Clear all ${n} annotation${n === 1 ? "" : "s"}?`),
        button("btn small", null, "Cancel", () => { confirmClear = false; renderCard(); }),
        button("btn small danger", "trash", "Clear", () => { confirmClear = false; send({ type: "clear" }); }));
    } else {
      foot.append(button("btn small primary", "send", "Send", () => send({ type: "send" })),
        button("btn small", "copy", "Copy all", () => send({ type: "copy-all" })),
        h("span", "grow"),
        button("btn small", "trash", "Clear", () => { confirmClear = true; renderCard(); }));
    }
    el.card.append(head, list, foot);
  }

  function renderHint() {
    if (mode === "off" || editor) { el.hint.style.display = "none"; return; }
    el.hint.replaceChildren(h("b", null, mode === "pick" ? "Pick" : "Annotate"),
      mode === "pick" ? "  ·  click an element, then Copy HTML or Screenshot (C / S)  ·  Esc" : "  ·  click an element to add a note  ·  Esc");
    el.hint.style.display = "block";
  }

  function render(now) {
    if (!attach()) return;
    renderCard();
    renderHint();
    renderEditor();
    el.actions.style.display = mode === "pick" && selEl ? "flex" : "none";
    if (now) placeNow(); else place();
  }

  // ---- placing what follows elements ----
  const vw = () => document.documentElement.clientWidth || innerWidth, vh = () => document.documentElement.clientHeight || innerHeight;
  function boxAround(b, r) {
    if (!r || !r.width && !r.height) { b.style.display = "none"; return; }
    b.style.display = "block";
    b.style.left = r.left - 3 + "px"; b.style.top = r.top - 3 + "px";
    b.style.width = Math.max(2, r.width) + 6 + "px"; b.style.height = Math.max(2, r.height) + 6 + "px";
  }
  const live = (e) => e && e.isConnected ? e.getBoundingClientRect() : null;
  // under the element when there is room, else above it, else inside the viewport's bottom
  function anchor(node, r, w, hgt) {
    const W = vw(), H = vh(), gap = 8;
    let left = r ? Math.max(8, Math.min(W - w - 8, r.left)) : (W - w) / 2;
    let top = r ? (r.bottom + gap + hgt <= H - 8 ? r.bottom + gap : r.top - gap - hgt >= 8 ? r.top - gap - hgt : Math.max(8, Math.min(H - hgt - 8, r.top + 10))) : Math.max(8, (H - hgt) / 2);
    top = Math.max(8, Math.min(H - hgt - 8, top)); // an element scrolled away doesn't take the box with it
    node.style.left = Math.round(left) + "px"; node.style.top = Math.round(top) + "px";
  }
  let raf = 0;
  function place() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; placeNow(); });
  }
  function placeNow() {
    if (!host) return;
    // hover outline and its label
    const hr = mode !== "off" && !editor && hoverEl && hoverEl !== selEl ? live(hoverEl) : null;
    boxAround(el.hover, hr);
    if (hr) {
      const t = describe(hoverEl);
      el.chip.textContent = `${t.label}  ${Math.round(hr.width)}×${Math.round(hr.height)}`;
      el.chip.style.display = "block";
      const top = hr.top - 26 >= 2 ? hr.top - 26 : hr.bottom + 26 <= vh() ? hr.bottom + 5 : Math.max(2, hr.top + 4);
      const left = Math.max(4, Math.min(hr.left - 3, vw() - 120));
      el.chip.style.top = top + "px"; el.chip.style.left = left + "px"; el.chip.style.maxWidth = Math.max(100, vw() - left - 6) + "px";
    } else el.chip.style.display = "none";
    // the selected element, its action buttons, the editor
    const sr = live(selEl);
    boxAround(el.sel, mode !== "off" ? sr : null);
    if (mode === "pick" && selEl && sr) { el.actions.style.display = "flex"; anchor(el.actions, sr, el.actions.offsetWidth || 230, 30); }
    else el.actions.style.display = "none";
    if (editor) anchor(el.editor, live(editor.el), el.editor.offsetWidth || 320, el.editor.offsetHeight || 230);
    boxAround(el.flash, live(flashEl));
    // the numbered badges
    for (const m of el.marks.children) {
      const t = marks.get(m.dataset.id), r = live(t);
      if (!r) { m.style.display = "none"; continue; }
      m.style.display = "block";
      m.style.left = Math.round(r.left - 9) + "px"; m.style.top = Math.round(r.top - 9) + "px";
    }
  }
  addEventListener("scroll", (e) => {
    if (mode === "pick" && selEl) { selEl = null; render(); } // scrolling dismisses the pick buttons
    place();
  }, { capture: true, passive: true });
  addEventListener("resize", () => { render(); }, { passive: true });
  setInterval(() => { if (host && (marks.size || selEl || editor)) placeNow(); }, 500); // layout shifts nothing reported

  // ---- what an element is called ----
  function describe(e) {
    if (!e || e.nodeType !== 1) return { title: "", selector: "", label: "" };
    const cls = [...e.classList].slice(0, 2).map((c) => "." + c).join("");
    const text = clip(e.innerText || e.textContent || e.getAttribute("aria-label") || e.getAttribute("alt") || "", 40);
    const parts = [];
    const esc = (s) => (globalThis.CSS && CSS.escape ? CSS.escape(s) : s);
    for (let n = e; n && n.nodeType === 1 && n !== document.documentElement && parts.length < 5; n = n.parentElement) {
      if (n.id) { parts.unshift("#" + esc(n.id)); break; }
      let s = n.localName;
      const c = [...n.classList].filter((x) => !/^\d/.test(x) && x.length < 40).slice(0, 2);
      if (c.length) s += "." + c.map(esc).join(".");
      parts.unshift(s);
    }
    return { label: `${e.localName}${e.id ? "#" + e.id : cls}${text ? ` "${text}"` : ""}`, title: text || `<${e.localName}>`, selector: parts.join(" > ") };
  }

  // ---- picking: the page doesn't get the pointer while a mode is on ----
  const ownEvent = (e) => e.target === host; // events from inside the closed shadow root are retargeted to it
  function pageTarget(e) {
    for (const n of e.composedPath ? e.composedPath() : []) {
      if (n === host) return null;
      if (n.nodeType === 1) return n;
    }
    return e.target && e.target.nodeType === 1 && e.target !== host ? e.target : null;
  }
  addEventListener("pointermove", (e) => {
    if (mode === "off" || editor || ownEvent(e)) return;
    const t = pageTarget(e);
    if (t !== hoverEl) { hoverEl = t; placeNow(); }
  }, { capture: true, passive: true });
  document.addEventListener("pointerleave", () => { if (hoverEl) { hoverEl = null; place(); } }, { passive: true });
  const swallow = (e) => { if (mode === "off" || ownEvent(e)) return; e.preventDefault(); e.stopImmediatePropagation(); };
  for (const t of ["mousedown", "pointerup", "mouseup", "click", "dblclick", "auxclick", "contextmenu"]) addEventListener(t, swallow, { capture: true });
  addEventListener("pointerdown", (e) => {
    if (mode === "off" || ownEvent(e)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.button !== 0) return;
    const t = pageTarget(e);
    if (mode === "pick") {
      if (selEl) { selEl = null; render(true); return; } // a click elsewhere dismisses the buttons
      if (!t) return;
      selEl = t; hoverEl = null;
      render(true);
      send({ type: "pick", mode });
    } else if (mode === "annotate") {
      if (editor) { cancelEditor(); return; } // a click outside closes the editor
      if (!t) return;
      selEl = t; hoverEl = null;
      const pickId = `${docId}-${++pickCount}`;
      send({ type: "pick", mode, pickId });
      openEditor(t, null, pickId);
      render(true);
    }
  }, { capture: true });
  addEventListener("keydown", (e) => {
    if (mode === "off" || ownEvent(e)) return;
    const k = (e.key || "").toLowerCase();
    if (k === "escape") {
      e.preventDefault(); e.stopImmediatePropagation();
      if (editor) cancelEditor();
      else if (selEl) { selEl = null; render(); }
      else send({ type: "escape" });
    } else if (mode === "pick" && !e.ctrlKey && !e.altKey && !e.metaKey && (k === "c" || k === "s")) {
      e.preventDefault(); e.stopImmediatePropagation();
      send({ type: "key", key: k });
    }
  }, { capture: true });

  // ---- the helper's side ----
  globalThis.__atrous = {
    init(o) {
      if (o.theme) theme = { ...theme, ...o.theme };
      if (o.icons) icons = o.icons;
      if (o.mode !== undefined) mode = o.mode;
      if (o.collapsed !== undefined) collapsed = o.collapsed;
      applyTheme();
      render();
    },
    mode(m) {
      mode = m;
      if (m === "off") { hoverEl = null; selEl = null; editor = null; }
      if (m !== "pick") selEl = editor ? selEl : null;
      render();
    },
    // the notes (in order) and the elements of those on this page (list items with el: true, in order)
    setNotes(list, ...els) {
      notes = list;
      marks.clear();
      let k = 0;
      for (const n of list) if (n.el) { const t = els[k++]; if (t && t.nodeType === 1) marks.set(n.id, t); }
      if (!attach()) return;
      el.marks.replaceChildren();
      for (const n of list) if (marks.has(n.id)) { const m = h("div", "mark", String(n.n)); m.dataset.id = n.id; el.marks.append(m); }
      if (editor?.id && !list.some((n) => n.id === editor.id)) editor = null;
      render();
    },
    picked() { return selEl; },
    debug() {
      const box = (n) => { if (!n) return null; const b = n.getBoundingClientRect(); return b.width ? { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) } : null; };
      const cardButtons = el.card ? Object.fromEntries([...el.card.querySelectorAll("button")].map((b, i) => [b.title || b.textContent.trim() || "b" + i, box(b)])) : {};
      return { mode, hover: hoverEl?.localName ?? null, sel: selEl?.localName ?? null, editor: Boolean(editor), notes: notes.length, marks: marks.size,
        attached: Boolean(host?.isConnected), text: el.edText?.value ?? null, focused: root?.activeElement?.localName ?? null,
        at: { save: box(editor && el.edSave), cancel: box(editor && el.edCancel), text: box(editor && el.edText), copy: box(el.actions?.style.display !== "none" && el.copyBtn), shot: box(el.actions?.style.display !== "none" && el.shotBtn), card: cardButtons,
          rows: el.card ? [...el.card.querySelectorAll(".item")].map(box) : [] } };
    },
    target() { return selEl || hoverEl; },
    // element screenshots: the parts of this UI over the element's box step aside for the capture
    shotHide(r) {
      if (!host) return 0;
      shotHidden = [];
      for (const n of [el.chip, el.hover, el.sel, el.flash, el.hint, el.actions, el.editor, el.card, el.pill, ...el.marks.children]) {
        if (!n || n.style.display === "none" || getComputedStyle(n).display === "none") continue;
        const b = n.getBoundingClientRect();
        if (b.right > r.x && b.left < r.x + r.w && b.bottom > r.y && b.top < r.y + r.h) { n.style.visibility = "hidden"; shotHidden.push(n); }
      }
      return shotHidden.length;
    },
    shotShow() { for (const n of shotHidden) n.style.visibility = ""; shotHidden = []; },
    // a short confirmation on a pick button
    flash(which, text) {
      const b = which === "shot" ? el.shotBtn : el.copyBtn;
      if (!b) return;
      const label = b.querySelector("span");
      const was = which === "shot" ? "Screenshot" : "Copy HTML";
      label.textContent = text;
      setTimeout(() => { label.textContent = was; }, 1300);
    },
  };
  render();
})();
