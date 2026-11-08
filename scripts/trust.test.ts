import { test, expect } from "bun:test";
import { readFile } from "node:fs/promises";

// Flow, the sidebar and the status bar each keep a copy (mods can't import across folders).
const COPIES = ["flow-canvas", "my-spaces", "my-status"];
const text = (mod: string) => readFile(new URL(`../fedra/home/mods/${mod}/trust.js`, import.meta.url), "utf8");
const code = (source: string) => source.slice(source.indexOf("import { core }"));

function load(source: string, core: (args: string[]) => Promise<unknown>) {
  const body = source.replace(/^import .*;\n/gm, "").replace(/^export /gm, "");
  return new Function("core", `${body}; return { poll };`)(core);
}

test("the copies stay the same apart from their header", async () => {
  const [first, ...rest] = await Promise.all(COPIES.map(text));
  for (const copy of rest) expect(code(copy)).toBe(code(first));
});

test("a starting agent's screen is read without its history, so a full-screen one is never scrolled", async () => {
  // Asking for history makes the core scroll a full-screen agent (Claude Code) and hold the
  // person's typing meanwhile: typing in a new agent stalled about a second every read.
  for (const mod of COPIES) {
    const calls: string[][] = [];
    const tasks: Promise<unknown>[] = [];
    const { poll } = load(await text(mod), async (args: string[]) => {
      calls.push(args);
      return { code: 0, stdout: "Welcome\n> \n" };
    });
    const view = { prompts: new Map() };
    const cx = { notify() {}, spawn(fn: (cx: unknown) => Promise<unknown>) { tasks.push(fn(cx)); } };
    poll(view, cx, () => [{ address: "t7", ask: true }]);
    await Promise.all(tasks);
    expect(calls, mod).toEqual([["read", "t7"]]);
    expect(view.prompts.get("t7")?.prompt, mod).toBeNull();
  }
});
