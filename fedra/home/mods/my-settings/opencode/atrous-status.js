// atrous-opencode-status: OpenCode's status for Atrous. Installed by Atrous (Settings > Privacy >
// Agents, "OpenCode status in Atrous") into OpenCode's global plugin folder as
// ~/.config/opencode/plugins/atrous-status.js ($XDG_CONFIG_HOME/opencode/plugins). Remove it there,
// or turn the switch off, to stop it.
//
// Atrous shows an agent's state from what the agent itself reports in its terminal (OSC 7501, the
// Program Status Protocol: Claude Code and Codex speak it). OpenCode doesn't, so this plugin speaks
// it for OpenCode, from OpenCode's own session events:
//   session.status busy / retry, a step or tool starting   -> working
//   session.status idle, session.idle                       -> idle (Atrous shows "done" if you weren't looking)
//   permission.asked, question.asked                        -> blocked (needs you), until replied
// Several sessions (a subagent runs in a child session): working while any is busy, needs you while
// any asks something, idle when none is busy.
//
// Outside Atrous it does nothing: it needs ATC_TERMINAL_ID, which atrous-core gives the terminals it
// runs. It writes a few bytes to its terminal only when the state changes, and nothing else: no
// network, no files.

import fs from "node:fs";
import tty from "node:tty";

const ESC = "\x1b";
let out = null; // where the terminal is: fd 1, else the console / tty itself

function terminal() {
  if (out !== null) return out;
  out = -1;
  try {
    if (tty.isatty(1)) return (out = 1);
  } catch {}
  for (const path of process.platform === "win32" ? ["CONOUT$"] : ["/dev/tty"]) {
    try { return (out = fs.openSync(path, "w")); } catch {}
  }
  return out;
}

let last = "";
function report(state, kind) {
  const fields = [`state=${state}`, kind ? `kind=${kind}` : null, "app=opencode"].filter(Boolean).join(":");
  if (fields === last) return;
  last = fields;
  const fd = terminal();
  if (fd < 0) return;
  try { fs.writeSync(fd, `${ESC}]7501;${fields}${ESC}\\`); } catch {}
}

const statusType = (event) => {
  const s = event?.properties?.status;
  return typeof s === "string" ? s : s?.type ?? null;
};

export const AtrousOpenCodeStatus = async (_ctx) => {
  // OpenCode may call a plugin with no context during startup: never destructure it.
  if (!process.env.ATC_TERMINAL_ID) return {};
  const busy = new Set(); // sessions working
  const asking = new Map(); // request id -> session (permission or question waiting for you)
  const update = () => {
    if (asking.size) report("blocked", [...asking.values()].some((a) => a.kind === "question") ? "question" : "permission");
    else report(busy.size ? "working" : "idle");
  };
  report("idle");
  return {
    event: async ({ event }) => {
      const type = event?.type;
      if (typeof type !== "string") return;
      const p = event.properties ?? {};
      const session = p.sessionID ?? p.info?.id ?? null;
      const status = statusType(event);
      if (type === "session.status" && session) {
        if (status === "idle") busy.delete(session);
        else if (status === "busy" || status === "retry") busy.add(session);
      } else if (type === "session.idle" && session) busy.delete(session);
      else if (type.startsWith("session.next.") && session && /step\.started|tool\.(called|progress)|retried/.test(type)) busy.add(session);
      else if (type === "session.deleted" && session) busy.delete(session);
      else if (/^(permission|question)(\.v2)?\.asked$/.test(type)) {
        asking.set(p.id ?? p.requestID ?? `${type}:${session}`, { kind: type.startsWith("question") ? "question" : "permission", session });
      } else if (/^(permission|question)(\.v2)?\.(replied|rejected)$/.test(type)) {
        const id = p.requestID ?? p.permissionID ?? p.id;
        if (id && asking.has(id)) asking.delete(id);
        else for (const [k, a] of asking) if (a.session === session) asking.delete(k);
      } else return;
      update();
    },
  };
};

// OpenCode loads a plugin through its default export too: an object with server().
export default {
  id: "atrous-opencode-status",
  server: AtrousOpenCodeStatus,
};
