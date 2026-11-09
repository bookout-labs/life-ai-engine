// Proves the deployed Worker works in production: database path, sign-in wall, OAuth discovery.
import { appendFileSync, readdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { publicOrigin } from "./origin.ts";

const ORIGIN = publicOrigin(process.env.PUBLIC_ORIGIN);

const latest = readdirSync(new URL("../../db/migrations", import.meta.url))
  .sort()
  .at(-1)
  ?.split("_")[0];

async function check(name: string, test: () => Promise<string | true>): Promise<boolean> {
  // A fresh deploy takes a few seconds to reach every edge.
  for (let attempt = 1; attempt <= 5; attempt++) {
    const result = await test().catch((err: unknown) => String(err));
    if (result === true || attempt === 5) {
      const line = result === true ? `✅ ${name}` : `❌ ${name}: ${result}`;
      console.log(line);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
      return result === true;
    }
    await sleep(3000);
  }
  return false;
}

const results = [
  await check(`Neon reached through Hyperdrive, at migration ${latest}`, async () => {
    const body = (await (await fetch(`${ORIGIN}/health`)).json()) as { db?: string; migration?: string };
    return (body.db === "ok" && body.migration === latest) || `got ${JSON.stringify(body)}`;
  }),
  await check("MCP endpoint refuses requests without sign-in", async () => {
    const res = await fetch(`${ORIGIN}/mcp`, { method: "POST" });
    return (
      (res.status === 401 && Boolean(res.headers.get("www-authenticate")?.includes("resource_metadata"))) ||
      `status ${res.status}`
    );
  }),
  await check("OAuth discovery names this server", async () => {
    const meta = (await (await fetch(`${ORIGIN}/.well-known/oauth-authorization-server`)).json()) as {
      issuer?: string;
    };
    return meta.issuer === ORIGIN || `issuer ${meta.issuer}`;
  }),
];
if (results.includes(false)) process.exit(1);
