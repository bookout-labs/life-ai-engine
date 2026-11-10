import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { schedule } from "./schedule.ts";
import { addWeeklySessions, previewWeeklySessions, recordWeeklyPattern } from "./weekly-patterns.ts";

test("weekly sessions preserve local times and converge across retries", {
  skip: !process.env.WEEKLY_TEST_DATABASE_URL,
}, async (t) => {
  const db = new pg.Client({ connectionString: process.env.WEEKLY_TEST_DATABASE_URL });
  await db.connect();
  const namespace = `weekly_${randomUUID().replaceAll("-", "")}`;
  try {
    await db.query(`create schema ${namespace}`);
    await db.query(`set search_path to ${namespace}`);
    for (const name of (await readdir(new URL("../../db/migrations/", import.meta.url))).sort()) {
      const sql = await readFile(new URL(`../../db/migrations/${name}`, import.meta.url), "utf8");
      await db.query(sql.split("-- migrate:down")[0] ?? "");
    }
    const member = (await db.query("insert into members (first_name) values ('Synthetic') returning id::text")).rows[0]
      .id;
    const activity = (
      await db.query(
        "insert into activities (member_id, activity, season_start, season_end) values ($1, 'synthetic class', '2040-01-01', '2040-12-31') returning id::text",
        [member],
      )
    ).rows[0].id;
    const ids: string[] = [];
    for (const weekday of [1, 2, 4]) {
      const result = await recordWeeklyPattern(db, {
        request_id: randomUUID(),
        command: {
          action: "record",
          activity_id: activity,
          weekday,
          local_start: "18:00",
          duration_minutes: 60,
          kind: "practice",
          active_from: "2040-01-01",
          active_until: "2040-12-31",
        },
      });
      ids.push(result.pattern.id);
    }
    for (const [week_start, expected] of [
      ["2040-03-05", "2040-03-06T00:00:00.000Z"],
      ["2040-03-12", "2040-03-12T23:00:00.000Z"],
      ["2040-10-29", "2040-10-29T23:00:00.000Z"],
      ["2040-11-05", "2040-11-06T00:00:00.000Z"],
    ]) {
      const preview = await previewWeeklySessions(db, { week_start });
      assert.equal(preview.length, 3);
      assert.equal(preview[0]?.starts_at, expected);
      const input = { request_id: randomUUID(), week_start };
      assert.equal((await addWeeklySessions(db, input)).created, 3);
      assert.equal((await addWeeklySessions(db, input)).already_existed, true);
      assert.equal((await addWeeklySessions(db, { ...input, request_id: randomUUID() })).created, 0);
      assert.deepEqual(
        (await schedule(db, week_start)).map((event) => event.time),
        ["6:00 pm–7:00 pm", "6:00 pm–7:00 pm", "6:00 pm–7:00 pm"],
      );
    }
    await t.test("skips persist and cancel existing generated events", async () => {
      const week_start = "2040-04-02";
      const preview = await previewWeeklySessions(db, { week_start });
      const first = preview[0];
      assert.ok(first);
      const skipped = [{ pattern_id: first.pattern_id, local_date: first.local_date }];
      const input = { request_id: randomUUID(), week_start, skipped };
      assert.deepEqual(await addWeeklySessions(db, input), { created: 2, skipped: 1, already_existed: false });
      assert.equal((await addWeeklySessions(db, { request_id: randomUUID(), week_start })).created, 0);
      assert.equal((await schedule(db, week_start)).length, 2);
      assert.equal((await previewWeeklySessions(db, { week_start }))[0]?.status, "skipped");
      const second = preview[1];
      assert.ok(second);
      await addWeeklySessions(db, {
        request_id: randomUUID(),
        week_start,
        skipped: [{ pattern_id: second.pattern_id, local_date: second.local_date }],
      });
      assert.equal((await schedule(db, week_start)).length, 1);
      const state = await previewWeeklySessions(db, { week_start });
      assert.equal(state[1]?.status, "skipped");
      assert.ok(state[1]?.event_id);
      assert.deepEqual(await addWeeklySessions(db, { ...input, skipped: [] }), {
        created: 2,
        skipped: 1,
        already_existed: true,
      });
    });
    await t.test("pattern and season ends stop occurrences midweek", async () => {
      const pattern_id = ids[2];
      assert.ok(pattern_id);
      const end = { request_id: randomUUID(), command: { action: "end", pattern_id, active_until: "2040-05-02" } };
      await recordWeeklyPattern(db, end);
      assert.equal((await recordWeeklyPattern(db, end)).already_existed, true);
      assert.equal((await previewWeeklySessions(db, { week_start: "2040-04-30" })).length, 2);
      await db.query("update activities set season_end = '2040-06-05' where id = $1", [activity]);
      assert.equal((await addWeeklySessions(db, { request_id: randomUUID(), week_start: "2040-06-04" })).created, 2);
      assert.equal((await previewWeeklySessions(db, { week_start: "2040-06-11" })).length, 0);
      await db.query("update activities set season_end = '2040-12-31' where id = $1", [activity]);
    });
    await t.test("caller errors are specific and a rejected week writes nothing", async () => {
      await assert.rejects(previewWeeklySessions(db, { week_start: "2040-04-03" }), {
        message: "Week start must be a Monday.",
      });
      await assert.rejects(addWeeklySessions(db, { request_id: randomUUID(), week_start: "2040-04-03" }), {
        message: "Week start must be a Monday.",
      });
      await assert.rejects(
        recordWeeklyPattern(db, {
          request_id: randomUUID(),
          command: { action: "end", pattern_id: "999999", active_until: "2040-05-01" },
        }),
        { message: "Pattern 999999 not found." },
      );
      await assert.rejects(
        addWeeklySessions(db, {
          request_id: randomUUID(),
          week_start: "2040-04-09",
          skipped: [{ pattern_id: "999999", local_date: "2040-04-09" }],
        }),
        { message: "Pattern 999999 not found." },
      );
      await assert.rejects(
        addWeeklySessions(db, {
          request_id: randomUUID(),
          week_start: "2040-04-09",
          skipped: [{ pattern_id: ids[0], local_date: "2040-04-16" }],
        }),
        { message: "Skipped date must be an occurrence in this week within the pattern window and activity season." },
      );
      assert.equal((await schedule(db, "2040-04-09")).length, 0);
      const command = {
        action: "record",
        activity_id: "999999",
        weekday: 1,
        local_start: "18:00",
        duration_minutes: 60,
        kind: "practice",
        active_from: "2040-01-01",
        active_until: "2040-12-31",
      };
      await assert.rejects(recordWeeklyPattern(db, { request_id: randomUUID(), command }), {
        message: "Activity 999999 not found.",
      });
      await assert.rejects(
        recordWeeklyPattern(db, {
          request_id: randomUUID(),
          command: { ...command, activity_id: activity, active_until: "2041-01-01" },
        }),
        { message: "Pattern dates must be within the activity season." },
      );
      await assert.rejects(
        recordWeeklyPattern(db, {
          request_id: randomUUID(),
          command: { ...command, activity_id: activity, active_until: "2039-01-01" },
        }),
        { message: "Pattern end must be on or after its start." },
      );
    });
    await t.test("concurrent requests converge using a pool", async () => {
      const url = new URL(process.env.WEEKLY_TEST_DATABASE_URL ?? "");
      url.searchParams.set("options", `-c search_path=${namespace}`);
      const pool = new pg.Pool({ connectionString: url.toString() });
      try {
        const input = { request_id: randomUUID(), week_start: "2040-07-02" };
        const results = await Promise.all([
          addWeeklySessions(pool, input),
          addWeeklySessions(pool, input),
          addWeeklySessions(pool, { ...input, request_id: randomUUID() }),
        ]);
        assert.equal(results.filter((r) => r.already_existed).length, 1);
        assert.equal(
          results.filter((r) => !r.already_existed).reduce((sum, r) => sum + r.created, 0),
          2,
        );
        assert.equal((await schedule(pool, input.week_start)).length, 2);
      } finally {
        await pool.end();
      }
    });
    await t.test("an existing event conflict rolls back the whole request", async () => {
      const input = { request_id: randomUUID(), week_start: "2040-08-06" };
      const sessions = await previewWeeklySessions(db, input);
      const occupied = sessions[1];
      assert.ok(occupied);
      const event = (
        await db.query(
          "insert into events (activity_id, kind, starts_at) values ($1, 'lesson', $2) returning id::text",
          [activity, occupied.starts_at],
        )
      ).rows[0].id;
      await assert.rejects(addWeeklySessions(db, input), /Resolve the conflict before adding sessions/);
      assert.deepEqual(
        (await previewWeeklySessions(db, input)).map((s) => s.status),
        ["pending", "pending"],
      );
      assert.equal((await schedule(db, input.week_start)).length, 1);
      await db.query("delete from events where id = $1", [event]);
      assert.equal((await addWeeklySessions(db, input)).created, 2);
    });
    await t.test("database constraints reject invalid pattern bounds", async () => {
      for (const patch of [
        "weekday = 0",
        "weekday = 8",
        "active_until = '2039-01-01'",
        "active_from = '1899-01-01'",
        "active_until = '2201-01-01'",
        "duration_minutes = 0",
        "kind = 'cancelled'",
      ]) {
        await assert.rejects(db.query(`update weekly_patterns set ${patch} where id = $1`, [ids[0]]), {
          code: "23514",
        });
      }
    });
    await t.test("MCP returns the actionable pattern and Monday errors", async () => {
      const { registerHooks } = await import("node:module");
      const { createMcpHandler } = await import("@modelcontextprotocol/server");
      const hooks = registerHooks({
        resolve(specifier, context, nextResolve) {
          if (specifier === "cloudflare:workers")
            return {
              url: 'data:text/javascript,export const env = {PUBLIC_ORIGIN: "https://synthetic.test"}; export class WorkerEntrypoint {}',
              shortCircuit: true,
            };
          return nextResolve(specifier, context);
        },
      });
      const { tools } = await import(new URL("../../apps/mcp/worker.ts", import.meta.url).href);
      hooks.deregister();
      const url = new URL(process.env.WEEKLY_TEST_DATABASE_URL ?? "");
      url.searchParams.set("options", `-c search_path=${namespace}`);
      const call = async (name: string, args: unknown) => {
        const response = await createMcpHandler(() =>
          tools({ HYPERDRIVE: { connectionString: url.toString() } } as never),
        ).fetch(
          new Request("https://synthetic.test/mcp", {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
          }),
        );
        const text = await response.text();
        return JSON.parse(text.startsWith("{") ? text : (text.match(/^data: (.*)$/m)?.[1] ?? "")).result;
      };
      const missing = await call("record_weekly_pattern", {
        request_id: randomUUID(),
        command: { action: "end", pattern_id: "999999", active_until: "2040-05-01" },
      });
      assert.equal(missing.isError, true);
      assert.equal(missing.content[0].text, "Pattern 999999 not found.");
      const badWeek = await call("preview_weekly_sessions", { week_start: "2040-04-03" });
      assert.equal(badWeek.isError, true);
      assert.equal(badWeek.content[0].text, "Week start must be a Monday.");
    });
    const migration = await readFile(
      new URL("../../db/migrations/20261111030000_weekly_patterns.sql", import.meta.url),
      "utf8",
    );
    const [up, down] = migration.split("-- migrate:down");
    assert.ok(up && down);
    await db.query(down);
    await db.query(up);
    await db.query(down);
  } finally {
    await db.query(`drop schema ${namespace} cascade`);
    await db.end();
  }
});
