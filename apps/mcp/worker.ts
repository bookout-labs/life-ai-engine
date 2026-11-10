// life-ai's MCP server: any MCP client signs in with GitHub (the user only), then calls tools that read Neon through Hyperdrive.

import { env } from "cloudflare:workers";
import {
  AuthorizationError,
  authorizationErrorRedirect,
  CimdFetchError,
  type ConsentDescription,
  type OAuthHelpers,
  OAuthProvider,
} from "@cloudflare/workers-oauth-provider";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import pg from "pg";
import * as z from "zod";
import { payoffExplorer, payoffInputSchema } from "../../packages/core/amortize.ts";
import { billsDue, deadlinesDue } from "../../packages/core/bills.ts";
import { accounts, budgetTargets } from "../../packages/core/finances.ts";
import { investmentBuys } from "../../packages/core/investment-buys.ts";
import { fileRead, pageRead, pageSearch, pageWrite, pageWriteSchema, slugSchema } from "../../packages/core/pages.ts";
import { schedule, today } from "../../packages/core/schedule.ts";
import { publicOrigin } from "./origin.ts";

const ORIGIN = publicOrigin(
  "PUBLIC_ORIGIN" in env && typeof env.PUBLIC_ORIGIN === "string" ? env.PUBLIC_ORIGIN : undefined,
);

type Env = Cloudflare.Env & {
  OWNER: string;
  OAUTH_PROVIDER: OAuthHelpers;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
};

async function withDb<T>(env: Env, use: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: env.HYPERDRIVE.connectionString });
  await client.connect();
  try {
    return await use(client);
  } finally {
    await client.end();
  }
}

function tools(env: Env): McpServer {
  const server = new McpServer({ name: "life-ai", version: "1.0.0" });
  server.registerTool(
    "schedule",
    {
      description:
        "The family kids' practices, games and classes, starting on `from` (default today) for `days` days (default 7).",
      inputSchema: z.object({ from: z.iso.date().optional(), days: z.number().int().min(1).max(31).optional() }),
    },
    async ({ from, days }) => ({
      content: [{ type: "text", text: JSON.stringify(await withDb(env, (db) => schedule(db, from, days))) }],
    }),
  );
  server.registerTool(
    "bills_due",
    {
      description:
        "family household bills coming due and open deadlines, starting on `from` (default today) for `days` days (default 7). Amounts are the latest charge; estimates are flagged. Overdue deadlines are always included.",
      inputSchema: z.object({ from: z.iso.date().optional(), days: z.number().int().min(1).max(62).optional() }),
    },
    async ({ from = today(), days = 7 }) => {
      const result = await withDb(env, async (db) => ({
        bills: await billsDue(db, from, days),
        deadlines: await deadlinesDue(db, from, days),
      }));
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );
  server.registerTool(
    "finance_records",
    {
      description:
        "Read account records and recurring monthly budget targets in USD. Draft targets are proposals, not agreed limits. Empty lists mean no records loaded, not zero spending. Amounts are decimal strings; equal bounds mean an exact target.",
      inputSchema: z.object({}),
    },
    async () => {
      const result = await withDb(env, async (db) => ({
        accounts: await accounts(db),
        budgetTargets: await budgetTargets(db),
      }));
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );
  server.registerTool(
    "investment_buys",
    { description: "Read planned and completed investment buys.", inputSchema: z.object({}) },
    async () => ({
      content: [{ type: "text", text: JSON.stringify(await withDb(env, investmentBuys)) }],
    }),
  );
  server.registerTool(
    "payoff_explorer",
    {
      description:
        "Read-only payoff explorer for the family's loans: schedules computed from each loan's terms, starting at its latest recorded balance, compared across extra monthly principal, a lump sum, biweekly payments and, across loans, avalanche versus snowball. Each loan's latest balance is checked against the computed schedule. Amounts are dollars as decimal strings.",
      inputSchema: payoffInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => ({
      content: [{ type: "text", text: JSON.stringify(await withDb(env, (db) => payoffExplorer(db, input))) }],
    }),
  );
  server.registerTool(
    "page_read",
    { description: "Read a personal page by slug.", inputSchema: z.object({ slug: slugSchema }) },
    async ({ slug }) => ({
      content: [{ type: "text", text: JSON.stringify((await withDb(env, (db) => pageRead(db, slug))) ?? null) }],
    }),
  );
  server.registerTool(
    "page_search",
    { description: "Search personal pages using Postgres full text.", inputSchema: z.object({ text: z.string() }) },
    async ({ text }) => ({
      content: [{ type: "text", text: JSON.stringify(await withDb(env, (db) => pageSearch(db, text))) }],
    }),
  );
  server.registerTool(
    "page_write",
    {
      description:
        "Write a personal page and save its revision. Supply expected_revision to prevent overwriting a newer edit.",
      inputSchema: pageWriteSchema,
    },
    async (input) => ({
      content: [{ type: "text", text: JSON.stringify(await withDb(env, (db) => pageWrite(db, input))) }],
    }),
  );
  server.registerTool(
    "file_url",
    {
      description: "Get a private file download link valid for five minutes.",
      inputSchema: z.object({ key: z.string() }),
    },
    async ({ key }) => {
      const file = await withDb(env, (db) => fileRead(db, key));
      if (!file) throw new Error("File not found");
      const token = crypto.randomUUID();
      await env.OAUTH_KV.put(`file:${token}`, JSON.stringify(file), { expirationTtl: 300 });
      return {
        content: [{ type: "text", text: JSON.stringify({ url: `${ORIGIN}/files/${token}`, expires_in: 300 }) }],
      };
    },
  );
  return server;
}

// Client names come from self-registration, so an attacker picks them.
const html = (value: string): string => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function consentPage(d: ConsentDescription, handle: string): string {
  const local = d.redirectIsLoopback ? "<p><strong>Sends access to an app on this computer.</strong></p>" : "";
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>life-ai</title>
<style>body{font:16px system-ui;max-width:28rem;margin:3rem auto;padding:0 1rem}button{font:inherit;padding:.5rem 1rem}</style>
<h1>${html(d.clientName)} → life-ai</h1>
<p>${d.clientDomain ? escape(d.clientDomain) : "Unverified app"} · ${html(d.redirectHost)}</p>${local}
<form method="post"><input type="hidden" name="handle" value="${html(handle)}">
<button name="decision" value="approve">Allow</button> <button name="decision" value="deny">Deny</button></form>`;
}

async function sha256url(text: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return btoa(String.fromCharCode(...hash))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function authorize(req: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const url = new URL(req.url);
  if (req.method === "GET") {
    const request = await oauth.parseAuthRequest(req);
    const details = await oauth.describeConsent(request);
    const consent = await oauth.beginConsent(request);
    consent.headers.set("Content-Type", "text/html; charset=utf-8");
    return new Response(consentPage(details, consent.handle), { headers: consent.headers });
  }
  const form = await req.formData();
  const handle = String(form.get("handle"));
  if (form.get("decision") !== "approve") {
    return new Response(null, { status: 302, headers: (await oauth.denyConsent(req, handle)).headers });
  }
  const approved = await oauth.approveConsent(req, handle);
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const { state, headers } = await oauth.beginUpstream(approved.request, {
    data: { verifier },
    headers: approved.headers,
  });
  const github = new URL("https://github.com/login/oauth/authorize");
  github.search = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: `${url.origin}/callback`,
    state,
    code_challenge: await sha256url(verifier),
    code_challenge_method: "S256",
  }).toString();
  headers.set("Location", github.toString());
  return new Response(null, { status: 302, headers });
}

async function callback(req: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const url = new URL(req.url);
  const { request, data, headers } = await oauth.finishUpstream<{ verifier: string }>(req);
  const deny = (): Response => {
    headers.set("Location", authorizationErrorRedirect(request, "access_denied"));
    return new Response(null, { status: 302, headers });
  };
  const code = url.searchParams.get("code");
  if (!code) return deny();
  const exchange = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${url.origin}/callback`,
      code_verifier: data.verifier,
    }),
  });
  const { access_token } = (await exchange.json()) as { access_token?: string };
  if (!access_token) return deny();
  const user = (await (
    await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${access_token}`, "User-Agent": "life-ai-mcp" },
    })
  ).json()) as { id: number; login: string };
  // GitHub only proves who someone is; this line is what keeps everyone but the user out.
  if (user.login !== env.OWNER) return deny();
  const { redirectTo } = await oauth.completeAuthorization({
    request,
    userId: String(user.id),
    metadata: {},
    scope: request.scope,
    props: { login: user.login },
  });
  headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers });
}

export default new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: { fetch: (req, env) => createMcpHandler(() => tools(env)).fetch(req) },
  defaultHandler: {
    async fetch(req, env) {
      const path = new URL(req.url).pathname;
      try {
        if (path.startsWith("/files/")) {
          const file = await env.OAUTH_KV.get<{ key: string; mime: string }>(`file:${path.slice(7)}`, "json");
          if (!file) return new Response("not found", { status: 404 });
          const object = await env.FILES.get(file.key);
          if (!object) return new Response("not found", { status: 404 });
          return new Response(object.body, {
            headers: {
              "Content-Type": file.mime,
              "Content-Disposition": "attachment",
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
            },
          });
        }
        if (path === "/authorize") return await authorize(req, env);
        if (path === "/callback") return await callback(req, env);
        // Public on purpose: the production smoke test proves Worker → Hyperdrive → Neon without signing in, and it reveals only the schema version.
        if (path === "/health") {
          const { rows } = await withDb(env, (db) =>
            db.query<{ migration: string }>("select max(version) as migration from schema_migrations"),
          );
          return Response.json({ db: "ok", migration: rows[0]?.migration });
        }
        return new Response("not found", { status: 404 });
      } catch (error) {
        if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
        if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
          return new Response("This sign-in link expired or could not be verified. Start again from the app.", {
            status: 400,
          });
        }
        throw error;
      }
    },
  },
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  clientIdMetadataDocumentEnabled: true,
  // offline_access lets a client refresh its token instead of asking the user to sign in again.
  scopesSupported: ["mcp", "offline_access"],
  requiredScopes: ["mcp"],
  resourceMetadata: { resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] },
});
