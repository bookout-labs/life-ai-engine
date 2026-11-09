// PostToolUse: lint the .ts files just edited and hand any errors straight back to the agent.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { repoRoot } from "./changes.ts";
import { editedPaths, readHookInput, reply } from "./edits.ts";

const input = readHookInput();
const repo = repoRoot(input.cwd ?? process.cwd());
const files = editedPaths(input.tool_input)
  .map((path) => (isAbsolute(path) ? relative(repo, path) : path))
  .filter((path) => path.endsWith(".ts") && !path.startsWith("..") && existsSync(join(repo, path)));

if (files.length > 0) {
  try {
    execFileSync(join(repo, "node_modules", ".bin", "biome"), ["check", "--colors=off", ...files], {
      cwd: repo,
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (error) {
    const { stdout = "", stderr = "" } = error as { stdout?: string; stderr?: string };
    const found = `${stdout}${stderr}`.trim().slice(0, 4000);
    if (found)
      reply(
        "PostToolUse",
        `Biome found problems in ${files.join(", ")}. Fix them now (npm run fix handles formatting):\n${found}`,
      );
  }
}
