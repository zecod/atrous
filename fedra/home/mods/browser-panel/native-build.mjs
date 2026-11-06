// Installed mods may get fresh timestamps without changing content. Only changed inputs
// invalidate the native host, so reopening the browser never needs a redundant .NET build.
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

export function nativeBuildInputs(dir) {
  const files = fs.readdirSync(dir).filter((f) => /\.(cs|csproj|manifest|json)$/i.test(f)).sort();
  if (!files.length) throw new Error(`no native sources in ${dir}`);
  const hash = createHash("sha256").update(process.arch);
  for (const file of files) hash.update(file).update("\0").update(fs.readFileSync(path.join(dir, file))).update("\0");
  return { files, key: hash.digest("hex") };
}
