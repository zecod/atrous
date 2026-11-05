import { expect, test } from "bun:test";
import { mediaUrls, version } from "./notes-media";

test("version is a single safe directory component", () => {
  expect(version("0.1.4")).toBe("0.1.4");
  expect(version("1.2.3-beta.1")).toBe("1.2.3-beta.1");
  for (const v of ["../0.1.4", "v0.1.4", "", "0.1.4/peek", "0.1.4?x"]) {
    expect(() => version(v)).toThrow();
  }
});

test("gate checks only the requested entry and deduplicates images", () => {
  const notes = "## [0.1.4] - 2026-10-23\n- Demo\n![one](https://github.com/zecod/atrous/releases/download/v0.1.4/peek.webp)\n  ![two](https://github.com/zecod/atrous/releases/download/v0.1.4/peek.webp)\n## [0.1.3] - 2026-10-22\n![old](https://example.com/old.png)\n";
  expect(mediaUrls(notes, "0.1.4")).toEqual(["https://github.com/zecod/atrous/releases/download/v0.1.4/peek.webp"]);
  expect(() => mediaUrls(notes, "0.1.2")).toThrow();
  expect(() => mediaUrls(notes + "## [0.1.4] - duplicate\n", "0.1.4")).toThrow();
});

test("spotlight platform comments do not interfere with the release media gate", () => {
  for (const marker of ["<!-- spotlight -->", "<!-- spotlight macos -->", "<!-- spotlight macos linux -->"]) {
    const notes = `## [0.1.4] - today\n${marker}\n### New\n- A change.\n`;
    expect(mediaUrls(notes, "0.1.4")).toEqual([]);
    expect(mediaUrls(notes + "![demo](https://github.com/zecod/atrous/releases/download/v0.1.4/peek.webp)\n", "0.1.4")).toEqual(["https://github.com/zecod/atrous/releases/download/v0.1.4/peek.webp"]);
  }
});

test("media-free entries pass but malformed images cannot disappear", () => {
  expect(mediaUrls("## [0.1.4] - today\n- No clip.\n", "0.1.4")).toEqual([]);
  expect(() => mediaUrls("## [0.1.4] - today\n![broken]\n", "0.1.4")).toThrow();
  expect(mediaUrls("## [0.1.4] - today\n![bad](http://example.com/a.png)\n", "0.1.4")).toEqual(["http://example.com/a.png"]);
});
