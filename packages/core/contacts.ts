import pg from "pg";
import { z } from "zod";
import { InputError } from "./input-error.ts";

type Database = pg.ClientBase | pg.Pool;
const targetId = z
  .string()
  .regex(/^[1-9]\d{0,18}$/)
  .refine((id) => BigInt(id) <= 9223372036854775807n);
const role = z.enum([
  "teacher",
  "coach",
  "doctor",
  "dentist",
  "vet",
  "contractor",
  "service_provider",
  "neighbor",
  "friend",
  "other",
]);
const link = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("member"), id: targetId }),
  z.object({ kind: z.literal("activity"), id: targetId }),
]);
const fields = z.object({
  name: z.string().trim().min(1).max(300),
  role,
  organisation: z.string().trim().min(1).max(300).nullable().default(null),
  phone: z
    .string()
    .trim()
    .regex(/^[+0-9() .-]+$/)
    .refine((s) => {
      const digits = s.replace(/\D/g, "").length;
      return digits >= 7 && digits <= 20;
    }, "Phone must contain 7 to 20 digits and common phone punctuation only.")
    .nullable()
    .default(null),
  email: z
    .string()
    .trim()
    .max(254)
    .regex(/^[^\s@]+@[^\s@.]+[.][^\s@]+$/)
    .nullable()
    .default(null),
  address: z.string().trim().min(1).max(2000).nullable().default(null),
  notes: z.string().max(4000).nullable().default(null),
  links: z.array(link).max(100),
});
const contactSchema = fields.extend({ id: z.uuid() });
export const recordContactSchema = fields.extend({
  request_id: z.uuid(),
  id: z.uuid().optional(),
});
export const searchContactsSchema = z.object({
  query: z.string().trim().max(300).optional(),
  role: role.optional(),
  member_id: targetId.optional(),
  activity_id: targetId.optional(),
});
const columns = `c.id::text, c.name, c.role, c.organisation, c.phone, c.email, c.address, c.notes,
  coalesce((select jsonb_agg(case when l.member_id is not null
    then jsonb_build_object('kind', 'member', 'id', l.member_id::text)
    else jsonb_build_object('kind', 'activity', 'id', l.activity_id::text) end
    order by l.member_id nulls last, l.activity_id)
    from contact_links l where l.contact_id = c.id), '[]'::jsonb) as links`;

export async function searchContacts(db: Database, input: z.input<typeof searchContactsSchema> = {}) {
  const value = searchContactsSchema.parse(input);
  const { rows } = await db.query(
    `select ${columns} from contacts c
    where ($1::text is null or strpos(lower(c.name), lower($1)) > 0
      or strpos(lower(coalesce(c.organisation, '')), lower($1)) > 0 or strpos(c.role, lower($1)) > 0)
    and ($2::text is null or c.role = $2)
    and ($3::bigint is null or exists (select 1 from contact_links where contact_id = c.id and member_id = $3))
    and ($4::bigint is null or exists (select 1 from contact_links where contact_id = c.id and activity_id = $4))
    order by lower(c.name), c.id`,
    [value.query ?? null, value.role ?? null, value.member_id ?? null, value.activity_id ?? null],
  );
  return z.array(contactSchema).parse(rows);
}

export async function recordContact(db: Database, input: unknown) {
  const value = recordContactSchema.parse(input);
  const pooled = db instanceof pg.Pool ? await db.connect() : undefined;
  const client = pooled ?? db;
  try {
    await client.query("begin");
    const claim = await client.query(
      "insert into contact_requests (request_id, result) values ($1, '{}') on conflict do nothing returning request_id",
      [value.request_id],
    );
    if (!claim.rows.length) {
      const stored = await client.query("select result from contact_requests where request_id = $1", [
        value.request_id,
      ]);
      const contact = contactSchema.parse(stored.rows[0]?.result);
      await client.query("commit");
      return { contact, already_existed: true };
    }
    for (const target of value.links) {
      if (target.kind === "member") {
        const member = await client.query("select species from members where id = $1 for share", [target.id]);
        if (!member.rows.length) throw new InputError(`Member ${target.id} not found.`);
        if (member.rows[0].species !== "human" && value.role !== "vet")
          throw new InputError("Only vet contacts can link to non-human members.");
      } else {
        const activity = await client.query("select id from activities where id = $1 for share", [target.id]);
        if (!activity.rows.length) throw new InputError(`Activity ${target.id} not found.`);
      }
    }
    const values = [value.name, value.role, value.organisation, value.phone, value.email, value.address, value.notes];
    const saved = value.id
      ? await client.query(
          `update contacts set name=$1, role=$2, organisation=$3, phone=$4, email=$5, address=$6, notes=$7 where id=$8 returning id::text`,
          [...values, value.id],
        )
      : await client.query(
          `insert into contacts (name,role,organisation,phone,email,address,notes) values ($1,$2,$3,$4,$5,$6,$7) returning id::text`,
          values,
        );
    const id = z.uuid().optional().parse(saved.rows[0]?.id);
    if (!id) throw new InputError(`Contact ${value.id} not found.`);
    await client.query("delete from contact_links where contact_id = $1", [id]);
    for (const target of value.links)
      await client.query(
        "insert into contact_links (contact_id, member_id, activity_id) values ($1,$2,$3) on conflict do nothing",
        [id, target.kind === "member" ? target.id : null, target.kind === "activity" ? target.id : null],
      );
    const contact = contactSchema.parse(
      (await client.query(`select ${columns} from contacts c where c.id = $1`, [id])).rows[0],
    );
    await client.query("update contact_requests set result = $2 where request_id = $1", [value.request_id, contact]);
    await client.query("commit");
    return { contact, already_existed: false };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    pooled?.release();
  }
}
