import type pg from "pg";
import { z } from "zod";
import { slugSchema } from "./pages.ts";

const cents = z.number().int().min(0).max(9_000_000_000_000);
const id = z
  .string()
  .regex(/^[1-9]\d{0,18}$/)
  .refine((v) => BigInt(v) <= 9223372036854775807n);
const bucket = z.string().trim().min(1).max(120);
const destination = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("account"), id }),
  z.strictObject({ kind: z.literal("loan"), id }),
]);
const base = { bucket, destination: destination.optional() };
const ruleSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...base, kind: z.literal("percent"), basis_points: z.number().int().min(0).max(10000) }),
  z.strictObject({ ...base, kind: z.literal("fixed"), amount_cents: cents }),
  z.strictObject({ ...base, kind: z.literal("fill"), target_cents: cents, cap_cents: cents }),
  z.strictObject({ ...base, kind: z.literal("remainder") }),
]);
const rulesSchema = z
  .array(ruleSchema)
  .min(1)
  .max(50)
  .superRefine((rules, ctx) => {
    if (rules.filter((r) => r.kind === "remainder").length !== 1 || rules.at(-1)?.kind !== "remainder")
      ctx.addIssue({ code: "custom", message: "Exactly one final remainder bucket is required" });
    if (rules.reduce((sum, r) => sum + (r.kind === "percent" ? r.basis_points : 0), 0) > 10000)
      ctx.addIssue({ code: "custom", message: "Percent rules exceed 100% of gross" });
    if (new Set(rules.map((r) => r.bucket)).size !== rules.length)
      ctx.addIssue({ code: "custom", message: "Bucket names must be unique" });
  });
export const commissionSplitSchema = z.object({
  gross_cents: cents,
  on: z.iso.date(),
  balances: z
    .array(z.strictObject({ bucket, balance_cents: cents, as_of: z.iso.date() }))
    .max(50)
    .default([]),
});
export const recordCommissionPlanSchema = z.object({
  request_id: z.uuid(),
  effective_on: z.iso.date(),
  page_slug: slugSchema,
  rules: rulesSchema,
});
const planSchema = recordCommissionPlanSchema.extend({ id: z.string() });

export function computeCommissionSplit(input: z.input<typeof commissionSplitSchema>, rawRules: unknown) {
  const { gross_cents, on, balances } = commissionSplitSchema.parse(input);
  if (Array.isArray(rawRules) && rawRules.length === 0)
    return {
      status: "no_plan",
      message: "No commission split plan is recorded.",
      buckets: [],
      total_cents: 0,
      gross_cents,
      on,
    };
  const rules = rulesSchema.parse(rawRules);
  if (new Set(balances.map((b) => b.bucket)).size !== balances.length)
    throw new Error("Provide only one balance per bucket");
  const missing = rules.filter(
    (r) => r.kind === "fill" && !balances.some((b) => b.bucket === r.bucket && b.as_of === on),
  );
  if (missing.length)
    return {
      status: "needs_balance",
      message: "Provide a balance dated on the commission date for each fill bucket before allocating.",
      missing_buckets: missing.map((r) => r.bucket),
      buckets: [],
      total_cents: 0,
      gross_cents,
      on,
    };
  let remaining = BigInt(gross_cents);
  const buckets = rules.map((rule) => {
    let requested: bigint;
    let reason: string;
    switch (rule.kind) {
      case "percent":
        requested = (BigInt(gross_cents) * BigInt(rule.basis_points)) / 10000n;
        reason = `${rule.basis_points / 100}% of gross, rounded down to cents`;
        break;
      case "fixed":
        requested = BigInt(rule.amount_cents);
        reason = `Fixed allocation of ${rule.amount_cents} cents`;
        break;
      case "fill": {
        const balance = balances.find((b) => b.bucket === rule.bucket && b.as_of === on);
        if (!balance) throw new Error("Fill balance missing");
        const gap = BigInt(rule.target_cents) - BigInt(balance.balance_cents);
        requested = gap < 0n ? 0n : gap > BigInt(rule.cap_cents) ? BigInt(rule.cap_cents) : gap;
        reason = `Fill to ${rule.target_cents} cents, capped at ${rule.cap_cents} cents using the supplied balance on ${on}`;
        break;
      }
      case "remainder":
        requested = remaining;
        reason = "Remaining gross including rounding pennies";
        break;
      default: {
        const exhaustive: never = rule;
        throw new Error(`Unknown rule ${exhaustive}`);
      }
    }
    const amount = requested > remaining ? remaining : requested;
    remaining -= amount;
    return {
      bucket: rule.bucket,
      amount_cents: Number(amount),
      destination: rule.destination ?? null,
      reason: amount < requested ? `${reason}; limited by remaining gross` : reason,
    };
  });
  return { status: "ready", buckets, total_cents: gross_cents, gross_cents, on };
}

const columns = "id::text, request_id::text, effective_on::text, page_slug, rules";
export async function recordCommissionPlan(
  db: pg.ClientBase | pg.Pool,
  input: z.input<typeof recordCommissionPlanSchema>,
) {
  const plan = recordCommissionPlanSchema.parse(input);
  const prior = await db.query(`select ${columns} from commission_plans where request_id = $1`, [plan.request_id]);
  if (prior.rows[0]) return { plan: planSchema.parse(prior.rows[0]), already_existed: true };
  for (const rule of plan.rules) {
    if (!rule.destination) continue;
    const table = rule.destination.kind === "account" ? "accounts" : "loans";
    const found = await db.query(`select 1 from ${table} where ${table === "loans" ? "obligation_id" : "id"} = $1`, [
      rule.destination.id,
    ]);
    if (!found.rows.length)
      throw new Error(
        `Destination ${rule.destination.kind} ${rule.destination.id} for bucket ${rule.bucket} not found`,
      );
  }
  const page = await db.query("select slug from pages where slug = $1 and deleted_at is null", [plan.page_slug]);
  if (!page.rows.length) throw new Error(`Plan page ${plan.page_slug} not found`);

  const { rows } = await db.query(
    `insert into commission_plans (request_id, effective_on, page_slug, rules) values ($1, $2, $3, $4)
     on conflict (request_id) do nothing returning ${columns}`,
    [plan.request_id, plan.effective_on, plan.page_slug, JSON.stringify(plan.rules)],
  );
  const stored =
    rows[0] ??
    (await db.query(`select ${columns} from commission_plans where request_id = $1`, [plan.request_id])).rows[0];
  return { plan: planSchema.parse(stored), already_existed: rows.length === 0 };
}

export async function commissionSplit(db: pg.ClientBase | pg.Pool, input: z.input<typeof commissionSplitSchema>) {
  const parsed = commissionSplitSchema.parse(input);
  const { rows } = await db.query(
    `select ${columns} from commission_plans where effective_on <= $1 order by commission_plans.effective_on desc, commission_plans.id desc limit 1`,
    [parsed.on],
  );
  const plan = rows[0] ? planSchema.parse(rows[0]) : null;
  const result = computeCommissionSplit(parsed, plan?.rules ?? []);
  if (!plan) {
    const next = await db.query<{ effective_on: string }>(
      "select min(effective_on)::text as effective_on from commission_plans where effective_on > $1",
      [parsed.on],
    );
    if (next.rows[0]?.effective_on)
      result.message = `No commission split plan is effective on ${parsed.on}. Next effective date: ${next.rows[0].effective_on}.`;
  }
  const destinations_missing: string[] = [];
  for (const rule of plan?.rules ?? []) {
    const dest = rule.destination;
    if (
      dest &&
      !(
        await db.query(
          `select 1 from ${dest.kind === "account" ? "accounts" : "loans"} where ${dest.kind === "account" ? "id" : "obligation_id"} = $1`,
          [dest.id],
        )
      ).rows.length
    )
      destinations_missing.push(rule.bucket);
  }
  return { ...result, plan, destinations_missing };
}
