import pg from "pg";
import { z } from "zod";

const memberId = z
  .string()
  .regex(/^[1-9]\d{0,18}$/)
  .refine((id) => BigInt(id) <= 9223372036854775807n);
const money = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/);
const status = z.enum(["idea", "planned", "bought", "wrapped", "given"]);
export const giftsInputSchema = z.object({
  occasion_id: z
    .string()
    .max(100)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
});
const command = { request_id: z.uuid() };
const gift = {
  ...giftsInputSchema.shape,
  recipient_id: memberId,
  idea: z.string().trim().min(1).max(500),
  amount: money,
  status,
  buyer_id: memberId.nullish(),
  link: z
    .url()
    .max(2000)
    .refine((value) => /^https?:\/\//.test(value))
    .nullish(),
  note: z.string().max(4000).nullish(),
};
export const writeGiftSchema = z.discriminatedUnion("action", [
  z.object({
    ...command,
    ...giftsInputSchema.shape,
    action: z.literal("occasion"),
    title: z.string().trim().min(1).max(200),
    budget: money.nullable(),
  }),
  z.object({
    ...command,
    ...giftsInputSchema.shape,
    action: z.literal("recipient"),
    member_id: memberId,
    budget: money.nullable(),
  }),
  z.object({ ...command, ...gift, action: z.literal("add_gift") }),
  z.object({ ...command, ...gift, action: z.literal("update_gift"), gift_id: z.uuid() }),
  z.object({ ...command, action: z.literal("status"), gift_id: z.uuid(), status }),
]);
const resultSchema = z.object({ id: z.string() });
type Database = pg.ClientBase | pg.Pool;

export async function writeGift(db: Database, input: z.input<typeof writeGiftSchema>) {
  const value = writeGiftSchema.parse(input);
  const pooled = db instanceof pg.Pool ? await db.connect() : undefined;
  const client = pooled ?? db;
  try {
    await client.query("begin");
    const claim = await client.query(
      "insert into gift_requests (request_id, result) values ($1, '{}') on conflict do nothing returning request_id",
      [value.request_id],
    );
    if (!claim.rows.length) {
      const stored = await client.query("select result from gift_requests where request_id = $1", [value.request_id]);
      const result = resultSchema.parse(stored.rows[0]?.result);
      await client.query("commit");
      return { ...result, already_existed: true };
    }
    let rows: unknown[];
    switch (value.action) {
      case "occasion":
        ({ rows } = await client.query(
          `insert into gift_occasions (id, title, budget) values ($1, $2, $3)
           on conflict (id) do update set title = excluded.title, budget = excluded.budget returning id`,
          [value.occasion_id, value.title, value.budget],
        ));
        break;
      case "recipient":
        ({ rows } = await client.query(
          `insert into gift_recipients (occasion_id, member_id, budget) values ($1, $2, $3)
           on conflict (occasion_id, member_id) do update set budget = excluded.budget returning member_id::text as id`,
          [value.occasion_id, value.member_id, value.budget],
        ));
        break;
      case "add_gift":
      case "update_gift": {
        const values = [
          value.occasion_id,
          value.recipient_id,
          value.idea,
          value.amount,
          value.status,
          value.buyer_id ?? null,
          value.link ?? null,
          value.note ?? null,
        ];
        ({ rows } =
          value.action === "add_gift"
            ? await client.query(
                `insert into gifts (occasion_id, recipient_id, idea, amount, status, buyer_id, link, note)
              values ($1, $2, $3, $4, $5, $6, $7, $8) returning id::text`,
                values,
              )
            : await client.query(
                `update gifts set recipient_id = $2, idea = $3, amount = $4, status = $5, buyer_id = $6, link = $7, note = $8
              where occasion_id = $1 and id = $9 returning id::text`,
                [...values, value.gift_id],
              ));
        break;
      }
      case "status":
        ({ rows } = await client.query("update gifts set status = $2 where id = $1 returning id::text", [
          value.gift_id,
          value.status,
        ]));
        break;
      default: {
        const exhaustive: never = value;
        throw new Error(`Unknown gift command ${exhaustive}`);
      }
    }
    const result = resultSchema.parse(rows[0]);
    await client.query("update gift_requests set result = $2 where request_id = $1", [value.request_id, result]);
    await client.query("commit");
    return { ...result, already_existed: false };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    pooled?.release();
  }
}

const totalsSchema = z.object({
  planned: z.string(),
  bought: z.string(),
  left: z.string().nullable(),
  over_budget: z.boolean(),
});
const summarySchema = z.object({
  id: z.string(),
  title: z.string(),
  budget: z.string().nullable(),
  totals: totalsSchema,
  recipients: z.array(
    totalsSchema.extend({
      member_id: z.string(),
      name: z.string(),
      budget: z.string().nullable(),
      no_gift: z.boolean(),
    }),
  ),
  buyers: z.array(
    z.object({ buyer_id: z.string().nullable(), name: z.string().nullable(), planned: z.string(), bought: z.string() }),
  ),
  gifts: z.array(
    z.object({
      id: z.uuid(),
      recipient_id: z.string(),
      idea: z.string(),
      amount: z.string(),
      status,
      buyer_id: z.string().nullable(),
      link: z.string().nullable(),
      note: z.string().nullable(),
    }),
  ),
});

export async function readGifts(db: Database, input: z.input<typeof giftsInputSchema>) {
  const { occasion_id } = giftsInputSchema.parse(input);
  const { rows } = await db.query(
    `
    with entries as (
      select *, case when status = 'planned' then amount else 0::numeric(12,2) end as planned,
        case when status in ('bought', 'wrapped', 'given') then amount else 0::numeric(12,2) end as bought
      from gifts where occasion_id = $1
    ), recipient_totals as (
      select r.member_id::text, coalesce(m.goes_by, m.first_name) as name, r.budget,
        coalesce(sum(e.planned), 0.00) as planned, coalesce(sum(e.bought), 0.00) as bought,
        count(e.id) = 0 as no_gift
      from gift_recipients r join members m on m.id = r.member_id
      left join entries e on e.recipient_id = r.member_id where r.occasion_id = $1 group by r.member_id, r.budget, m.id
    ), buyer_totals as (
      select e.buyer_id::text, coalesce(m.goes_by, m.first_name) as name,
        sum(e.planned)::text as planned, sum(e.bought)::text as bought
      from entries e left join members m on m.id = e.buyer_id group by e.buyer_id, m.id
    ), totals as (
      select coalesce(sum(planned), 0.00) as planned, coalesce(sum(bought), 0.00) as bought from entries
    )
    select o.id, o.title, o.budget::text,
      jsonb_build_object('planned', t.planned::text, 'bought', t.bought::text,
        'left', (o.budget - t.planned - t.bought)::text, 'over_budget', coalesce(t.planned + t.bought > o.budget, false)) as totals,
      coalesce((select jsonb_agg(jsonb_build_object('member_id', r.member_id, 'name', r.name, 'budget', r.budget::text,
        'planned', r.planned::text, 'bought', r.bought::text, 'left', (r.budget - r.planned - r.bought)::text,
        'over_budget', coalesce(r.planned + r.bought > r.budget, false), 'no_gift', r.no_gift) order by r.member_id::bigint) from recipient_totals r), '[]') as recipients,
      coalesce((select jsonb_agg(to_jsonb(b) order by b.buyer_id::bigint nulls last) from buyer_totals b), '[]') as buyers,
      coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'recipient_id', e.recipient_id::text, 'idea', e.idea,
        'amount', e.amount::text, 'status', e.status, 'buyer_id', e.buyer_id::text, 'link', e.link, 'note', e.note) order by e.id) from entries e), '[]') as gifts
    from gift_occasions o cross join totals t where o.id = $1`,
    [occasion_id],
  );
  return rows[0] ? summarySchema.parse(rows[0]) : null;
}
