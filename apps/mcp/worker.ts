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
import {
  activeGoals,
  recordGoal,
  recordGoalSchema,
  setGoalStatus,
  setGoalStatusSchema,
} from "../../packages/core/goals.ts";
import { investmentBuys } from "../../packages/core/investment-buys.ts";
import { logWorkout, logWorkoutSchema } from "../../packages/core/log-workout.ts";
import { readMoneyCheck } from "../../packages/core/money-check.ts";
import { fileRead, pageRead, pageSearch, pageWrite, pageWriteSchema, slugSchema } from "../../packages/core/pages.ts";
import { recordInvestmentBuy, recordInvestmentBuySchema } from "../../packages/core/record-investment-buy.ts";
import { schedule, today } from "../../packages/core/schedule.ts";
import { importSpending, readSpending, spendingInputSchema } from "../../packages/core/spending.ts";
import { fromConnector, importTransactionsSchema } from "../../packages/core/spending-import.ts";
import { trainingTrend, trainingTrendSchema } from "../../packages/core/training-trend.ts";
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
    "money_check",
    {
      description:
        "Read money needing attention from today through day six. Returns bills_due rows unchanged, overdue charges from the past 60 days, a stale_unpaid count for older unpaid charges, and the latest confirmed price increase per active obligation. Amount and date estimate flags come from bills_due; unknown amounts are null and counted separately from decimal totals. Percent increases are rounded to two decimals, or null for a zero baseline. No spending or transaction anomaly analysis.",
      inputSchema: z.object({ from: z.iso.date().optional() }),
      annotations: { readOnlyHint: true },
    },
    async ({ from = today() }) => ({
      content: [{ type: "text", text: JSON.stringify(await withDb(env, (db) => readMoneyCheck(db, from))) }],
    }),
  );
  server.registerTool(
    "spending",
    {
      description:
        "Read USD spending for a month (YYYY-MM), optionally by category, through today in America/Chicago. Includes category targets, calendar-day pace, top 10 merchants and unusual-charge cues from loaded history. Draft targets are proposals. Expenses positive; credits negative. Pending, transfer, hidden and income rows excluded.",
      inputSchema: spendingInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => ({
      content: [{ type: "text", text: JSON.stringify(await withDb(env, (db) => readSpending(db, input))) }],
    }),
  );
  server.registerTool(
    "import_transactions",
    {
      description:
        'Import one finance connector page as-is, up to 100 transactions, with source "monarch". Re-importing a page is safe; unchanged rows are not updated. Connector amounts are negated into USD expenses positive and refunds negative. Account references use account_id only. Defaults exclude Transfer, Credit Card Payment and Balance Adjustments as transfer, Paychecks, Interest, Business Income and Other Income as income. Exclusion category names and override keys ignore case and surrounding whitespace. Supply exclude for renamed categories and hidden for a hidden page. Returns processed, inserted, updated and excluded counts; excluded counts all excluded input rows, including unchanged ones.',
      inputSchema: importTransactionsSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ transactions, ...options }) =>
      writeResult(env, (db) => importSpending(db, fromConnector(transactions, options))),
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
    "record_investment_buy",
    {
      description:
        "Record a planned or completed investment buy. Amount is a positive decimal string in dollars. Generate request_id once per logical buy and reuse it on every retry. A reused ID returns the original buy without updating it.",
      inputSchema: recordInvestmentBuySchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (input) => writeResult(env, (db) => recordInvestmentBuy(db, input)),
  );
  server.registerTool(
    "log_workout",
    {
      description:
        "Log a finished training session and its blocks atomically. Positions define block order. Weight is a decimal string with lb or kg. Generate request_id once per session and reuse it on every retry. A reused ID returns the original session and block IDs without updating them.",
      inputSchema: logWorkoutSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (input) => writeResult(env, (db) => logWorkout(db, input)),
  );
  server.registerTool(
    "training_trend",
    {
      description:
        "Read weekly logged training totals and burnout warning heuristics, not a diagnosis. Defaults to eight Monday-start ISO weeks through today in America/Chicago. asOf is a stored local calendar date. The current week is partial and excluded from spike and drop checks. Duration sums known block seconds. Volume converts known weight x sets x reps to kg. Coverage counts expose missing measurements. No-rest counts every session kind. Empty weeks mean no logs, not proven inactivity. Flags include reasons and evidence weeks.",
      inputSchema: trainingTrendSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => ({
      content: [{ type: "text", text: JSON.stringify(await withDb(env, (db) => trainingTrend(db, input))) }],
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
    "goals",
    {
      description:
        "Read active goals grouped by area, with optional numeric targets, due dates and plan page links. An empty list means no active goals recorded. Progress and cadence live in the linked plan pages.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => ({
      content: [{ type: "text", text: JSON.stringify(await withDb(env, activeGoals)) }],
    }),
  );
  server.registerTool(
    "record_goal",
    {
      description:
        "Create an active goal linked to an existing plan page. An optional measure pairs a decimal-string target with its unit. Generate request_id once per goal and reuse it on retries. A reused ID returns the stored goal without changing it.",
      inputSchema: recordGoalSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (input) => writeResult(env, (db) => recordGoal(db, input)),
  );
  server.registerTool(
    "set_goal_status",
    {
      description:
        "Mark a goal done or dropped, or back to active, by id from the goals tool. A missing id returns null.",
      inputSchema: setGoalStatusSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (input) => writeResult(env, (db) => setGoalStatus(db, input)),
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

async function writeResult<T>(env: Env, use: (client: pg.Client) => Promise<T>) {
  try {
    const result = await withDb(env, use);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  } catch (error) {
    const text =
      error instanceof pg.DatabaseError && error.code?.startsWith("23")
        ? `Record rejected by database constraint ${error.constraint ?? error.code}. Check the input fields.`
        : "Could not save the record. Retry with the same request_id.";
    return { isError: true, content: [{ type: "text" as const, text }] };
  }
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
