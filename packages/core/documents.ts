import pg from "pg";
import { z } from "zod";
import { today } from "./schedule.ts";

type Database = pg.ClientBase | pg.Pool;
const date = z.iso.date().refine((value) => value >= "1900-01-01" && value <= "2200-12-31");
const memberId = z
  .string()
  .regex(/^[1-9]\d{0,18}$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
const rules = [
  { kind: "will", needs: "adult", window: 60 },
  { kind: "durable_power_of_attorney", needs: "adult", window: 60 },
  { kind: "healthcare_directive", needs: "adult", window: 60 },
  { kind: "life_insurance", needs: "adult", window: 60 },
  { kind: "guardianship", needs: "household_with_minor", window: 60 },
  { kind: "birth_certificate", needs: "human", window: 60 },
  { kind: "social_security_card", needs: "human", window: 60 },
  { kind: "passport", needs: "optional", window: 180 },
] as const satisfies readonly {
  kind: string;
  needs: "adult" | "household_with_minor" | "human" | "optional";
  window: number;
}[];
const kind = z.enum(rules.map((rule) => rule.kind));
export const documentsCheckSchema = z.object({ as_of: date.optional() });
export const recordDocumentSchema = z.object({
  request_id: z.uuid().describe("Generate once per write and reuse on retries."),
  kind,
  member_id: memberId.nullish().describe("Null or omitted covers the household."),
  location: z.string().trim().min(1).max(2000).nullish().describe("Null or omitted means unknown."),
  file_key: z.string().min(1).nullish(),
  expires_on: date.nullish(),
  reviewed_on: date.nullish(),
  notes: z.string().max(4000).nullish(),
});
const documentSchema = recordDocumentSchema.omit({ request_id: true }).required().extend({
  id: z.uuid(),
  member_id: memberId.nullable(),
  location: z.string().nullable(),
  file_key: z.string().nullable(),
  expires_on: date.nullable(),
  reviewed_on: date.nullable(),
  notes: z.string().nullable(),
});
const columns = "id::text, kind, member_id::text, location, file_key, expires_on::text, reviewed_on::text, notes";

export async function recordDocument(db: Database, input: z.input<typeof recordDocumentSchema>) {
  const value = recordDocumentSchema.parse(input);
  const pooled = db instanceof pg.Pool ? await db.connect() : undefined;
  const client = pooled ?? db;
  try {
    await client.query("begin");
    const claim = await client.query(
      "insert into document_requests (request_id, result) values ($1, '{}') on conflict do nothing returning request_id",
      [value.request_id],
    );
    if (!claim.rows.length) {
      const stored = await client.query("select result from document_requests where request_id = $1", [
        value.request_id,
      ]);
      const document = documentSchema.parse(stored.rows[0]?.result);
      await client.query("commit");
      return { document, already_existed: true };
    }
    const { rows } = await client.query(
      `insert into documents (kind, member_id, location, file_key, expires_on, reviewed_on, notes)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (kind, member_id) do update set location = excluded.location, file_key = excluded.file_key,
         expires_on = excluded.expires_on, reviewed_on = excluded.reviewed_on, notes = excluded.notes
       returning ${columns}`,
      [
        value.kind,
        value.member_id ?? null,
        value.location ?? null,
        value.file_key ?? null,
        value.expires_on ?? null,
        value.reviewed_on ?? null,
        value.notes ?? null,
      ],
    );
    const document = documentSchema.parse(rows[0]);
    await client.query("update document_requests set result = $2 where request_id = $1", [value.request_id, document]);
    await client.query("commit");
    return { document, already_existed: false };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    pooled?.release();
  }
}

const memberSchema = z.object({
  id: memberId,
  name: z.string(),
  born: z.iso.date().nullable(),
  adult: z.boolean().nullable(),
});
const rank = { missing: 0, expired: 0, expiring: 1, location_unknown: 2, met: 3 };
type Status = keyof typeof rank;
type Requirement = {
  kind: z.infer<typeof kind>;
  member_id: string | null;
  status: Status;
  days: number | null;
  location_unknown: boolean;
  document: z.infer<typeof documentSchema> | null;
};

function assess(
  document: z.infer<typeof documentSchema> | null,
  as_of: string,
  window: number,
): Pick<Requirement, "status" | "days" | "location_unknown"> {
  const days = document?.expires_on
    ? Math.round((Date.parse(document.expires_on) - Date.parse(as_of)) / 86400000)
    : null;
  const location_unknown = document !== null && document.location === null;
  const status: Status = !document
    ? "missing"
    : days !== null && days < 0
      ? "expired"
      : days !== null && days <= window
        ? "expiring"
        : location_unknown
          ? "location_unknown"
          : "met";
  return { status, days, location_unknown };
}

export async function documentsCheck(db: Database, input: z.input<typeof documentsCheckSchema> = {}) {
  const { as_of = today() } = documentsCheckSchema.parse(input);
  const members = z.array(memberSchema).parse(
    (
      await db.query(
        `select id::text, coalesce(goes_by, first_name) as name, born::text,
      (born + interval '18 years')::date <= $1::date as adult
     from members where species = 'human' order by members.id`,
        [as_of],
      )
    ).rows,
  );
  const documents = z
    .array(documentSchema)
    .parse((await db.query(`select ${columns} from documents order by kind, documents.member_id nulls first`)).rows);
  const requirements: Requirement[] = [];
  for (const rule of rules) {
    const targets =
      rule.needs === "household_with_minor"
        ? members.some((member) => member.adult === false)
          ? [null]
          : []
        : rule.needs === "optional"
          ? documents
              .filter(
                (doc) =>
                  doc.kind === rule.kind &&
                  (doc.member_id === null || members.some((member) => member.id === doc.member_id)),
              )
              .map((doc) => doc.member_id)
          : members.filter((member) => rule.needs === "human" || member.adult === true).map((member) => member.id);
    for (const member_id of targets) {
      const document =
        documents.find((doc) => doc.kind === rule.kind && doc.member_id === member_id) ??
        documents.find((doc) => doc.kind === rule.kind && doc.member_id === null) ??
        null;
      requirements.push({ kind: rule.kind, member_id, document, ...assess(document, as_of, rule.window) });
    }
  }
  requirements.sort((a, b) => rank[a.status] - rank[b.status]);
  const counts = { missing: 0, expired: 0, expiring: 0, location_unknown: 0, met: 0 };
  for (const requirement of requirements) counts[requirement.status]++;
  return {
    as_of,
    members,
    age_unknown: members.filter((member) => member.adult === null),
    requirements,
    counts,
    documents: rules.flatMap((rule) =>
      documents
        .filter((document) => document.kind === rule.kind)
        .map((document) => ({
          ...document,
          ...assess(document, as_of, rule.window),
        })),
    ),
  };
}
