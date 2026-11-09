import { setTimeout as sleep } from "node:timers/promises";

type CheckRun = { name: string; status: string; conclusion: string | null; startedAt: string | null };
type PullStatus = { state: string; statusCheckRollup: CheckRun[] };

export async function waitForMerge(
  gh: (...args: string[]) => string,
  pr: string,
  {
    now = Date.now,
    pause = sleep,
    timeoutMs = 30 * 60_000,
  }: {
    now?: () => number;
    pause?: (ms: number) => Promise<void>;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  const start = now();
  for (;;) {
    const status: PullStatus = JSON.parse(gh("pr", "view", pr, "--json", "state,statusCheckRollup"));
    const required = ["check", "gate", "secrets"].map(
      (name) =>
        status.statusCheckRollup
          .filter((c) => c.name === name)
          .sort((a, b) => (b.startedAt ?? "9999").localeCompare(a.startedAt ?? "9999"))[0],
    );
    const failed = required.find((c) => c?.status === "COMPLETED" && c.conclusion !== "SUCCESS");
    if (failed) throw new Error(`${failed.name} failed on ${pr}: ${failed.conclusion}`);
    if (required.every((c) => c?.status === "COMPLETED" && c.conclusion === "SUCCESS") && status.state === "MERGED")
      return;
    if (status.state === "CLOSED") throw new Error(`${pr} closed without merging`);
    if (now() - start >= timeoutMs) throw new Error(`Timed out waiting for check, gate, secrets and merge on ${pr}`);
    await pause(5000);
  }
}
