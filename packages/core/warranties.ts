import pg from "pg";
import { z } from "zod";
import { InputError } from "./input-error.ts";
import { today } from "./schedule.ts";

type Database = pg.ClientBase | pg.Pool;
const date = z.iso.date().refine((value) => value >= "1900-01-01" && value <= "2200-12-31");
const fields = z.object({
  item: z.string().trim().min(1).max(2000),
  provider: z.string().trim().min(1).max(2000),
  kind: z.enum(["manufacturer", "extended", "service_plan"]),
  purchased_on: date,
  expires_on: date.nullish(),
  expiry_unknown: z
    .boolean()
    .optional()
    .describe(
      "For null expiry, true means unknown and false means lifetime. Defaults to unknown when no date is supplied.",
    ),
  cost_cents: z.number().int().min(0).max(2147483647).nullish(),
  file_key: z.string().min(1).nullish(),
  source_ref: z.string().trim().min(1).max(2000).nullish(),
  notes: z.string().max(4000).nullish(),
});
export const recordWarrantySchema = fields.extend({
  request_id: z.uuid().describe("Generate once per write and reuse on retries."),
  id: z.uuid().optional().describe("Omit to create. Supply an existing warranty id to replace all fields."),
});
export const warrantiesCheckSchema = z.object({ as_of: date.optional() });
const warrantySchema = fields.required().extend({
  id: z.uuid(),
  expires_on: date.nullable(),
  expiry_unknown: z.boolean(),
  cost_cents: z.number().int().nullable(),
  file_key: z.string().nullable(),
  source_ref: z.string().nullable(),
  notes: z.string().nullable(),
});
const columns =
  "id::text, item, provider, kind, purchased_on::text, expires_on::text, expiry_unknown, cost_cents, file_key, source_ref, notes";

export async function recordWarranty(db: Database, input: unknown) {
  const value = recordWarrantySchema.parse(input);
  const pooled = db instanceof pg.Pool ? await db.connect() : undefined;
  const client = pooled ?? db;
  try {
    await client.query("begin");
    const claim = await client.query(
      "insert into warranty_requests (request_id, result) values ($1, '{}') on conflict do nothing returning request_id",
      [value.request_id],
    );
    if (!claim.rows.length) {
      const stored = await client.query("select result from warranty_requests where request_id = $1", [
        value.request_id,
      ]);
      const warranty = warrantySchema.parse(stored.rows[0]?.result);
      await client.query("commit");
      return { warranty, already_existed: true };
    }
    if (value.expires_on != null && value.expires_on < value.purchased_on)
      throw new InputError("Warranty expiry cannot precede purchase date.");
    if (value.expires_on != null && value.expiry_unknown === true)
      throw new InputError("A dated warranty cannot have unknown expiry.");
    const params = [
      value.item,
      value.provider,
      value.kind,
      value.purchased_on,
      value.expires_on ?? null,
      value.expiry_unknown ?? value.expires_on == null,
      value.cost_cents ?? null,
      value.file_key ?? null,
      value.source_ref ?? null,
      value.notes ?? null,
    ];
    let { rows } = value.id
      ? await client.query(
          `update warranties set item=$1, provider=$2, kind=$3, purchased_on=$4, expires_on=$5, expiry_unknown=$6, cost_cents=$7, file_key=$8, source_ref=$9, notes=$10 where id=$11 returning ${columns}`,
          [...params, value.id],
        )
      : await client.query(
          `insert into warranties (item, provider, kind, purchased_on, expires_on, expiry_unknown, cost_cents, file_key, source_ref, notes) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (source_ref) do nothing returning ${columns}`,
          params,
        );
    const already_existed = !rows.length && !value.id;
    if (already_existed)
      rows = (await client.query(`select ${columns} from warranties where source_ref = $1`, [value.source_ref])).rows;
    if (!rows.length) throw new InputError("Warranty not found. Omit id to create a warranty.");
    const warranty = warrantySchema.parse(rows[0]);
    await client.query("update warranty_requests set result = $2 where request_id = $1", [value.request_id, warranty]);
    await client.query("commit");
    return { warranty, already_existed };
  } catch (error) {
    await client.query("rollback");
    if (error instanceof pg.DatabaseError && error.constraint === "warranties_source_ref_key")
      throw new InputError("Source reference already belongs to another warranty.");
    if (error instanceof pg.DatabaseError && error.constraint === "warranties_file_key_fkey")
      throw new InputError("Warranty file_key must reference an existing file.");
    throw error;
  } finally {
    pooled?.release();
  }
}

export async function warrantiesCheck(db: Database, input: z.input<typeof warrantiesCheckSchema> = {}) {
  const { as_of = today() } = warrantiesCheckSchema.parse(input);
  const warranties = z
    .array(warrantySchema)
    .parse(
      (await db.query(`select ${columns} from warranties order by warranties.expires_on nulls last, warranties.id`))
        .rows,
    );
  type AssessedWarranty = z.infer<typeof warrantySchema> & { days: number | null };
  const groups: Record<"expired" | "expiring" | "active" | "unknown_expiry", AssessedWarranty[]> = {
    expired: [],
    expiring: [],
    active: [],
    unknown_expiry: [],
  };
  for (const warranty of warranties) {
    const days =
      warranty.expires_on === null
        ? null
        : Math.round((Date.parse(warranty.expires_on) - Date.parse(as_of)) / 86400000);
    const status = warranty.expiry_unknown
      ? "unknown_expiry"
      : days !== null && days < 0
        ? "expired"
        : days !== null && days <= 60
          ? "expiring"
          : "active";
    groups[status].push({ ...warranty, days });
  }
  return {
    as_of,
    ...groups,
    counts: {
      expired: groups.expired.length,
      expiring: groups.expiring.length,
      active: groups.active.length,
      unknown_expiry: groups.unknown_expiry.length,
    },
  };
}
