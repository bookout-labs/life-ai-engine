import * as z from "zod";
import { today } from "./schedule.ts";
import { type Workout, workoutsInRange } from "./workouts.ts";

export const trainingTrendSchema = z.object({
  asOf: z.iso.date().optional(),
  weeks: z.number().int().min(1).max(52).optional(),
});

type Totals = {
  sessions: number;
  duration_seconds: number | null;
  volume_kg: number | null;
  blocks: number;
  timed_blocks: number;
  loaded_blocks: number;
};
type TrainingWeek = Totals & { week: string; partial: boolean; by_kind: Record<string, Totals> };
type Evidence = { reason: string; evidence_weeks: string[] };
type TrainingFlag = Evidence &
  (
    | { kind: "load_spike"; metric: "duration_seconds" | "volume_kg"; value: number; baseline: number }
    | { kind: "no_rest"; consecutive_days: number; from: string; through: string }
    | { kind: "sharp_drop"; sessions: number; baseline: number }
  );
type TrainingTrend = { as_of: string; weeks: TrainingWeek[]; flags: TrainingFlag[] };
type Options = { asOf: string; weeks: number };

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function monday(day: string): string {
  return addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));
}

function totals(): Totals {
  return { sessions: 0, duration_seconds: null, volume_kg: null, blocks: 0, timed_blocks: 0, loaded_blocks: 0 };
}

export function summarizeTraining(sessions: readonly Workout[], { asOf, weeks }: Options): TrainingTrend {
  const current = monday(asOf);
  const rows: TrainingWeek[] = Array.from({ length: weeks }, (_, i) => ({
    ...totals(),
    week: addDays(current, (i - weeks + 1) * 7),
    partial: i === weeks - 1,
    by_kind: {},
  }));
  const byWeek = new Map(rows.map((w) => [w.week, w]));
  const days = new Set<string>();
  for (const session of sessions) {
    if (session.performed_on > asOf) continue;
    if (session.performed_on >= addDays(current, -(weeks - 1) * 7 - 6)) days.add(session.performed_on);
    const row = byWeek.get(monday(session.performed_on));
    if (!row) continue;
    const kind = (Object.hasOwn(row.by_kind, session.kind) && row.by_kind[session.kind]) || totals();
    row.by_kind = { ...row.by_kind, [session.kind]: kind };
    for (const target of [row, kind]) {
      target.sessions++;
      target.blocks += session.blocks.length;
      for (const block of session.blocks) {
        if (block.duration_seconds !== null) {
          target.duration_seconds = (target.duration_seconds ?? 0) + block.duration_seconds;
          target.timed_blocks++;
        }
        if (block.weight !== null && block.weight_unit !== null && block.sets !== null && block.reps !== null) {
          target.volume_kg =
            (target.volume_kg ?? 0) +
            Number(block.weight) * block.sets * block.reps * (block.weight_unit === "lb" ? 0.45359237 : 1);
          target.loaded_blocks++;
        }
      }
    }
  }
  const flags = rules.flatMap((rule) => rule.evaluate(rows, [...days].sort()));
  const round = (value: number) => Math.round(value * 100) / 100;
  for (const row of rows) {
    for (const target of [row, ...Object.values(row.by_kind)]) {
      if (target.volume_kg !== null) target.volume_kg = round(target.volume_kg);
    }
  }
  for (const flag of flags) {
    if (flag.kind === "load_spike" && flag.metric === "volume_kg") {
      flag.value = round(flag.value);
      flag.baseline = round(flag.baseline);
    }
  }
  return { as_of: asOf, weeks: rows, flags };
}

const rules = [
  {
    baselineWeeks: 3,
    ratio: 1.5,
    evaluate(rows: TrainingWeek[]): TrainingFlag[] {
      return rows.flatMap((row, index) => {
        const prior = rows.slice(index - this.baselineWeeks, index);
        if (row.partial || index < this.baselineWeeks) return [];
        return (["duration_seconds", "volume_kg"] as const).flatMap((metric): TrainingFlag[] => {
          if (!prior.every((w) => (w[metric] ?? 0) > 0)) return [];
          const baseline = prior.reduce((sum, w) => sum + (w[metric] ?? 0), 0) / this.baselineWeeks;
          const value = row[metric] ?? 0;
          return value > baseline * this.ratio
            ? [
                {
                  kind: "load_spike",
                  metric,
                  value,
                  baseline,
                  reason: `Logged ${metric} exceeds 150% of the preceding three complete weeks' average. Missing blocks can affect this comparison.`,
                  evidence_weeks: [...prior.map((w) => w.week), row.week],
                },
              ]
            : [];
        });
      });
    },
  },
  {
    minimumDays: 7,
    evaluate(_rows: TrainingWeek[], days: string[]): TrainingFlag[] {
      const flags: TrainingFlag[] = [];
      let run: string[] = [];
      const finish = () => {
        const from = run[0];
        const through = run.at(-1);
        if (from && through && run.length >= this.minimumDays)
          flags.push({
            kind: "no_rest",
            consecutive_days: run.length,
            from,
            through,
            reason:
              "At least seven consecutive days have logged sessions of any kind. Session intensity and unlogged rest are unknown.",
            evidence_weeks: [...new Set(run.map(monday))],
          });
      };
      for (const day of days) {
        const previous = run.at(-1);
        if (previous && addDays(previous, 1) !== day) {
          finish();
          run = [];
        }
        run.push(day);
      }
      finish();
      return flags;
    },
  },
  {
    baselineWeeks: 3,
    minimumSessions: 2,
    ratio: 0.5,
    evaluate(rows: TrainingWeek[]): TrainingFlag[] {
      return rows.flatMap((row, index): TrainingFlag[] => {
        const prior = rows.slice(index - this.baselineWeeks, index);
        if (row.partial || index < this.baselineWeeks || !prior.every((w) => w.sessions >= this.minimumSessions))
          return [];
        const baseline = prior.reduce((sum, w) => sum + w.sessions, 0) / this.baselineWeeks;
        return row.sessions <= baseline * this.ratio
          ? [
              {
                kind: "sharp_drop",
                sessions: row.sessions,
                baseline,
                reason:
                  "Logged sessions fell to at most half the preceding three complete weeks' average, each with at least two sessions. A logging gap or planned recovery can also explain this.",
                evidence_weeks: [...prior.map((w) => w.week), row.week],
              },
            ]
          : [];
      });
    },
  },
];

export async function trainingTrend(
  db: Parameters<typeof workoutsInRange>[0],
  input: z.infer<typeof trainingTrendSchema> = {},
): Promise<TrainingTrend> {
  const { asOf = today(), weeks = 8 } = trainingTrendSchema.parse(input);
  const from = addDays(monday(asOf), -(weeks - 1) * 7 - 6);
  return summarizeTraining(await workoutsInRange(db, from, asOf), { asOf, weeks });
}
