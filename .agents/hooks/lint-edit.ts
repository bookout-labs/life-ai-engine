// PostToolUse: apply Biome's safe fixes to the .ts files just edited and hand what remains back to the agent.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { repoRoot } from "./changes.ts";
import { editedPaths, readHookInput, reply } from "./edits.ts";

const input = readHookInput();
const edited = editedPaths(input.tool_input).filter((path) => path.endsWith(".ts"));
const repo = edited.length ? repoRoot(input.cwd ?? process.cwd()) : "";
const files = edited
  .map((path) => (isAbsolute(path) ? relative(repo, path) : path))
  .filter((path) => !path.startsWith("..") && existsSync(join(repo, path)));
const biome = join(repo, "node_modules", ".bin", "biome");

if (files.length && !existsSync(biome))
  reply("PostToolUse", `Biome isn't installed here, so ${files.join(", ")} went unlinted. Run npm ci.`);
else if (files.length) {
  const run = spawnSync(biome, ["check", "--write", "--colors=off", ...files], { cwd: repo, encoding: "utf8" });
  const out = `${run.stdout}${run.stderr}`.trim() || String(run.error ?? "Biome could not run");
  if (run.status !== 0)
    reply("PostToolUse", `Biome found issues in ${files.join(", ")}. Fix them now:\n${out.slice(0, 4000)}`);
  else if (/Fixed [1-9]/.test(out))
    reply("PostToolUse", `Biome fixed formatting in ${files.join(", ")}. Reread before patching it again.`);
}
