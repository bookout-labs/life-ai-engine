// PreToolUse on delegate_task: before a Codex child starts, approve life-ai's own Codex hooks (the user, 2026-11-07),
// because Codex silently skips unapproved ones and nobody tells Claude.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { repoRoot } from "./changes.ts";
import { readHookInput } from "./edits.ts";

type CodexHook = { key: string; enabled: boolean; trustStatus: string; sourcePath: string; currentHash: string };

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
    const timer = setTimeout(() => server.kill(), 20_000);
    server.on("error", reject);
    server.on("exit", () => {
      clearTimeout(timer);
      reject(new Error("codex app-server exited before answering"));
    });
    createInterface({ input: server.stdout }).on("line", (line) => {
      const message = JSON.parse(line);
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
  return (result as { data?: { hooks?: CodexHook[] }[] }).data?.[0]?.hooks ?? [];
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
    const repo = repoRoot(input.cwd ?? process.cwd());
    try {
      const pending = toApprove(await listHooks(repo), join(repo, ".codex", "hooks.json"));
      if (pending.length > 0) {
        const state = Object.fromEntries(pending.map((hook) => [hook.key, { trusted_hash: hook.currentHash }]));
        await codex("config/value/write", { keyPath: "hooks.state", mergeStrategy: "upsert", value: state });
      }
      const bad = unrunnable(await listHooks(repo));
      if (bad.length > 0) deny(`Codex would still skip these life-ai hooks:\n${bad.join("\n")}\nTell the user.`);
    } catch (error) {
      deny(`Couldn't confirm Codex runs life-ai's hooks (${String(error)}). Tell the user.`);
    }
  }
}
