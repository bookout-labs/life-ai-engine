import pg from "pg";
import * as z from "zod";

const blockSchema = z
  .object({
    position: z.number().int().positive(),
    name: z.string().trim().min(1),
    sets: z.number().int().positive().nullish(),
    reps: z.number().int().positive().nullish(),
    weight: z
      .string()
      .regex(/^\d+(\.\d+)?$/)
      .nullish(),
    weight_unit: z.enum(["lb", "kg"]).nullish(),
    duration_seconds: z.number().int().positive().nullish(),
    notes: z.string().nullish(),
  })
  .refine((b) => (b.weight == null) === (b.weight_unit == null), "Supply weight and weight_unit together");

export const logWorkoutSchema = z.object({
  request_id: z.uuid(),
  performed_on: z.iso.date(),
  kind: z.string().trim().min(1),
  notes: z.string().nullish(),
  blocks: z
    .array(blockSchema)
    .refine(
      (blocks) => new Set(blocks.map((b) => b.position)).size === blocks.length,
      "Block positions must be unique",
    ),
});

export async function logWorkout(db: pg.ClientBase | pg.Pool, input: z.infer<typeof logWorkoutSchema>) {
  const pooled = db instanceof pg.Pool ? await db.connect() : undefined;
  const client = pooled ?? db;
  try {
    await client.query("begin");
    const { rows } = await client.query<{ id: string }>(
      `insert into workouts (request_id, performed_on, kind, notes) values ($1, $2, $3, $4)
       on conflict (request_id) do nothing returning id::text`,
      [input.request_id, input.performed_on, input.kind, input.notes ?? null],
    );
    const stored =
      rows[0] ??
      (await client.query<{ id: string }>("select id::text from workouts where request_id = $1", [input.request_id]))
        .rows[0];
    if (!stored) throw new Error("Stored workout not found");
    if (rows.length) {
      for (const block of input.blocks) {
        await client.query(
          `insert into workout_blocks (workout_id, position, name, sets, reps, weight, weight_unit, duration_seconds, notes)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            stored.id,
            block.position,
            block.name,
            block.sets ?? null,
            block.reps ?? null,
            block.weight ?? null,
            block.weight_unit ?? null,
            block.duration_seconds ?? null,
            block.notes ?? null,
          ],
        );
      }
    }
    const blocks = await client.query<{ id: string }>(
      "select id::text from workout_blocks where workout_id = $1 order by position",
      [stored.id],
    );
    await client.query("commit");
    return { id: stored.id, block_ids: blocks.rows.map((b) => b.id), already_existed: rows.length === 0 };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    pooled?.release();
  }
}
