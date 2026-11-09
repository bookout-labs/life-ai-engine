// PreToolUse on delegate_task: before a Codex child starts, approve life-ai's own Codex hooks (the user, 2026-11-07),
// because Codex silently skips unapproved ones and nobody tells Claude.
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { repoRoot } from "./changes.ts";
import { readHookInput } from "./edits.ts";

const hookSchema = z.object({
  key: z.string().min(1),
  enabled: z.boolean(),
  trustStatus: z.string(),
  sourcePath: z.string(),
  currentHash: z.string().min(1),
});
type CodexHook = z.infer<typeof hookSchema>;
const hooksFileSchema = z.object({
  hooks: z.record(
    z.string(),
    z.array(
      z
        .object({
          hooks: z.array(z.object({ type: z.literal("command"), command: z.string().min(1) }).passthrough()),
        })
        .passthrough(),
    ),
  ),
});

function projectHooks(repo: string) {
  const inventory = execFileSync("git", ["worktree", "list", "--porcelain", "-z"], {
    cwd: repo,
    encoding: "utf8",
    stdio: "pipe",
  });
  const first = inventory.split("\0")[0];
  if (!first?.startsWith("worktree ")) throw new Error("Cannot resolve the primary Git checkout");
  const primary = realpathSync(first.slice("worktree ".length));
  const source = join(primary, ".codex", "hooks.json");
  const local = join(repo, ".codex", "hooks.json");
  const expected = readFileSync(source);
  const remediation = `Update the clean primary checkout after merge with git -C ${JSON.stringify(primary)} pull --ff-only. Review and enable hooks in Codex Settings > Hooks before the child's first prompt. Do not copy an unmerged worktree config into the primary checkout.`;
  let canApprove = false;
  try {
    canApprove = expected.equals(
      execFileSync("git", ["show", "origin/main:.codex/hooks.json"], { cwd: repo, stdio: "pipe" }),
    );
  } catch {
    // Without a merged copy there is no provenance, so approve nothing but still let trusted hooks run.
  }
  const warning =
    canApprove && expected.equals(readFileSync(local))
      ? ""
      : `Codex project hook configuration differs. Resolved source ${source}; worktree ${local}. Hooks declared on main but missing from the primary (such as rotation) are inactive. ${remediation}`;
  const config = hooksFileSchema.parse(JSON.parse(expected.toString("utf8")));
  const keys = Object.entries(config.hooks).flatMap(([event, groups]) =>
    groups.flatMap((group, i) =>
      group.hooks.map(
        (_, j) =>
          `${source}:${event.replace(/[A-Z]/g, (letter, index) => `${index ? "_" : ""}${letter.toLowerCase()}`)}:${i}:${j}`,
      ),
    ),
  );
  if (!keys.length) throw new Error(`No project hooks declared in ${source}. ${remediation}`);
  const checkApprovalSource = () => {
    if (!expected.equals(readFileSync(source)))
      throw new Error("Primary hook configuration changed during discovery; no trust was written. Retry delegation.");
  };
  return { source, keys, warning, remediation, canApprove, checkApprovalSource };
}

// Only this repo's hooks.json; a disabled hook was turned off on purpose, so it stays off.
export function toApprove(hooks: CodexHook[], hooksFile: string): CodexHook[] {
  return hooks.filter((hook) => hook.sourcePath === hooksFile && hook.enabled && hook.trustStatus !== "trusted");
}

export function unrunnable(hooks: CodexHook[]): string[] {
  return hooks.filter((hook) => !hook.enabled || hook.trustStatus !== "trusted").map((hook) => hook.key);
}

// Codex's app-server (JSON-RPC over stdio) owns hook trust; we ask it rather than edit config.toml by hand.
function codex(method: string, params: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const server = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
    const send = (message: object) => server.stdin.write(`${JSON.stringify(message)}\n`);
    const timer = setTimeout(() => server.kill(), 7_000);
    server.on("error", reject);
    server.on("exit", () => {
      clearTimeout(timer);
      reject(new Error("codex app-server exited before answering"));
    });
    createInterface({ input: server.stdout }).on("line", (line) => {
      let message: { id?: number | undefined; error?: unknown; result?: unknown };
      try {
        message = z
          .object({ id: z.number().optional(), error: z.unknown().optional(), result: z.unknown().optional() })
          .parse(JSON.parse(line));
      } catch {
        reject(new Error("Invalid JSON from codex app-server"));
        server.kill();
        return;
      }
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else if (message.id === 1) {
        send({ method: "initialized" });
        send({ id: 2, method, params });
      } else if (message.id === 2) {
        resolve(message.result);
        server.kill();
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "life-ai", version: "1" } } });
  });
}

async function listHooks(repo: string): Promise<CodexHook[]> {
  const result = await codex("hooks/list", { cwds: [repo] });
  const parsed = z.object({ data: z.array(z.object({ hooks: z.array(hookSchema) })).length(1) }).parse(result);
  return parsed.data.flatMap((entry) => entry.hooks);
}

function deny(reason: string): void {
  console.log(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
    }),
  );
}

if (import.meta.main) {
  const input = readHookInput();
  const target = (input.tool_input as { target?: { providerInstanceId?: string } } | undefined)?.target;
  if (target?.providerInstanceId === "codex") {
    try {
      const repo = repoRoot(input.cwd ?? process.cwd());
      const project = projectHooks(repo);
      const loaded = async () => {
        const hooks = (await listHooks(repo)).filter((hook) => hook.sourcePath === project.source);
        if (hooks.length !== project.keys.length || project.keys.some((key) => !hooks.some((hook) => hook.key === key)))
          throw new Error(`Codex did not load all project hooks from ${project.source}. ${project.remediation}`);
        return hooks;
      };
      const pending = toApprove(await loaded(), project.source);
      if (project.canApprove && pending.length > 0) {
        project.checkApprovalSource();
        const state = Object.fromEntries(pending.map((hook) => [hook.key, { trusted_hash: hook.currentHash }]));
        await codex("config/value/write", { keyPath: "hooks.state", mergeStrategy: "upsert", value: state });
      }
      const verified = await loaded();
      if (
        project.canApprove &&
        pending.some(
          (approved) =>
            !verified.some((hook) => hook.key === approved.key && hook.currentHash === approved.currentHash),
        )
      )
        throw new Error("Codex hook hash changed during approval; review the primary hooks and retry.");
      const bad = unrunnable(verified);
      if (bad.length > 0)
        deny(`Codex would still skip these life-ai hooks:\n${bad.join("\n")}\n${project.remediation}`);
      else if (project.warning)
        console.log(
          JSON.stringify({
            systemMessage: project.warning,
            hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: project.warning },
          }),
        );
    } catch (error) {
      deny(`Couldn't confirm Codex runs life-ai's hooks (${String(error)}). Tell the user.`);
    }
  }
}
