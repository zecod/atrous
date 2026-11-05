// Reads the end of Claude Code subagent transcripts for the sidebar (mods/my-spaces/subagents.js).
// The mod runtime's fs can't stat or read part of a file, and these transcripts grow to tens of MB.
//
//   node subagents-helper.cjs '{"files":[{"path":"…/agent-x.jsonl","size":123}]}'
//
// For each file: { path, size, mtimeMs, birthMs, state, activity, lastAt, result }, or
// { path, same: true, mtimeMs } when its size is the one given (nothing new).
//   state    "running": the last reply asked for a tool, or a tool result / a new prompt / an API
//            request came after it;  "done": the last reply ended its turn (stop_reason end_turn);
//            "stopped": "[Request interrupted by user]" came last.
//   activity the last tool call: its description, else { tool, path } for the mod to word.
//   result   the start of the final text, when done.
"use strict";
const fs = require("fs");

const TAIL = 256 * 1024;
const raw = process.argv[2] || "{}"; // base64 JSON (Windows mangles quotes in arguments), or plain JSON
const input = JSON.parse(raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8"));
const out = [];

for (const f of input.files || []) {
  try {
    const st = fs.statSync(f.path);
    if (f.size === st.size) { out.push({ path: f.path, same: true, mtimeMs: st.mtimeMs }); continue; }
    const len = Math.min(TAIL, st.size);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(f.path, "r");
    try { fs.readSync(fd, buf, 0, len, st.size - len); } finally { fs.closeSync(fd); }
    let lines = buf.toString("utf8").split("\n");
    if (len < st.size) lines = lines.slice(1); // the first one is cut

    let state = null, activity = null, lastAt = null, result = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i].trim();
      if (!l) continue;
      let r;
      try { r = JSON.parse(l); } catch { continue; }
      if (!lastAt && r.timestamp) lastAt = Date.parse(r.timestamp) || null;
      const m = r.message || {};
      const c = Array.isArray(m.content) ? m.content : [];
      if (r.type === "user") {
        const text = typeof m.content === "string" ? m.content : c.filter((x) => x.type === "text").map((x) => x.text).join(" ");
        if (!state && /^\s*\[Request interrupted/.test(text)) { state = "stopped"; break; }
        if (!state && (c.some((x) => x.type === "tool_result") || (text && !r.isMeta))) state = "running";
        continue;
      }
      if (r.type === "api-request") { if (!state) state = "running"; continue; }
      if (r.type !== "assistant") continue;
      if (!state) state = m.stop_reason === "end_turn" ? "done" : "running";
      if (state === "done") {
        const t = c.find((x) => x.type === "text" && x.text && x.text.trim());
        if (t) { result = t.text.trim().slice(0, 400); break; }
        continue;
      }
      const tool = c.find((x) => x.type === "tool_use");
      if (tool) {
        const inp = tool.input || {};
        activity = inp.description ? String(inp.description).slice(0, 160)
          : { tool: tool.name, path: inp.file_path || inp.path || inp.url || inp.pattern || inp.query || null };
        break;
      }
    }
    // When this run started: the latest prompt (the first one, or a later message that resumed
    // it). Not found in the tail of a big transcript: unknown (the mod then shows no time).
    let promptAt = null;
    for (let i = lines.length - 1; i >= 0 && promptAt == null; i--) {
      const l = lines[i].trim();
      if (!l || l.indexOf('"type":"user"') < 0) continue;
      let r;
      try { r = JSON.parse(l); } catch { continue; }
      const m = r.message || {};
      if (r.type !== "user" || r.isMeta) continue;
      const text = typeof m.content === "string" ? m.content
        : (Array.isArray(m.content) ? m.content : []).filter((x) => x.type === "text").map((x) => x.text).join(" ");
      if (text && !/^\s*\[(Request interrupted|Image)/.test(text) && r.timestamp) promptAt = Date.parse(r.timestamp) || null;
    }
    const birthMs = st.birthtimeMs || st.ctimeMs;
    if (promptAt == null && len === st.size) promptAt = birthMs;
    out.push({ path: f.path, size: st.size, mtimeMs: st.mtimeMs, birthMs, promptAt,
      state: state || "running", activity, lastAt: lastAt || st.mtimeMs, result });
  } catch (e) {
    out.push({ path: f.path, error: String((e && e.message) || e) });
  }
}
process.stdout.write(JSON.stringify({ files: out }));
