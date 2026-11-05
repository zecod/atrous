import { describe, expect, test } from "bun:test";
import { checkExample, checkMarkdown, commandPage, type Reference } from "./docs";

const ref: Reference = {
  help: "Usage:\n  atrous status\n  atrous ls\n  atrous do <command> [args]\n  atrous commands\n  atrous --skill\n  atrous --version\n",
  commands: [{ name: "pane.split", about: "Split a pane.", args: [{ name: "direction", required: true }] }],
};

describe("CLI examples", () => {
  test("validates commands and named arguments without executing examples", () => {
    for (const source of ["atrous", "atrous ls", "atrous --help", "atrous --skill", "atrous do pane.split --direction right", `atrous do pane.split '{"direction":"right"}'`]) {
      expect(checkExample(source, ref)).toEqual([]);
    }
    expect(checkExample("atrous wat", ref)).toEqual(["unknown command or flag: wat"]);
    expect(checkExample("atrous ls && atrous wat", ref)).toEqual(["unknown command or flag: wat"]);
    expect(checkExample("atrous --wat", ref)).toHaveLength(1);
    expect(checkExample("atrous ls --wat", ref)).toHaveLength(1);
    expect(checkExample("atrous do pane.wat", ref)).toHaveLength(1);
    expect(checkExample("atrous do pane.split --wat right", ref)).toHaveLength(1);
    expect(checkExample("atrous do pane.split --direction=right", ref)).toContain("unknown flag for do: --direction=right");
    expect(checkExample("atrous do pane.split --direction='right'", ref)).toContain("unknown flag for do: --direction=right");
    expect(checkExample('atrous ls "--wat"', ref)).toEqual(["unknown flag for ls: --wat"]);
    expect(checkExample('atrous do pane.split "--wat" right', ref)).toEqual(["unknown flag for do: --wat"]);
    expect(checkExample('atrous do pane.split "--direction" "right"', ref)).toEqual([]);
    expect(checkExample("atrous do pane.split --direction", ref)).toEqual(["missing value for --direction"]);
  });

  test("ignores flags inside quotes and comments, and other programs", () => {
    expect(checkExample(`atrous do pane.split --direction '--not-a-flag' # --comment`, ref)).toEqual([]);
    expect(checkExample("curl --not-our-flag https://example.org", ref)).toEqual([]);
    expect(checkExample("atrous ls | other --not-our-flag", ref)).toEqual([]);
    expect(checkExample("atrous do pane.split --direction atrous", ref)).toEqual([]);
  });

  test("reports inline and fenced examples with file and line", () => {
    expect(checkMarkdown("README.md", "Text `atrous wat`.\n\n```sh\natrous ls --wat\n```", ref)).toEqual([
      "README.md:1: unknown command or flag: wat",
      "README.md:4: unknown flag for ls: --wat",
    ]);
    expect(checkMarkdown("docs/example.md", "~~~sh\natrous do pane.split \\\n  --wat right\n~~~", ref)).toEqual(["docs/example.md:2: unknown flag for do: --wat"]);
    expect(checkMarkdown("README.md", "Plain prose atrous wat is not code.", ref)).toEqual([]);
  });
});

test("command reference comes from the catalog", () => {
  const page = commandPage(ref.commands);
  expect(page).toContain("## `pane.split`");
  expect(page).toContain("| `direction` | yes |");
  expect(page).toContain("Split a pane.");
  expect(checkMarkdown("docs/commands.md", page, ref)).toEqual([]);
});

