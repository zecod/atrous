// The debug drawer's Elements and Application tabs, helper side (devtools-elements.js and
// devtools-app.js draw them). helper.mjs calls registerDevtools(ctx) once and offers every API
// request to its route() first (the lines marked "devtools-dom hook" there).
//
// Everything here runs on a DevTools session of its own on the shown tab, so its DOM node ids,
// inspect mode, highlights and storage events never mix with the helper's (pick / annotate,
// console, network). The DOM tree is mirrored here from Chrome's DOM events and handed to the
// panel as flat rows, a window at a time: a page of fifty thousand nodes costs the panel only the
// few hundred rows around what it shows.
//
// Elements
//   GET  /dom/state?since=<ver>&tree=<tver>&from=<row>&count=<n>&wait=<ms>   long poll: selection,
//        inspect state, breadcrumbs; rows [from, from+count) when the tree changed since <tver>
//   GET  /dom/rows?from=&count=      a window of rows now     GET /dom/html?id=&max=   a node's outerHTML
//   POST /dom/open  /dom/close   /dom/expand {id, open, deep?}   /dom/select {id | backendNodeId | picked}
//        /dom/hover {id | null} (Chrome's highlight on the page)   /dom/inspect {on}   /dom/refresh
//        /dom/set-html {id, html} (DOM.setOuterHTML; text and comments: setNodeValue)   /dom/copy {id | page}
// Application (the shown page's origin)
//   GET  /app/watch?since=&wait=   long poll: something changed (storage events, navigation, edits)
//   GET  /app/cookies   POST /app/cookie-set {cookie, old?}  /app/cookie-delete {cookie}  /app/cookie-clear
//   GET  /app/storage?kind=local|session   POST /app/storage-set {kind, key, value, oldKey?}
//        /app/storage-remove {kind, key}  /app/storage-clear {kind}
//   GET  /app/idb   /app/idb-data?db=&store=&skip=      (read only)
//   GET  /app/caches   /app/cache-entries?cache=&skip=&filter=   /app/cache-response?cache=&url=
//   POST /app/cache-delete {cache, url?}   (an entry, or the whole cache)
//   GET  /app/workers   POST /app/worker-unregister {scope}
//   GET  /app/usage     POST /app/clear-site {types?}
//
// For agents (skills/atrous-browser/dom.mjs, `bp dom|cookies|local|session|idb`). Everything acts on
// the shown tab; errors are { ok: false, error } with an HTTP status.
//   POST /dom/query {selector, limit?=20}  -> {count, matches: [{nodeId, tag, id, classes, label, text, textLength, box, visible}]}
//   GET  /dom/html[?selector=|nodeId=][&all=1][&picked=1][&max=]  outerHTML: {nodeId, label, total, truncated, html}
//        (all=1: {count, items: [...]}; no selector: the whole page; picked=1: what the person picked or inspected)
//   POST /dom/set {selector | nodeId, outerHTML? | innerHTML? | text?, attributes?: {set: {k: v}, remove: [k]}, all?}
//        -> {count, changed: [{nodeId, was, now, html}]}  (live; the Elements tab follows)
//   POST /dom/remove {selector | nodeId, all?} -> {count, removed: [{nodeId, label}]}
//   GET  /dom/picked -> {picked: {mode, tag, selector, text, rect, url, html} | null, inspected: {nodeId, label, path, html} | null}
//   GET  /storage/cookies[?url=]  -> {url, count, cookies: [{name, value, domain, path, expires (-1: session), size, httpOnly, secure, sameSite, ...}]}
//   POST /storage/cookies/set {name, value, domain?, path?, expires? (epoch s or date), httpOnly?, secure?, sameSite?, url?} -> {cookie}
//   POST /storage/cookies/delete {name, domain?, path?, url?} -> {deleted}     POST /storage/cookies/clear {url?} -> {deleted}
//   GET  /storage/local[?origin=][&key=] -> {origin, count, entries: [{key, value}]} (with key: {found, value})
//   POST /storage/local/set {key, value, origin?}   /storage/local/remove {key, origin?}   /storage/local/clear {origin?}
//   ... and the same under /storage/session
//   GET  /storage/idb -> {origin, dbs: [{name, version, stores: [{name, keyPath, autoIncrement, count, indexes}]}]}
//   GET  /storage/idb/data?db=&store=[&index=][&skip=][&limit=50] -> {entries: [{key, primaryKey, value}], hasMore}
//        (values as JSON: Dates {$date}, binary {$binary: bytes}, Map {$map}, Set {$set})
//   POST /storage/idb/put {db, store, value, key?}  /storage/idb/delete {db, store, key}  (written by the page's origin, in an
//        isolated world: CDP has no IndexedDB writes)   POST /storage/idb/clear {db, store}

// Chrome DevTools' own highlight colors: content, padding, border, margin, and the size label.
const HL = {
  showInfo: true, showStyles: false, showRulers: false, showAccessibilityInfo: false, showExtensionLines: false,
  contentColor: { r: 111, g: 168, b: 220, a: 0.66 }, paddingColor: { r: 147, g: 196, b: 125, a: 0.55 },
  borderColor: { r: 255, g: 229, b: 153, a: 0.66 }, marginColor: { r: 246, g: 178, b: 107, a: 0.66 },
  eventTargetColor: { r: 255, g: 196, b: 196, a: 0.66 }, shapeColor: { r: 96, g: 82, b: 177, a: 0.8 },
  shapeMarginColor: { r: 96, g: 82, b: 127, a: 0.6 },
};
const TEXT_MAX = 160, ATTR_MAX = 90, ATTRS_MAX = 14, WINDOW_MAX = 1000, HTML_MAX = 250_000;
const IDLE_CLOSE_MS = 25_000; // no poll this long: the panel is gone, so inspect mode and the tree go too

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const clip = (s, n = TEXT_MAX) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const isWeb = (u) => /^https?:/i.test(u ?? "");
const STRIP_ATROUS = /<div data-atrous="[^"]*"[^>]*><\/div>/g; // the helper's own outline / note-marker hosts

export function registerDevtools(ctx) {
  const S = ctx.S;
  const log = (...a) => ctx.log("devtools:", ...a);
  let listening = null;

  // ---- the session ----------------------------------------------------------------------

  const sess = { targetId: null, id: null, attaching: null, gen: 0 };

  function cdp() {
    const c = ctx.cdp();
    if (!c || c.closed) throw httpErr(503, "The browser isn't connected yet");
    if (listening !== c) { c.listeners.push(onEvent); listening = c; }
    return c;
  }
  const send = (method, params = {}, timeout = 10000) => {
    if (!sess.id) return Promise.reject(httpErr(409, "No page session"));
    return cdp().send(method, params, sess.id, timeout);
  };

  async function session() {
    const c = cdp();
    const tid = S.targetId;
    if (!tid) throw httpErr(409, "No page is shown");
    if (sess.targetId === tid && sess.id) return sess.id;
    if (sess.targetId === tid && sess.attaching) return sess.attaching;
    dropSession("tab changed");
    sess.targetId = tid;
    const gen = sess.gen;
    sess.attaching = (async () => {
      const { sessionId } = await c.send("Target.attachToTarget", { targetId: tid, flatten: true }, undefined, 8000);
      if (gen !== sess.gen) { c.send("Target.detachFromTarget", { sessionId }).catch(() => {}); throw httpErr(409, "The shown tab changed"); }
      sess.id = sessionId;
      return sessionId;
    })();
    try { return await sess.attaching; } finally { if (gen === sess.gen) sess.attaching = null; }
  }

  function dropSession(why) {
    const c = ctx.cdp();
    if (sess.id && c && !c.closed) c.send("Target.detachFromTarget", { sessionId: sess.id }).catch(() => {});
    if (sess.id) log("session dropped:", why);
    sess.id = null; sess.targetId = null; sess.attaching = null; sess.gen++;
    resetDom(true);
    resetApp();
  }

  // ---- the DOM mirror -------------------------------------------------------------------

  const D = {
    nodes: new Map(), // nodeId -> { id, parent, type, name, local, value, attrs, count, kids, extra, backend, ... }
    doc: null, loaded: false, loading: null, open: false, lastPoll: 0,
    expanded: new Set(), sel: null, hover: null, inspecting: false, reveal: 0,
    tver: 1, rows: null, index: null, error: null, keep: null, kidWaiters: new Map(),
    edits: 0, // HTML changed by an Apply or by an agent: the tab reloads what its editor shows
    apiUse: 0, // the agents' API used the tree (it stays loaded a minute without the tab)
  };
  let ver = 1, wakers = [];
  function bump(tree) {
    if (tree) { D.tver++; D.rows = null; }
    ver++;
    const w = wakers; wakers = [];
    for (const f of w) f();
  }

  function resetDom(keepFlags) {
    D.nodes.clear(); D.doc = null; D.loaded = false; D.loading = null;
    D.expanded = new Set(); D.sel = null; D.chosen = false; D.hover = null; D.rows = null; D.index = null; D.error = null;
    if (!keepFlags) D.inspecting = false;
    for (const ws of D.kidWaiters.values()) for (const w of ws) w();
    D.kidWaiters.clear();
    bump(true);
  }

  function addNode(n, parent) {
    const rec = {
      id: n.nodeId, parent, type: n.nodeType, name: n.nodeName ?? "", local: n.localName ?? "", value: n.nodeValue ?? "",
      attrs: n.attributes ?? null, count: n.childNodeCount ?? 0, kids: null, extra: [], backend: n.backendNodeId,
      shadow: n.shadowRootType ?? null, pseudo: n.pseudoType ?? null, publicId: n.publicId ?? "", systemId: n.systemId ?? "",
    };
    const old = D.nodes.get(rec.id);
    if (old?.kids && !n.children) { rec.kids = old.kids; rec.count = old.count; } // a re-push without children keeps them
    if (old?.extra?.length && !n.shadowRoots && !n.contentDocument && !n.templateContent) rec.extra = old.extra;
    D.nodes.set(rec.id, rec);
    if (n.templateContent) { addNode(n.templateContent, rec.id); rec.extra.push(n.templateContent.nodeId); }
    for (const s of n.shadowRoots ?? []) { addNode(s, rec.id); rec.extra.push(s.nodeId); }
    if (n.contentDocument) { addNode(n.contentDocument, rec.id); rec.extra.push(n.contentDocument.nodeId); }
    if (n.children) {
      if (old?.kids) {
        const incoming = new Set(n.children.map((c) => c.nodeId));
        for (const k of old.kids) if (!incoming.has(k)) dropSubtree(k);
      }
      rec.kids = n.children.map((c) => (addNode(c, rec.id), c.nodeId));
      rec.count = rec.kids.length;
      const ws = D.kidWaiters.get(rec.id);
      if (ws) { D.kidWaiters.delete(rec.id); for (const w of ws) w(); }
    }
    return rec;
  }

  function dropSubtree(id) {
    const n = D.nodes.get(id);
    if (!n) return;
    for (const k of [...n.extra, ...(n.kids ?? [])]) dropSubtree(k);
    D.nodes.delete(id);
    D.expanded.delete(id);
  }

  const atrousOwn = (n) => n?.type === 1 && n.attrs && n.attrs.indexOf("data-atrous") >= 0 && n.attrs.indexOf("data-atrous") % 2 === 0;
  const kidsOf = (n) => [...n.extra, ...(n.kids ?? [])].filter((k) => !atrousOwn(D.nodes.get(k)));
  const tagOf = (n) => (n.pseudo ? `::${n.pseudo}` : (n.local || n.name.toLowerCase()));
  const attr = (n, name) => { const a = n.attrs ?? []; for (let i = 0; i < a.length; i += 2) if (a[i] === name) return a[i + 1]; return null; };
  function label(n) {
    if (!n) return "";
    if (n.type !== 1) return n.type === 3 ? "#text" : n.type === 8 ? "#comment" : n.type === 9 ? "#document" : n.type === 11 ? "#shadow-root" : n.name;
    const id = attr(n, "id"), cls = (attr(n, "class") ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
    return `${tagOf(n)}${id ? `#${id}` : ""}${cls.map((c) => `.${c}`).join("")}`;
  }

  function isInlineText(n) {
    if (n?.type !== 1 || n.extra.length || n.kids?.length !== 1) return null;
    const t = D.nodes.get(n.kids[0]);
    return t?.type === 3 && t.value.length <= 200 ? t : null;
  }

  function rowOf(n, d) {
    const kids = n.extra.length > 0 || n.count > 0;
    const inline = isInlineText(n);
    const open = kids && !inline && D.expanded.has(n.id);
    switch (n.type) {
      case 1: {
        const a = [];
        const src = n.attrs ?? [];
        for (let i = 0; i < src.length && a.length < ATTRS_MAX * 2; i += 2) a.push(src[i], clip(src[i + 1], ATTR_MAX));
        const r = { i: n.id, d, k: "e", n: tagOf(n), a, e: kids && !inline ? 1 : 0, o: open ? 1 : 0 };
        if (inline) r.x = clip(inline.value);
        if (src.length > ATTRS_MAX * 2) r.m = 1;
        return [r, open];
      }
      case 3: return [{ i: n.id, d, k: "t", x: clip(n.value) }, false];
      case 4: return [{ i: n.id, d, k: "t", x: `<![CDATA[${clip(n.value)}]]>` }, false];
      case 7: return [{ i: n.id, d, k: "c", x: `<?${n.name} ${clip(n.value)}?>` }, false];
      case 8: return [{ i: n.id, d, k: "c", x: clip(n.value) }, false];
      case 10: return [{ i: n.id, d, k: "dt", x: `<!DOCTYPE ${n.name}${n.publicId ? ` PUBLIC "${n.publicId}"` : ""}${n.systemId ? ` "${n.systemId}"` : ""}>` }, false];
      case 9: return [{ i: n.id, d, k: "doc", x: "#document", e: kids ? 1 : 0, o: open ? 1 : 0 }, open];
      case 11: return [{ i: n.id, d, k: "sr", x: n.shadow ? `#shadow-root (${n.shadow})` : "#document-fragment", e: kids ? 1 : 0, o: open ? 1 : 0 }, open];
      default: return [{ i: n.id, d, k: "t", x: clip(`${n.name} ${n.value}`) }, false];
    }
  }

  // The tree as the panel draws it, one row per line (an open element ends with its closing tag).
  function rows() {
    if (D.rows) return D.rows;
    const out = [], index = new Map();
    const visit = (id, d) => {
      const n = D.nodes.get(id);
      if (!n || atrousOwn(n)) return;
      const [r, open] = rowOf(n, d);
      index.set(id, out.length);
      out.push(r);
      if (!open) return;
      for (const k of kidsOf(n)) visit(k, d + 1);
      if (n.type === 1) out.push({ i: id, d, k: "/", n: tagOf(n) });
    };
    const doc = D.nodes.get(D.doc);
    if (doc) for (const k of kidsOf(doc)) visit(k, 0);
    D.rows = out; D.index = index;
    return out;
  }

  function crumbs(id) {
    const out = [];
    for (let n = D.nodes.get(id); n && n.type !== 9; n = D.nodes.get(n.parent)) {
      if (n.type === 1 || n.type === 11) out.unshift({ i: n.id, l: label(n) });
    }
    return out;
  }

  // Opens every ancestor; true when that changed the tree.
  function revealPath(id) {
    let changed = false;
    for (let n = D.nodes.get(D.nodes.get(id)?.parent); n; n = D.nodes.get(n.parent)) {
      if (n.type === 9 && n.id === D.doc) break;
      if (!D.expanded.has(n.id)) { D.expanded.add(n.id); changed = true; }
    }
    return changed;
  }

  function waitKids(id, ms) {
    return new Promise((resolve) => {
      const n = D.nodes.get(id);
      if (!n || n.kids) return resolve();
      const list = D.kidWaiters.get(id) ?? [];
      const t = setTimeout(resolve, ms);
      list.push(() => { clearTimeout(t); resolve(); });
      D.kidWaiters.set(id, list);
    });
  }

  async function loadKids(id, depth = 1) {
    const n = D.nodes.get(id);
    if (!n || (n.kids && depth === 1) || (!n.count && !n.extra.length)) return;
    const w = depth === 1 ? waitKids(id, 3000) : null;
    await send("DOM.requestChildNodes", { nodeId: id, depth });
    if (w) await w;
  }

  function findKid(id, test) {
    const n = D.nodes.get(id);
    for (const k of n?.kids ?? []) { const c = D.nodes.get(k); if (c && test(c)) return c; }
    return null;
  }

  async function ensureDoc() {
    const sid = await session();
    if (D.loaded) return;
    if (D.loading) return D.loading;
    D.loading = (async () => {
      await send("DOM.enable", {}).catch(() => {});
      await send("Overlay.enable", {}).catch(() => {});
      const { root } = await send("DOM.getDocument", { depth: 2 }, 15000);
      if (sess.id !== sid) return;
      D.nodes.clear(); D.expanded = new Set();
      addNode(root, 0);
      D.doc = root.nodeId;
      D.loaded = true;
      const html = findKid(D.doc, (n) => n.type === 1);
      const body = html && findKid(html.id, (n) => n.type === 1 && n.local === "body");
      if (html) D.expanded.add(html.id);
      let sel = body ?? html;
      if (body) { D.expanded.add(body.id); await loadKids(body.id).catch(() => {}); }
      // Opened again on the same page: the same nodes open and the same one selected.
      const keep = D.keep;
      D.keep = null;
      if (keep && keep.url === S.url && keep.targetId === sess.targetId) {
        const ids = [...keep.open, keep.sel].filter(Boolean);
        try {
          const { nodeIds } = await send("DOM.pushNodesByBackendIdsToFrontend", { backendNodeIds: ids });
          nodeIds.forEach((nid, i) => {
            if (!nid || !D.nodes.has(nid)) return;
            if (i < keep.open.length) D.expanded.add(nid);
            else { sel = D.nodes.get(nid); D.chosen = Boolean(keep.chosen); }
          });
          for (const nid of nodeIds.slice(0, keep.open.length)) if (nid && D.expanded.has(nid)) await loadKids(nid).catch(() => {});
        } catch {}
      }
      D.sel = sel?.id ?? null;
      if (D.sel) revealPath(D.sel);
      D.reveal++;
      D.error = null;
      bump(true);
      if (D.inspecting) await send("Overlay.setInspectMode", { mode: "searchForNode", highlightConfig: HL }).catch(() => {});
    })();
    try { await D.loading; }
    catch (e) { D.error = String(e.message ?? e); throw e; }
    finally { D.loading = null; }
  }

  let reloadTimer = null;
  function documentUpdated() {
    const was = D.inspecting;
    resetDom(true);
    D.inspecting = was;
    if (!D.open || reloadTimer) return;
    reloadTimer = setTimeout(() => { reloadTimer = null; if (D.open) ensureDoc().catch((e) => log("reload", e.message)); }, 120);
  }

  async function setInspect(on) {
    if (on && S.inspect !== "off") await ctx.setInspect("off"); // pick / annotate and this share Chrome's inspect mode
    await ensureDoc();
    await send("Overlay.setInspectMode", { mode: on ? "searchForNode" : "none", highlightConfig: HL });
    if (!on) await send("Overlay.hideHighlight", {}).catch(() => {});
    D.inspecting = on;
    if (!on) D.hover = null;
    bump(false);
  }

  async function closeDom() {
    D.open = false;
    if (!sess.id) return;
    if (D.inspecting) await setInspect(false).catch(() => {});
    D.inspecting = false;
    await send("Overlay.hideHighlight", {}).catch(() => {});
    if (D.loaded) {
      const back = (id) => D.nodes.get(id)?.backend;
      D.keep = { url: S.url, targetId: sess.targetId, sel: back(D.sel), chosen: D.chosen, open: [...D.expanded].map(back).filter(Boolean).slice(0, 400) };
    }
    await send("DOM.disable", {}).catch(() => {});
    const keep = D.keep;
    resetDom(false);
    D.keep = keep;
  }

  setInterval(() => {
    if (D.open && Date.now() - D.lastPoll > IDLE_CLOSE_MS) { log("no panel polls: closing the tree"); closeDom().catch(() => {}); }
    else if (!D.open && D.loaded && Date.now() - D.apiUse > 60_000) closeDom().catch(() => {});
  }, 5000).unref?.();

  // ---- events ---------------------------------------------------------------------------

  function onEvent(method, p, sessionId) {
    if (method === "Target.detachedFromTarget" && p.sessionId && p.sessionId === sess.id) {
      sess.id = null; sess.targetId = null; sess.gen++; resetDom(false); resetApp(); return;
    }
    if (method === "Target.targetDestroyed" && p.targetId === sess.targetId) { dropSession("tab closed"); return; }
    if (method === "Target.targetInfoChanged" && p.targetInfo?.targetId === sess.targetId) { bumpApp(); return; }
    if (!sessionId || sessionId !== sess.id) return;
    switch (method) {
      case "DOM.documentUpdated": documentUpdated(); break;
      case "DOM.setChildNodes": {
        const parent = D.nodes.get(p.parentId);
        if (!parent) break;
        if (parent.kids) {
          const incoming = new Set(p.nodes.map((c) => c.nodeId));
          for (const k of parent.kids) if (!incoming.has(k)) dropSubtree(k);
        }
        parent.kids = p.nodes.map((c) => (addNode(c, parent.id), c.nodeId));
        parent.count = parent.kids.length;
        const ws = D.kidWaiters.get(parent.id);
        if (ws) { D.kidWaiters.delete(parent.id); for (const w of ws) w(); }
        bump(true);
        break;
      }
      case "DOM.childNodeInserted": {
        const parent = D.nodes.get(p.parentNodeId);
        if (!parent) break;
        addNode(p.node, parent.id);
        if (parent.kids) {
          const at = p.previousNodeId ? parent.kids.indexOf(p.previousNodeId) + 1 : 0;
          parent.kids.splice(at, 0, p.node.nodeId);
          parent.count = parent.kids.length;
        } else parent.count++;
        bump(true);
        break;
      }
      case "DOM.childNodeRemoved": {
        const parent = D.nodes.get(p.parentNodeId);
        if (!parent) break;
        const gone = (id) => { for (let n = D.nodes.get(id); n; n = D.nodes.get(n.parent)) if (n.id === p.nodeId) return true; return false; };
        const selGone = D.sel && gone(D.sel), hoverGone = D.hover && gone(D.hover);
        if (parent.kids) { parent.kids = parent.kids.filter((k) => k !== p.nodeId); parent.count = parent.kids.length; }
        else parent.count = Math.max(0, parent.count - 1);
        parent.extra = parent.extra.filter((k) => k !== p.nodeId);
        dropSubtree(p.nodeId);
        if (selGone) D.sel = parent.type === 1 ? parent.id : null;
        if (hoverGone) D.hover = null;
        bump(true);
        break;
      }
      case "DOM.childNodeCountUpdated": {
        const n = D.nodes.get(p.nodeId);
        if (!n) break;
        n.count = p.childNodeCount;
        if (!n.count) n.kids = [];
        else if (n.kids && n.kids.length !== n.count) n.kids = null;
        if (n.count && !n.kids && D.expanded.has(n.id)) loadKids(n.id).catch(() => {});
        bump(true);
        break;
      }
      case "DOM.attributeModified": {
        const n = D.nodes.get(p.nodeId);
        if (!n) break;
        const a = n.attrs ?? (n.attrs = []);
        let i = 0;
        for (; i < a.length; i += 2) if (a[i] === p.name) break;
        if (i < a.length) a[i + 1] = p.value; else a.push(p.name, p.value);
        bump(true);
        break;
      }
      case "DOM.attributeRemoved": {
        const n = D.nodes.get(p.nodeId);
        if (!n?.attrs) break;
        for (let i = 0; i < n.attrs.length; i += 2) if (n.attrs[i] === p.name) { n.attrs.splice(i, 2); break; }
        bump(true);
        break;
      }
      case "DOM.characterDataModified": {
        const n = D.nodes.get(p.nodeId);
        if (n) { n.value = p.characterData; bump(true); }
        break;
      }
      case "DOM.shadowRootPushed": {
        const host = D.nodes.get(p.hostId);
        if (!host) break;
        addNode(p.root, host.id);
        if (!host.extra.includes(p.root.nodeId)) host.extra.push(p.root.nodeId);
        bump(true);
        break;
      }
      case "DOM.shadowRootPopped": {
        const host = D.nodes.get(p.hostId);
        if (host) host.extra = host.extra.filter((k) => k !== p.rootId);
        dropSubtree(p.rootId);
        bump(true);
        break;
      }
      // Chrome's inspect mode: the pointer over an element (its path is pushed first), a click on it, Esc.
      case "Overlay.nodeHighlightRequested":
        if (D.inspecting && D.nodes.has(p.nodeId) && D.hover !== p.nodeId) {
          D.hover = p.nodeId;
          const changed = revealPath(p.nodeId);
          D.reveal++;
          bump(changed);
        }
        break;
      case "Overlay.inspectNodeRequested":
        if (D.inspecting) inspectedNode(p.backendNodeId).catch((e) => log("inspect", e.message));
        break;
      case "Overlay.inspectModeCanceled":
        if (D.inspecting) { D.inspecting = false; D.hover = null; bump(false); }
        break;
      // Application
      case "DOMStorage.domStorageItemAdded": case "DOMStorage.domStorageItemRemoved":
      case "DOMStorage.domStorageItemUpdated": case "DOMStorage.domStorageItemsCleared":
        bumpApp();
        break;
      case "ServiceWorker.workerRegistrationUpdated":
        for (const r of p.registrations ?? []) {
          if (r.isDeleted) A.regs.delete(r.registrationId); else A.regs.set(r.registrationId, r);
        }
        bumpApp();
        break;
      case "ServiceWorker.workerVersionUpdated":
        for (const v of p.versions ?? []) A.versions.set(v.versionId, v);
        bumpApp();
        break;
      case "ServiceWorker.workerErrorReported":
        A.swErrors.push(p.errorMessage);
        if (A.swErrors.length > 20) A.swErrors.shift();
        bumpApp();
        break;
    }
  }

  async function inspectedNode(backendNodeId) {
    D.inspecting = false;
    await send("Overlay.setInspectMode", { mode: "none", highlightConfig: HL }).catch(() => {});
    await send("Overlay.hideHighlight", {}).catch(() => {});
    let id = null;
    try { id = (await send("DOM.pushNodesByBackendIdsToFrontend", { backendNodeIds: [backendNodeId] })).nodeIds?.[0] || null; } catch {}
    id = id && D.nodes.has(id) ? id : D.hover;
    D.hover = null;
    if (id) { D.sel = id; D.chosen = true; revealPath(id); D.reveal++; D.locked = (D.locked ?? 0) + 1; }
    bump(true);
  }

  // ---- long polls -----------------------------------------------------------------------

  async function waitFor(changed, ms) {
    const until = Date.now() + ms;
    while (!changed() && Date.now() < until) {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, Math.min(250, Math.max(1, until - Date.now())));
        wakers.push(() => { clearTimeout(t); resolve(); });
      });
    }
    if (changed()) await sleep(50); // events come in bursts: answer once for the burst
  }

  function rowWindow(q) {
    const all = rows();
    const from = Math.max(0, Math.min(all.length, Number(q.get("from") ?? 0) || 0));
    const count = Math.max(0, Math.min(WINDOW_MAX, Number(q.get("count") ?? 400) || 400));
    return { from, rows: all.slice(from, from + count), total: all.length };
  }

  function domState(q, withRows) {
    const all = rows();
    const focus = D.inspecting && D.hover ? D.hover : D.sel;
    const fn = D.nodes.get(focus);
    const out = {
      ok: true, ver, tver: D.tver, total: all.length, loaded: D.loaded, error: D.error,
      sel: D.sel, hover: D.hover, focus, focusLabel: label(fn), focusKind: fn?.type ?? 0,
      selIndex: D.index.get(D.sel) ?? -1, focusIndex: D.index.get(focus) ?? -1, reveal: D.reveal, locked: D.locked ?? 0, edits: D.edits,
      crumbs: crumbs(focus), inspecting: D.inspecting, pickInspect: S.inspect,
      targetId: sess.targetId, url: S.url, nodes: D.nodes.size,
      picked: S.picked && S.picked.targetId === S.targetId ? { seq: S.picked.seq, tag: S.picked.tag } : null,
    };
    if (withRows) Object.assign(out, rowWindow(q));
    return out;
  }

  // ---- HTML -----------------------------------------------------------------------------

  async function pageHtml() {
    const r = await send("Runtime.evaluate", { returnByValue: true,
      expression: "(() => { const d = document.documentElement.cloneNode(true); d.querySelectorAll('[data-atrous]').forEach((e) => e.remove()); const t = document.doctype; return (t ? '<!DOCTYPE ' + t.name + '>\\n' : '') + d.outerHTML; })()" }, 20000);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "Couldn't read the page");
    return String(r.result?.value ?? "");
  }

  async function nodeHtml(id) {
    const n = D.nodes.get(id);
    if (!n) throw httpErr(404, "That node is gone from the page");
    if (n.type === 9 && id === D.doc) return pageHtml();
    const { outerHTML } = await send("DOM.getOuterHTML", { nodeId: id }, 20000);
    return n.type === 1 && (n.local === "html" || n.local === "body") ? outerHTML.replace(STRIP_ATROUS, "") : outerHTML;
  }

  // Slice element HTML inside Chromium: sending megabytes over CDP just to discard them in
  // the helper stalls both the browser and the panel on large documents.
  async function nodePreview(id, max) {
    const n = D.nodes.get(id);
    if (!n) throw httpErr(404, "That node is gone from the page");
    if (n.type !== 1) {
      const html = await nodeHtml(id);
      return { total: html.length, truncated: html.length > max, html: html.slice(0, max) };
    }
    const { object } = await send("DOM.resolveNode", { nodeId: id });
    if (!object?.objectId) throw httpErr(404, "That node is gone from the page");
    try {
      const r = await send("Runtime.callFunctionOn", {
        objectId: object.objectId, returnByValue: true,
        functionDeclaration: `function(max, strip) {
          let html = this.outerHTML;
          if (strip) html = html.replace(${STRIP_ATROUS}, "");
          return { total: html.length, truncated: html.length > max, html: html.slice(0, max) };
        }`,
        arguments: [{ value: max }, { value: n.local === "html" || n.local === "body" }],
      }, 20000);
      if (r.exceptionDetails) throw new Error("Couldn't read this element's HTML");
      return r.result.value;
    } finally { await send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {}); }
  }

  async function setHtml(id, html, select = true) {
    const n = D.nodes.get(id);
    if (!n) throw httpErr(404, "That node is gone from the page; select it again");
    D.edits++;
    if (n.type === 3 || n.type === 8 || n.type === 4) {
      await send("DOM.setNodeValue", { nodeId: id, value: html });
      bump(true);
      return { ok: true, sel: id };
    }
    if (n.type !== 1) throw httpErr(400, "Only elements, text and comments can be edited");
    const parent = D.nodes.get(n.parent);
    const at = parent?.kids?.indexOf(id) ?? -1;
    await send("DOM.setOuterHTML", { nodeId: id, outerHTML: html }, 20000);
    send("DOM.markUndoableState", {}).catch(() => {});
    await sleep(30); // the mutation events that came with it
    // Chrome patches in place where it can; otherwise what is now at the node's place is selected.
    let sel = D.nodes.has(id) ? id : null;
    if (!sel && parent && D.nodes.has(parent.id)) {
      const kids = D.nodes.get(parent.id).kids ?? [];
      const near = kids.slice(Math.max(0, at)).map((k) => D.nodes.get(k)).find((c) => c?.type === 1);
      sel = near?.id ?? (parent.type === 1 ? parent.id : null);
    }
    if (sel && select) { D.sel = sel; revealPath(sel); D.reveal++; }
    bump(true);
    return { ok: true, sel };
  }

  // ---- Application ----------------------------------------------------------------------

  const A = { ver: 1, wakers: [], storageOn: false, idbOn: false, cacheOn: false, swOn: false, keyFor: null, key: null,
    regs: new Map(), versions: new Map(), swErrors: [] };
  function bumpApp() { A.ver++; const w = A.wakers; A.wakers = []; for (const f of w) f(); }
  function resetApp() {
    A.storageOn = false; A.idbOn = false; A.cacheOn = false; A.swOn = false; A.keyFor = null; A.key = null;
    A.regs.clear(); A.versions.clear(); A.swErrors = [];
    bumpApp();
  }

  async function site() {
    await session();
    let origin = null, host = "";
    try { const u = new URL(S.url); if (isWeb(S.url)) { origin = u.origin; host = u.hostname; } } catch {}
    return { url: S.url, origin, host };
  }
  async function needOrigin() {
    const s = await site();
    if (!s.origin) throw httpErr(409, "This page has no web origin (it isn't an http or https page)");
    return s;
  }
  async function mainFrameId() {
    try { return (await send("Page.getFrameTree", {})).frameTree.frame.id; } catch { return sess.targetId; }
  }
  // Storage APIs take the origin or (newer Chrome) a storage key; both are tried, the one that works is kept.
  async function storageKey() {
    if (A.keyFor === S.url) return A.key;
    A.keyFor = S.url;
    try { A.key = (await send("Storage.getStorageKeyForFrame", { frameId: await mainFrameId() })).storageKey || null; } catch { A.key = null; }
    return A.key;
  }
  async function withOrigin(fn) {
    const { origin } = await needOrigin();
    const key = await storageKey();
    let first;
    for (const id of key ? [{ storageKey: key }, { securityOrigin: origin }] : [{ securityOrigin: origin }]) {
      try { return await fn(id); } catch (e) { first ??= e; }
    }
    throw first;
  }

  async function frameUrls() {
    const out = [];
    try {
      const { frameTree } = await send("Page.getFrameTree", {});
      const walk = (f) => { if (isWeb(f.frame.url)) out.push(f.frame.url); for (const c of f.childFrames ?? []) walk(c); };
      walk(frameTree);
    } catch {}
    if (!out.length && isWeb(S.url)) out.push(S.url);
    return [...new Set(out)];
  }

  // The cookies a URL would get (default: the shown page and its frames).
  async function cookieList(url) {
    await session();
    const urls = url ? [url] : await frameUrls();
    if (!urls.length) return [];
    const { cookies: list } = await send("Network.getCookies", { urls });
    const out = list.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.session ? -1 : c.expires,
      size: c.size, httpOnly: c.httpOnly, secure: c.secure, session: c.session, sameSite: c.sameSite ?? "", priority: c.priority ?? "",
      partitionKey: c.partitionKey ?? null, sourceScheme: c.sourceScheme ?? "" }));
    out.sort((a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
    return out;
  }

  async function cookies() {
    const s = await site();
    return { ok: true, ...s, cookies: await cookieList(null) };
  }

  async function deleteCookie(c) {
    const p = { name: c.name, domain: c.domain, path: c.path };
    if (c.partitionKey) p.partitionKey = c.partitionKey;
    await send("Network.deleteCookies", p);
  }

  // `url` (agents): the cookie is for that site instead of the shown page's.
  async function setCookie(c, old, url) {
    let s = await site();
    if (url) { try { const u = new URL(url); s = { url, host: u.hostname, origin: u.origin }; } catch { throw httpErr(400, `Not a URL: ${url}`); } }
    if (!s.host) throw httpErr(409, "This page has no web origin (it isn't an http or https page)");
    if (!c || typeof c.name !== "string" || !c.name.trim()) throw httpErr(400, "A cookie needs a name");
    const domain = String(c.domain || s.host).trim().toLowerCase();
    const bare = domain.replace(/^\./, "");
    if (!bare || !(s.host === bare || s.host.endsWith(`.${bare}`))) throw httpErr(400, `${domain || "That domain"} isn't ${s.host} or a parent of it, so this page would never see the cookie`);
    let p = String(c.path || "/").trim();
    if (!p.startsWith("/")) p = `/${p}`;
    const params = { name: c.name.trim(), value: String(c.value ?? ""), path: p, secure: Boolean(c.secure), httpOnly: Boolean(c.httpOnly) };
    if (c.sameSite) params.sameSite = c.sameSite;
    const exp = typeof c.expires === "string" && !/^-?\d+(\.\d+)?$/.test(c.expires) ? Date.parse(c.expires) / 1000 : Number(c.expires);
    if (typeof c.expires === "string" && c.expires && !/^session$/i.test(c.expires) && !(exp > 0) && Number(c.expires) !== -1) throw httpErr(400, `expires: not a date or epoch seconds: ${c.expires}`);
    if (exp > 0) params.expires = exp;
    if (c.priority) params.priority = c.priority;
    if (c.partitionKey) params.partitionKey = c.partitionKey;
    // A host-only cookie (no leading dot) is set through a URL, so it stays host-only.
    if (domain.startsWith(".")) params.domain = domain;
    else params.url = `${params.secure || /^https:/i.test(s.url) ? "https" : "http"}://${domain}${p}`;
    const r = await send("Network.setCookie", params);
    if (r.success === false) throw httpErr(400, "The browser refused this cookie: check its domain, path, Secure and SameSite (SameSite=None needs Secure)");
    if (old && (old.name !== params.name || old.domain !== domain || old.path !== p)) await deleteCookie(old).catch(() => {});
    bumpApp();
    return { ok: true };
  }

  async function domStorage(kind, fn) {
    if (!A.storageOn) { await session(); await send("DOMStorage.enable", {}).catch(() => {}); A.storageOn = true; }
    return withOrigin((id) => fn({ ...id, isLocalStorage: kind !== "session" }));
  }

  // A RemoteObject as plain JSON, made in the page: Dates as {$date}, binary as {$binary: bytes},
  // Maps and Sets as {$map} / {$set}, cycles cut.
  const JSON_SAFE = `function () {
    const seen = new WeakSet();
    const walk = (v, d) => {
      if (v === null || typeof v !== 'object') return typeof v === 'bigint' ? v.toString() : typeof v === 'function' ? '[function]' : v;
      if (v instanceof Date) return { $date: isNaN(v) ? null : v.toISOString() };
      if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return { $binary: v.byteLength };
      if (typeof Blob !== 'undefined' && v instanceof Blob) return { $blob: v.size, type: v.type };
      if (seen.has(v) || d > 40) return '[circular]';
      seen.add(v);
      if (Array.isArray(v)) return v.map((x) => walk(x, d + 1));
      if (v instanceof Map) return { $map: [...v].map(([k, x]) => [walk(k, d + 1), walk(x, d + 1)]) };
      if (v instanceof Set) return { $set: [...v].map((x) => walk(x, d + 1)) };
      const o = {};
      for (const k of Object.keys(v)) o[k] = walk(v[k], d + 1);
      return o;
    };
    return walk(this, 0);
  }`;
  async function remoteValue(o) {
    if (!o || o.type === "undefined") return null;
    if (!o.objectId) return "value" in o ? o.value : (o.unserializableValue ?? o.description ?? null);
    try { return (await send("Runtime.callFunctionOn", { objectId: o.objectId, returnByValue: true, functionDeclaration: JSON_SAFE })).result?.value ?? null; }
    catch { return o.description ?? null; }
  }
  // The same, as short text for the tab's lists.
  async function remoteText(o, max = 4000) {
    const v = await remoteValue(o);
    const s = typeof v === "string" ? v : JSON.stringify(v) ?? "";
    return s.length > max ? `${s.slice(0, max)}…` : s;
  }
  const keyPath = (k) => (!k ? "" : k.type === "string" ? k.string : k.type === "array" ? (k.array ?? []).join(", ") : "");

  async function idbList() {
    const s = await needOrigin();
    if (!A.idbOn) { await send("IndexedDB.enable", {}).catch(() => {}); A.idbOn = true; }
    return withOrigin(async (id) => {
      const { databaseNames } = await send("IndexedDB.requestDatabaseNames", id);
      const dbs = [];
      for (const name of databaseNames.slice(0, 40)) {
        try {
          const { databaseWithObjectStores: d } = await send("IndexedDB.requestDatabase", { ...id, databaseName: name });
          const stores = [];
          for (const st of d.objectStores.slice(0, 80)) {
            let count = null;
            try { count = (await send("IndexedDB.getMetadata", { ...id, databaseName: name, objectStoreName: st.name })).entriesCount; } catch {}
            stores.push({ name: st.name, keyPath: keyPath(st.keyPath), autoIncrement: st.autoIncrement, count,
              indexes: (st.indexes ?? []).map((i) => ({ name: i.name, keyPath: keyPath(i.keyPath), unique: i.unique, multiEntry: i.multiEntry })) });
          }
          dbs.push({ name, version: d.version, stores });
        } catch (e) { dbs.push({ name, version: null, stores: [], error: e.message }); }
      }
      return { ok: true, origin: s.origin, dbs };
    });
  }

  // A store's records from `skip` on (by `index` when given). The tab gets short text, agents (asJson) real values.
  async function idbData(db, store, skip, o = {}) {
    if (!A.idbOn) { await session(); await send("IndexedDB.enable", {}).catch(() => {}); A.idbOn = true; }
    if (!db || !store) throw httpErr(400, "Give db and store");
    return withOrigin(async (id) => {
      const q = { ...id, databaseName: db, objectStoreName: store, skipCount: skip, pageSize: Math.max(1, Math.min(1000, o.limit ?? 50)) };
      // Newer Chrome wants no index name for the store itself; older ones want "".
      const r = o.index ? await send("IndexedDB.requestData", { ...q, indexName: o.index }, 20000)
        : await send("IndexedDB.requestData", q, 20000).catch(() => send("IndexedDB.requestData", { ...q, indexName: "" }, 20000));
      const entries = [];
      for (const e of r.objectStoreDataEntries ?? []) {
        entries.push(o.asJson
          ? { key: await remoteValue(e.key), primaryKey: await remoteValue(e.primaryKey), value: await remoteValue(e.value) }
          : { key: await remoteText(e.key, 300), primaryKey: await remoteText(e.primaryKey, 300), value: await remoteText(e.value, 4000) });
        for (const o of [e.key, e.primaryKey, e.value]) if (o?.objectId) send("Runtime.releaseObject", { objectId: o.objectId }).catch(() => {});
      }
      return { ok: true, entries, hasMore: Boolean(r.hasMore), skip };
    });
  }

  async function cacheNames() {
    const s = await needOrigin();
    return withOrigin(async (id) => {
      const { caches } = await send("CacheStorage.requestCacheNames", id);
      return { ok: true, origin: s.origin, caches: caches.map((c) => ({ id: c.cacheId, name: c.cacheName })) };
    });
  }

  async function cacheEntries(cacheId, skip, filter) {
    await session();
    const r = await send("CacheStorage.requestEntries", { cacheId, skipCount: skip, pageSize: 100, pathFilter: filter || "" }, 20000);
    const head = (hs, name) => (hs ?? []).find((h) => h.name.toLowerCase() === name)?.value ?? "";
    return { ok: true, skip, total: r.returnCount ?? null, entries: (r.cacheDataEntries ?? []).map((e) => ({
      url: e.requestURL, method: e.requestMethod, status: e.responseStatus, statusText: e.responseStatusText, type: e.responseType,
      contentType: head(e.responseHeaders, "content-type"), size: Number(head(e.responseHeaders, "content-length")) || null,
      time: e.responseTime, requestHeaders: e.requestHeaders ?? [], responseHeaders: e.responseHeaders ?? [] })) };
  }

  async function cachedResponse(cacheId, url) {
    await session();
    let path = url;
    try { const u = new URL(url); path = u.pathname + u.search; } catch {}
    const { cacheDataEntries } = await send("CacheStorage.requestEntries", { cacheId, skipCount: 0, pageSize: 200, pathFilter: path }, 20000);
    const e = (cacheDataEntries ?? []).find((x) => x.requestURL === url);
    if (!e) throw httpErr(404, "That entry is no longer in the cache");
    const { response } = await send("CacheStorage.requestCachedResponse", { cacheId, requestURL: url, requestHeaders: e.requestHeaders ?? [] }, 20000);
    const buf = Buffer.from(response?.body ?? "", "base64");
    const type = (e.responseHeaders ?? []).find((h) => h.name.toLowerCase() === "content-type")?.value ?? "";
    const textual = /^(text\/|application\/(json|javascript|xml|.*\+json|.*\+xml|x-javascript|manifest\+json)|image\/svg)/i.test(type)
      || (!type && !buf.subarray(0, 512).includes(0));
    const max = 200_000;
    return { ok: true, url, type, size: buf.length, text: textual ? buf.subarray(0, max).toString("utf8") : null, truncated: textual && buf.length > max };
  }

  async function swOn() {
    if (A.swOn) return;
    await send("ServiceWorker.enable", {}).catch((e) => log("sw enable", e.message));
    A.swOn = true;
    await sleep(150); // the registrations arrive as events
  }

  async function workers() {
    const s = await site();
    await swOn();
    const origin = s.origin;
    const regs = [...A.regs.values()].filter((r) => !origin || r.scopeURL.startsWith(origin)).map((r) => {
      const versions = [...A.versions.values()].filter((v) => v.registrationId === r.registrationId)
        .sort((a, b) => Number(b.versionId) - Number(a.versionId))
        .map((v) => ({ id: v.versionId, script: v.scriptURL, status: v.status, running: v.runningStatus, clients: (v.controlledClients ?? []).length,
          modified: v.scriptLastModified ?? null, responseTime: v.scriptResponseTime ?? null }));
      return { id: r.registrationId, scope: r.scopeURL, versions };
    });
    return { ok: true, origin, workers: regs, errors: A.swErrors.slice(-5) };
  }

  async function usage() {
    const s = await needOrigin();
    const r = await send("Storage.getUsageAndQuota", { origin: s.origin });
    return { ok: true, origin: s.origin, usage: r.usage, quota: r.quota, overrideActive: r.overrideActive,
      breakdown: (r.usageBreakdown ?? []).filter((b) => b.usage > 0).map((b) => ({ type: b.storageType, usage: b.usage })) };
  }

  // ---- the agents' API (skills/atrous-browser/dom.mjs) -------------------------------------

  const exceptionText = (d) => String(d.exception?.description ?? d.text ?? "failed").split("\n")[0].replace(/^(Uncaught )?(\w*Error|DOMException): /, "");

  // Runs fn(...args) in an isolated world of the page's main frame (the page's own scripts can't
  // see or patch it; same origin, so the same storage). Returns its JSON value.
  async function isolatedCall(fn, args) {
    await session();
    const frameId = await mainFrameId();
    const { executionContextId } = await send("Page.createIsolatedWorld", { frameId, worldName: "atrous-agent" });
    const r = await send("Runtime.callFunctionOn", { executionContextId, functionDeclaration: fn,
      arguments: args.map((value) => ({ value: value === undefined ? null : value })), awaitPromise: true, returnByValue: true }, 30000);
    if (r.exceptionDetails) throw httpErr(400, exceptionText(r.exceptionDetails));
    return r.result?.value;
  }

  // The nodes a request names: { nodeId } or { selector } (the first match, or all of them).
  async function agentTargets(b, all) {
    await ensureDoc();
    D.apiUse = Date.now();
    if (b.nodeId !== undefined && b.nodeId !== null && b.nodeId !== "") {
      const id = Number(b.nodeId);
      if (!D.nodes.has(id)) throw httpErr(404, `No node ${b.nodeId} (node ids change when the page reloads: query again)`);
      return [id];
    }
    if (!b.selector) throw httpErr(400, "Give a selector or a nodeId");
    let nodeIds;
    try { ({ nodeIds } = await send("DOM.querySelectorAll", { nodeId: D.doc, selector: String(b.selector) })); }
    catch (e) { throw httpErr(400, /selector|DOM Error/i.test(e.message) ? `Not a valid CSS selector: ${b.selector}` : e.message); }
    const ids = nodeIds.filter((id) => D.nodes.has(id) && !atrousOwn(D.nodes.get(id)));
    return all ? ids : ids.slice(0, 1);
  }

  const NODE_INFO = `function () {
    const r = this.getBoundingClientRect ? this.getBoundingClientRect() : null;
    const t = (this.innerText ?? this.textContent ?? '').replace(/\\s+/g, ' ').trim();
    return { text: t.slice(0, 160), textLength: t.length,
      box: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
      visible: !!r && (r.width > 0 || r.height > 0) && getComputedStyle(this).visibility !== 'hidden' };
  }`;
  async function nodeInfo(id) {
    const n = D.nodes.get(id);
    const out = { nodeId: id, tag: tagOf(n), id: attr(n, "id") || undefined, classes: (attr(n, "class") ?? "").trim().split(/\s+/).filter(Boolean), label: label(n) };
    if (n.type !== 1) return out;
    try {
      const { object } = await send("DOM.resolveNode", { nodeId: id });
      const r = await send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: NODE_INFO, returnByValue: true });
      send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});
      Object.assign(out, r.result?.value ?? {});
    } catch {}
    return out;
  }

  async function agentHtml(q) {
    const max = Math.max(1000, Math.min(5_000_000, Number(q.get("max")) || 2_000_000));
    const cut = (h) => ({ total: h.length, truncated: h.length > max, html: h.length > max ? h.slice(0, max) : h });
    if (q.get("picked")) {
      const p = await pickedInfo(max);
      if (!p.picked && !p.inspected) throw httpErr(404, "Nothing is picked or inspected in the panel");
      return { ok: true, ...(p.inspected ?? p.picked), from: p.inspected ? "inspected" : "picked" };
    }
    if (!q.get("selector") && !q.get("nodeId")) { await session(); return { ok: true, page: true, ...cut(await pageHtml()) }; }
    const all = /^(1|true|yes)$/i.test(q.get("all") ?? "");
    const ids = await agentTargets({ selector: q.get("selector"), nodeId: q.get("nodeId") }, all);
    if (!ids.length) throw httpErr(404, `Nothing matches ${q.get("selector")}`);
    const items = [];
    for (const id of ids.slice(0, 500)) items.push({ nodeId: id, label: label(D.nodes.get(id)), ...cut(await nodeHtml(id)) });
    return all ? { ok: true, count: ids.length, items } : { ok: true, ...items[0] };
  }

  async function agentSet(b) {
    const kinds = ["outerHTML", "innerHTML", "text"].filter((k) => typeof b[k] === "string");
    if (kinds.length > 1) throw httpErr(400, "Give one of outerHTML, innerHTML or text");
    const at = b.attributes ?? {};
    const sets = Object.entries(at.set ?? {}), removes = [].concat(at.remove ?? []);
    if (!kinds.length && !sets.length && !removes.length) throw httpErr(400, "Nothing to change: give outerHTML, innerHTML, text or attributes");
    const ids = await agentTargets(b, Boolean(b.all));
    if (!ids.length) throw httpErr(404, `Nothing matches ${b.selector}`);
    const changed = [];
    for (let id of ids) {
      if (!D.nodes.has(id)) continue;
      const was = label(D.nodes.get(id));
      for (const [k, v] of sets) await send("DOM.setAttributeValue", { nodeId: id, name: String(k), value: String(v) });
      for (const k of removes) await send("DOM.removeAttribute", { nodeId: id, name: String(k) });
      if (kinds[0] === "innerHTML" || kinds[0] === "text") {
        const { object } = await send("DOM.resolveNode", { nodeId: id });
        const r = await send("Runtime.callFunctionOn", { objectId: object.objectId,
          arguments: [{ value: b[kinds[0]] }, { value: kinds[0] === "innerHTML" }],
          functionDeclaration: "function (v, html) { if (html) this.innerHTML = v; else this.textContent = v; }" });
        send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});
        if (r.exceptionDetails) throw httpErr(400, exceptionText(r.exceptionDetails));
      }
      if (kinds[0] === "outerHTML") id = (await setHtml(id, b.outerHTML, false)).sel;
      await sleep(20);
      let html = null;
      if (id && D.nodes.has(id)) { try { html = await nodeHtml(id); } catch {} }
      changed.push({ nodeId: id ?? null, was, now: id && D.nodes.has(id) ? label(D.nodes.get(id)) : null,
        html: html && html.length > 4000 ? `${html.slice(0, 4000)}…` : html });
    }
    D.edits++;
    bump(true);
    return { ok: true, count: changed.length, changed };
  }

  // What the person pointed at: picked / annotated in the page (pick mode), and the node selected
  // in the Elements tab (clicked there, or locked with Inspect).
  async function pickedInfo(max = 50_000) {
    const out = { ok: true, picked: null, inspected: null };
    await session();
    const p = S.picked && S.picked.targetId === S.targetId ? S.picked : null;
    if (p) {
      let html = null;
      try { html = (await send("DOM.getOuterHTML", { backendNodeId: p.backendNodeId })).outerHTML; } catch {}
      out.picked = { mode: p.mode, tag: p.tag, selector: p.selector, text: p.text, rect: p.rect, url: p.url, gone: html === null,
        total: html?.length ?? 0, html: html && html.length > max ? html.slice(0, max) : html };
    }
    if (D.loaded && D.sel && D.chosen && D.nodes.has(D.sel) && D.open) {
      const html = await nodeHtml(D.sel).catch(() => null);
      out.inspected = { nodeId: D.sel, label: label(D.nodes.get(D.sel)), path: crumbs(D.sel).map((c) => c.l).join(" > "),
        total: html?.length ?? 0, html: html && html.length > max ? html.slice(0, max) : html };
    } else if (!D.open && D.keep?.sel && D.keep.chosen && D.keep.url === S.url) {
      try {
        const html = (await send("DOM.getOuterHTML", { backendNodeId: D.keep.sel })).outerHTML;
        out.inspected = { nodeId: null, label: /^<([\w-]+)/.exec(html)?.[1] ?? "", total: html.length, html: html.length > max ? html.slice(0, max) : html };
      } catch {}
    }
    return out;
  }

  const SAME = { lax: "Lax", strict: "Strict", none: "None" };
  async function agentCookieSet(b) {
    let sameSite = "";
    if (b.sameSite) { sameSite = SAME[String(b.sameSite).toLowerCase()]; if (!sameSite) throw httpErr(400, "sameSite: Lax, Strict or None"); }
    const c = { name: String(b.name ?? ""), value: typeof b.value === "string" ? b.value : JSON.stringify(b.value ?? ""), domain: b.domain, path: b.path,
      expires: b.expires ?? -1, httpOnly: Boolean(b.httpOnly), secure: Boolean(b.secure) || sameSite === "None", sameSite };
    await setCookie(c, null, b.url || null);
    const list = await cookieList(b.url || null);
    const bare = (d) => String(d ?? "").replace(/^\./, "");
    const saved = list.find((x) => x.name === c.name && (!c.domain || bare(x.domain) === bare(c.domain)) && (!c.path || x.path === c.path));
    return { ok: true, cookie: saved ?? null, note: saved ? undefined : "Set, but the page's URL doesn't get it (check domain and path)" };
  }

  async function agentCookieDelete(b, everything) {
    const list = await cookieList(b.url || null);
    const bare = (d) => String(d ?? "").replace(/^\./, "");
    const hit = everything ? list : list.filter((x) => x.name === b.name && (!b.domain || bare(x.domain) === bare(b.domain)) && (!b.path || x.path === b.path));
    if (!everything && !b.name) throw httpErr(400, "Give the cookie's name");
    for (const c of hit) await deleteCookie(c);
    bumpApp();
    return { ok: true, deleted: hit.length, cookies: hit.map((c) => ({ name: c.name, domain: c.domain, path: c.path })) };
  }

  // Local / Session Storage of the shown page's origin, or of `origin`.
  async function storageCall(kind, origin, fn) {
    const cur = (await site()).origin;
    if (!origin || origin === cur) return domStorage(kind, fn);
    try { new URL(origin); } catch { throw httpErr(400, `Not an origin: ${origin}`); }
    if (!A.storageOn) { await send("DOMStorage.enable", {}).catch(() => {}); A.storageOn = true; }
    try { return await fn({ securityOrigin: new URL(origin).origin, isLocalStorage: kind !== "session" }); }
    catch (e) {
      if (/frame not found/i.test(e.message)) throw httpErr(409, `${origin} isn't open in this tab (Chrome reads storage only for the page's origin and its frames): open it first`);
      throw e;
    }
  }

  const IDB_WRITE = `async function (op, db, store, key, hasKey, value) {
    const d = await new Promise((ok, bad) => {
      const r = indexedDB.open(db);
      r.onupgradeneeded = () => r.transaction.abort();
      r.onsuccess = () => ok(r.result);
      r.onerror = () => bad(new Error(r.error && r.error.name === 'AbortError' ? 'No IndexedDB database named ' + db + ' on this origin' : String(r.error)));
    });
    try {
      if (!d.objectStoreNames.contains(store)) throw new Error('No object store ' + store + ' in ' + db + ' (it has: ' + [...d.objectStoreNames].join(', ') + ')');
      return await new Promise((ok, bad) => {
        const tx = d.transaction(store, 'readwrite');
        const s = tx.objectStore(store);
        const keyPath = s.keyPath;
        let q;
        if (op === 'delete') q = s.delete(key);
        else if (hasKey && keyPath !== null) throw new Error('This store keeps the key inside the value (keyPath ' + JSON.stringify(keyPath) + '): put it in the value, not as a separate key');
        else if (!hasKey && keyPath === null && !s.autoIncrement) throw new Error('This store has no key path and no key generator: give a key');
        else q = hasKey ? s.put(value, key) : s.put(value);
        let result;
        q.onsuccess = () => { result = q.result; };
        tx.oncomplete = () => ok({ key: op === 'delete' ? key : result, keyPath });
        tx.onerror = () => bad(tx.error || q.error);
        tx.onabort = () => bad(tx.error || new Error('The transaction was aborted'));
      });
    } finally { d.close(); }
  }`;

  async function idbWrite(op, b) {
    if (!b.db || !b.store) throw httpErr(400, "Give db and store");
    const hasKey = b.key !== undefined && b.key !== null;
    if (op === "delete" && !hasKey) throw httpErr(400, "Give the record's key");
    await needOrigin();
    const r = await isolatedCall(IDB_WRITE, [op, String(b.db), String(b.store), hasKey ? b.key : null, hasKey, b.value ?? null]);
    bumpApp();
    return { ok: true, db: b.db, store: b.store, ...r };
  }

  const AGENT_ROUTES = {
    "POST /dom/query": async (_q, b) => {
      const limit = Math.max(1, Math.min(500, Number(b.limit) || 20));
      const ids = await agentTargets(b, true);
      const matches = [];
      for (const id of ids.slice(0, limit)) matches.push(await nodeInfo(id));
      return { ok: true, selector: b.selector ?? null, count: ids.length, matches };
    },
    "POST /dom/set": (_q, b) => agentSet(b),
    "POST /dom/remove": async (_q, b) => {
      const ids = await agentTargets(b, Boolean(b.all));
      if (!ids.length) throw httpErr(404, `Nothing matches ${b.selector}`);
      const removed = [];
      for (const id of ids) {
        if (!D.nodes.has(id)) continue;
        removed.push({ nodeId: id, label: label(D.nodes.get(id)) });
        await send("DOM.removeNode", { nodeId: id });
      }
      D.edits++;
      bump(true);
      return { ok: true, count: removed.length, removed };
    },
    "GET /dom/picked": () => pickedInfo(),
    "GET /storage/cookies": async (q) => {
      const url = q.get("url") || null;
      if (url && !isWeb(url)) throw httpErr(400, `Not an http(s) URL: ${url}`);
      const list = await cookieList(url);
      return { ok: true, url: url ?? S.url, count: list.length, cookies: list };
    },
    "POST /storage/cookies/set": (_q, b) => agentCookieSet(b),
    "POST /storage/cookies/delete": (_q, b) => agentCookieDelete(b, false),
    "POST /storage/cookies/clear": (_q, b) => agentCookieDelete(b, true),
    "GET /storage/idb": () => idbList(),
    "GET /storage/idb/data": (q) => idbData(String(q.get("db") ?? ""), String(q.get("store") ?? ""), Math.max(0, Number(q.get("skip")) || 0),
      { index: q.get("index") || null, limit: Number(q.get("limit")) || 50, asJson: true }),
    "POST /storage/idb/put": (_q, b) => idbWrite("put", b),
    "POST /storage/idb/delete": (_q, b) => idbWrite("delete", b),
    "POST /storage/idb/clear": async (_q, b) => {
      if (!b.db || !b.store) throw httpErr(400, "Give db and store");
      await session();
      if (!A.idbOn) { await send("IndexedDB.enable", {}).catch(() => {}); A.idbOn = true; }
      await withOrigin((id) => send("IndexedDB.clearObjectStore", { ...id, databaseName: String(b.db), objectStoreName: String(b.store) }));
      bumpApp();
      return { ok: true, db: b.db, store: b.store };
    },
  };
  for (const kind of ["local", "session"]) {
    const items = (origin) => storageCall(kind, origin, (storageId) => send("DOMStorage.getDOMStorageItems", { storageId }));
    AGENT_ROUTES[`GET /storage/${kind}`] = async (q) => {
      const origin = q.get("origin") || null;
      const { entries } = await items(origin);
      const o = origin ?? (await site()).origin;
      const key = q.get("key");
      if (key !== null) { const e = entries.find(([k]) => k === key); return { ok: true, origin: o, key, found: Boolean(e), value: e ? e[1] : null }; }
      return { ok: true, origin: o, count: entries.length, entries: entries.map(([k, v]) => ({ key: k, value: v })) };
    };
    AGENT_ROUTES[`POST /storage/${kind}/set`] = async (_q, b) => {
      if (typeof b.key !== "string" || !b.key) throw httpErr(400, "Give a key");
      const value = typeof b.value === "string" ? b.value : JSON.stringify(b.value ?? null);
      await storageCall(kind, b.origin, (storageId) => send("DOMStorage.setDOMStorageItem", { storageId, key: b.key, value }));
      bumpApp();
      return { ok: true, key: b.key, length: value.length };
    };
    AGENT_ROUTES[`POST /storage/${kind}/remove`] = async (_q, b) => {
      if (typeof b.key !== "string" || !b.key) throw httpErr(400, "Give a key");
      const { entries } = await items(b.origin);
      const found = entries.some(([k]) => k === b.key);
      await storageCall(kind, b.origin, (storageId) => send("DOMStorage.removeDOMStorageItem", { storageId, key: b.key }));
      bumpApp();
      return { ok: true, key: b.key, removed: found };
    };
    AGENT_ROUTES[`POST /storage/${kind}/clear`] = async (_q, b) => {
      const { entries } = await items(b.origin);
      await storageCall(kind, b.origin, (storageId) => send("DOMStorage.clear", { storageId }));
      bumpApp();
      return { ok: true, cleared: entries.length };
    };
  }

  // ---- routes ---------------------------------------------------------------------------

  const ROUTES = {
    "GET /dom/state": async (q) => {
      D.lastPoll = Date.now(); D.open = true;
      try { await ensureDoc(); } catch (e) { return { ok: false, error: String(e.message ?? e), status: e.status ?? 500 }; }
      if (D.inspecting && S.inspect !== "off") { D.inspecting = false; D.hover = null; send("Overlay.setInspectMode", { mode: "none", highlightConfig: HL }).catch(() => {}); bump(false); }
      const since = Number(q.get("since") ?? -1), wait = Math.min(15000, Number(q.get("wait") ?? 0));
      const tid = sess.targetId;
      if (since === ver && wait > 0) await waitFor(() => ver !== since || S.targetId !== tid || !D.open, wait);
      D.lastPoll = Date.now();
      if (S.targetId !== sess.targetId || !D.loaded) { try { await ensureDoc(); } catch (e) { return { ok: false, error: String(e.message ?? e) }; } }
      return domState(q, Number(q.get("tree") ?? -1) !== D.tver);
    },
    "GET /dom/rows": async (q) => { await ensureDoc(); return { ok: true, tver: D.tver, ...rowWindow(q) }; },
    "GET /dom/html": async (q) => {
      await ensureDoc();
      if (!q.get("id")) return agentHtml(q);
      const id = Number(q.get("id"));
      const max = Math.max(1000, Math.min(2_000_000, Number(q.get("max")) || HTML_MAX));
      const html = await nodePreview(id, max);
      const n = D.nodes.get(id);
      return { ok: true, id, label: label(n), kind: n?.type ?? 0, ...html };
    },
    "POST /dom/open": async () => { D.open = true; D.lastPoll = Date.now(); await ensureDoc(); return { ok: true }; },
    "POST /dom/close": async () => { await closeDom(); return { ok: true }; },
    "POST /dom/refresh": async () => {
      if (sess.id && D.loaded) {
        const back = (id) => D.nodes.get(id)?.backend;
        D.keep = { url: S.url, targetId: sess.targetId, sel: back(D.sel), chosen: D.chosen, open: [...D.expanded].map(back).filter(Boolean).slice(0, 400) };
        const keep = D.keep, was = D.inspecting;
        resetDom(true); D.keep = keep; D.inspecting = was;
      }
      await ensureDoc();
      return { ok: true };
    },
    "POST /dom/expand": async (_q, b) => {
      await ensureDoc();
      const id = Number(b.id);
      if (!D.nodes.has(id)) throw httpErr(404, "That node is gone from the page");
      if (!b.open) {
        D.expanded.delete(id);
        if (b.deep) { const walk = (k) => { D.expanded.delete(k); for (const c of kidsOf(D.nodes.get(k) ?? { extra: [] })) walk(c); }; walk(id); }
        bump(true);
        return { ok: true };
      }
      D.expanded.add(id);
      if (b.deep) {
        await loadKids(id, 3).catch(() => {});
        await sleep(30);
        const walk = (k, depth) => { const n = D.nodes.get(k); if (!n || depth > 3) return; if (n.kids?.length || n.extra.length) D.expanded.add(k); for (const c of kidsOf(n)) walk(c, depth + 1); };
        walk(id, 0);
      } else await loadKids(id).catch((e) => log("expand", e.message));
      bump(true);
      return { ok: true };
    },
    "POST /dom/select": async (_q, b) => {
      await ensureDoc();
      let id = b.id ? Number(b.id) : null;
      let backend = b.backendNodeId ? Number(b.backendNodeId) : null;
      if (b.picked) {
        if (!(S.picked && S.picked.targetId === S.targetId)) throw httpErr(404, "Nothing was picked on this page");
        backend = S.picked.backendNodeId;
      }
      if (backend) {
        const { nodeIds } = await send("DOM.pushNodesByBackendIdsToFrontend", { backendNodeIds: [backend] });
        id = nodeIds?.[0] || null;
        if (!id) throw httpErr(404, "That element is no longer on the page");
        await sleep(20);
      }
      if (!D.nodes.has(id)) throw httpErr(404, "That node is gone from the page");
      D.sel = id;
      D.chosen = true;
      const changed = revealPath(id);
      if (b.reveal !== false) D.reveal++;
      bump(changed);
      return { ok: true, sel: id };
    },
    "POST /dom/hover": async (_q, b) => {
      if (!sess.id || D.inspecting) return { ok: true };
      const id = b.id ? Number(b.id) : null;
      if (id && D.nodes.has(id) && D.nodes.get(id).type !== 3) await send("Overlay.highlightNode", { highlightConfig: HL, nodeId: id }).catch(() => {});
      else await send("Overlay.hideHighlight", {}).catch(() => {});
      return { ok: true };
    },
    "POST /dom/inspect": async (_q, b) => { await setInspect(Boolean(b.on)); return { ok: true, inspecting: D.inspecting }; },
    "POST /dom/set-html": async (_q, b) => {
      await ensureDoc();
      if (typeof b.html !== "string") throw httpErr(400, "No HTML given");
      return setHtml(Number(b.id), b.html);
    },
    "POST /dom/copy": async (_q, b) => {
      await ensureDoc();
      const html = b.page ? await pageHtml() : await nodeHtml(Number(b.id));
      await ctx.writeClipboard(html);
      return { ok: true, chars: html.length };
    },

    "GET /app/watch": async (q) => {
      const since = Number(q.get("since") ?? -1), wait = Math.min(15000, Number(q.get("wait") ?? 0));
      const url = S.url, tid = S.targetId;
      if (since === A.ver && wait > 0) {
        const until = Date.now() + wait;
        while (A.ver === since && S.url === url && S.targetId === tid && Date.now() < until) {
          await new Promise((resolve) => { const t = setTimeout(resolve, 250); A.wakers.push(() => { clearTimeout(t); resolve(); }); });
        }
        if (S.url !== url || S.targetId !== tid) bumpApp();
        else if (A.ver !== since) await sleep(60);
      }
      return { ok: true, ver: A.ver, url: S.url, targetId: S.targetId };
    },
    "GET /app/cookies": () => cookies(),
    "POST /app/cookie-set": (_q, b) => setCookie(b.cookie, b.old),
    "POST /app/cookie-delete": async (_q, b) => { await session(); await deleteCookie(b.cookie ?? {}); bumpApp(); return { ok: true }; },
    "POST /app/cookie-clear": async () => {
      const { cookies: list } = await cookies();
      for (const c of list) await deleteCookie(c).catch(() => {});
      bumpApp();
      return { ok: true, deleted: list.length };
    },
    "GET /app/storage": async (q) => {
      const kind = q.get("kind") === "session" ? "session" : "local";
      const s = await site();
      if (!s.origin) return { ok: true, ...s, kind, items: [], none: "This page has no web origin" };
      const { entries } = await domStorage(kind, (storageId) => send("DOMStorage.getDOMStorageItems", { storageId }));
      return { ok: true, ...s, kind, items: entries };
    },
    "POST /app/storage-set": async (_q, b) => {
      const kind = b.kind === "session" ? "session" : "local";
      const key = String(b.key ?? "");
      if (!key) throw httpErr(400, "An item needs a key");
      await domStorage(kind, (storageId) => send("DOMStorage.setDOMStorageItem", { storageId, key, value: String(b.value ?? "") }));
      if (b.oldKey !== undefined && b.oldKey !== null && String(b.oldKey) !== key) {
        await domStorage(kind, (storageId) => send("DOMStorage.removeDOMStorageItem", { storageId, key: String(b.oldKey) })).catch(() => {});
      }
      bumpApp();
      return { ok: true };
    },
    "POST /app/storage-remove": async (_q, b) => {
      await domStorage(b.kind === "session" ? "session" : "local", (storageId) => send("DOMStorage.removeDOMStorageItem", { storageId, key: String(b.key ?? "") }));
      bumpApp();
      return { ok: true };
    },
    "POST /app/storage-clear": async (_q, b) => {
      await domStorage(b.kind === "session" ? "session" : "local", (storageId) => send("DOMStorage.clear", { storageId }));
      bumpApp();
      return { ok: true };
    },
    "GET /app/idb": () => idbList(),
    "GET /app/idb-data": (q) => idbData(String(q.get("db") ?? ""), String(q.get("store") ?? ""), Math.max(0, Number(q.get("skip")) || 0)),
    "GET /app/caches": () => cacheNames(),
    "GET /app/cache-entries": (q) => cacheEntries(String(q.get("cache") ?? ""), Math.max(0, Number(q.get("skip")) || 0), q.get("filter") ?? ""),
    "GET /app/cache-response": (q) => cachedResponse(String(q.get("cache") ?? ""), String(q.get("url") ?? "")),
    "POST /app/cache-delete": async (_q, b) => {
      await session();
      if (b.url) await send("CacheStorage.deleteEntry", { cacheId: String(b.cache), request: String(b.url) });
      else await send("CacheStorage.deleteCache", { cacheId: String(b.cache) });
      bumpApp();
      return { ok: true };
    },
    "GET /app/workers": () => workers(),
    "POST /app/worker-unregister": async (_q, b) => {
      await session();
      await swOn();
      await send("ServiceWorker.unregister", { scopeURL: String(b.scope ?? "") });
      await sleep(150);
      bumpApp();
      return { ok: true };
    },
    "GET /app/usage": () => usage(),
    "POST /app/clear-site": async (_q, b) => {
      const s = await needOrigin();
      const types = typeof b.types === "string" && b.types ? b.types : "all";
      await send("Storage.clearDataForOrigin", { origin: s.origin, storageTypes: types }, 30000);
      // Cookies are kept per site, not per origin: clear those the page sees too.
      if (types === "all" || types.includes("cookies")) {
        const { cookies: list } = await cookies();
        for (const c of list) await deleteCookie(c).catch(() => {});
      }
      bumpApp();
      return { ok: true, origin: s.origin };
    },
  };

  async function route(method, pathname, q, b) {
    if (!/^\/(dom|app|storage)\//.test(pathname)) return undefined;
    const h = ROUTES[`${method} ${pathname}`] ?? AGENT_ROUTES[`${method} ${pathname}`];
    if (!h) throw httpErr(404, `Unknown ${method} ${pathname}`);
    return h(q, b ?? {});
  }

  return { route };
}
