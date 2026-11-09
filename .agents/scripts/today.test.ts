import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildToday } from "../../packages/core/today.ts";
import { runToday } from "./today.ts";

const empty = {
  now: "2026-01-02T05:59:59Z",
  members: [],
  events: [],
  bills: [],
  deadlines: [],
  pages: [],
};

test("no commitments or context produces an explicit empty daily snapshot", () => {
  assert.deepEqual(buildToday(empty), {
    date: "2026-01-01",
    dailySlug: "daily/2026-01-01",
    windows: { events: 7, bills: 7, deadlines: 14 },
    members: [],
    events: [],
    bills: [],
    deadlines: [],
    context: [],
    previousDaily: null,
    currentDaily: null,
  });
});

test("fixture CLI preserves existing commitments, estimates and overdue deadlines", async () => {
  const fixture = {
    ...empty,
    members: [{ name: "Example", species: "human", born: null }],
    events: [{ day: "Thu Jan 01", time: "9:00 am", who: "Example", what: "Appointment", location: null }],
    bills: [
      {
        day: "Fri Jan 02",
        name: "Example bill",
        amount: "12.50",
        amount_is_estimate: true,
        day_is_estimate: true,
        pays_from: null,
      },
    ],
    deadlines: [{ due_on: "Wed Dec 31", item: "Example deadline", action: "Submit form", overdue: true }],
  };
  const result = JSON.parse(await runToday(["--fixture", "fixture.json"], async () => JSON.stringify(fixture)));
  assert.deepEqual(result.events, fixture.events);
  assert.deepEqual(result.bills, fixture.bills);
  assert.deepEqual(result.deadlines, fixture.deadlines);
  assert.deepEqual(result.members, fixture.members);
});

test("Chicago midnight and daylight saving boundaries choose the correct daily date", () => {
  for (const [now, date] of [
    ["2026-01-02T05:59:59Z", "2026-01-01"],
    ["2026-01-02T06:00:00Z", "2026-01-02"],
    ["2026-03-08T07:59:59Z", "2026-03-08"],
    ["2026-03-08T08:00:00Z", "2026-03-08"],
    ["2026-07-02T04:59:59Z", "2026-07-01"],
    ["2026-07-02T05:00:00Z", "2026-07-02"],
  ]) {
    const result = buildToday({ ...empty, now });
    assert.equal(result.date, date);
    assert.equal(result.dailySlug, `daily/${date}`);
  }
});

test("latest earlier daily survives gaps and current or future pages cannot become prior context", () => {
  const page = (slug: string, type = "daily") => ({ slug, type, body: `Synthetic ${slug}` });
  const result = buildToday({
    ...empty,
    pages: [
      page("daily/2026-01-03"),
      page("daily/2025-12-28"),
      page("daily/2026-01-01"),
      page("daily/2025-12-30"),
      page("daily/notes"),
      page("areas/example", "area"),
      page("people/example", "person"),
      page("projects/example", "project"),
      page("topics/example", "topic"),
    ],
  });
  assert.deepEqual(result.previousDaily, page("daily/2025-12-30"));
  assert.deepEqual(result.currentDaily, page("daily/2026-01-01"));
  assert.deepEqual(result.context, [
    page("areas/example", "area"),
    page("people/example", "person"),
    page("projects/example", "project"),
  ]);
  assert.equal(buildToday({ ...empty, pages: [page("daily/2026-01-03")] }).previousDaily, null);
});

test("fixture contract rejects incomplete data and invalid clocks instead of claiming no commitments", async () => {
  assert.throws(() => buildToday({ now: empty.now }));
  assert.throws(() => buildToday({ ...empty, now: "2026-02-30T00:00:00Z" }));
  assert.throws(() => buildToday({ ...empty, events: [{ what: "Incomplete" }] }));
  await assert.rejects(runToday(["--fixture", "fixture.json", "--now", empty.now]));
  await assert.rejects(runToday(["--write"]));
});

test("documented fixture command runs without database configuration and repeats identical output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "today-fixture-"));
  try {
    const file = join(dir, "input.json");
    await writeFile(file, JSON.stringify(empty));
    const run = () =>
      execFileSync(process.execPath, [new URL("./today.ts", import.meta.url).pathname, "--fixture", file], {
        cwd: dir,
        env: { PATH: process.env.PATH ?? "" },
        encoding: "utf8",
      });
    const first = run();
    assert.equal(JSON.parse(first).dailySlug, "daily/2026-01-01");
    assert.equal(run(), first);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
