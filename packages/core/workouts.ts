import type pg from "pg";

type WorkoutBlock = {
  position: number;
  name: string;
  sets: number | null;
  reps: number | null;
  weight: string | null;
  weight_unit: "lb" | "kg" | null;
  duration_seconds: number | null;
  notes: string | null;
};

export type Workout = {
  id: string;
  performed_on: string;
  kind: string;
  notes: string | null;
  blocks: WorkoutBlock[];
};

type Database = pg.ClientBase | pg.Pool;

async function readWorkouts(
  db: Database,
  condition: string,
  values: (string | number)[],
  limit = "",
): Promise<Workout[]> {
  const { rows } = await db.query<Workout>(
    `select w.id::text, w.performed_on::text, w.kind, w.notes,
            coalesce(json_agg(json_build_object(
              'position', b.position, 'name', b.name, 'sets', b.sets, 'reps', b.reps,
              'weight', b.weight::text, 'weight_unit', b.weight_unit,
              'duration_seconds', b.duration_seconds, 'notes', b.notes
            ) order by b.position) filter (where b.id is not null), '[]'::json) as blocks
       from workouts w left join workout_blocks b on b.workout_id = w.id
       ${condition}
      group by w.id
      order by w.performed_on desc, w.id desc ${limit}`,
    values,
  );
  return rows;
}

export function workoutsInRange(db: Database, from: string, through: string): Promise<Workout[]> {
  return readWorkouts(db, "where w.performed_on between $1::date and $2::date", [from, through]);
}

export function recentWorkouts(db: Database, limit: number): Promise<Workout[]> {
  return readWorkouts(db, "", [limit], "limit $1");
}
