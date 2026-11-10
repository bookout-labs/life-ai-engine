import assert from "node:assert/strict";
import test from "node:test";
import { computeCommissionSplit } from "./commission-split.ts";

test("percent allocations round down and the remainder absorbs pennies", () => {
  const rules = [
    { bucket: "Reserve", kind: "percent", basis_points: 2500 },
    { bucket: "Residual", kind: "remainder" },
  ];
  for (const [gross, expected] of [
    [1, [0, 1]],
    [3, [0, 3]],
    [123457, [30864, 92593]],
  ] satisfies [number, number[]][]) {
    const result = computeCommissionSplit({ gross_cents: gross, on: "2040-01-01" }, rules);
    assert.deepEqual(
      result.buckets.map((b) => b.amount_cents),
      expected,
    );
    assert.equal(result.total_cents, gross);
    assert.equal(
      result.buckets.reduce((sum, b) => sum + b.amount_cents, 0),
      gross,
    );
    assert.deepEqual(computeCommissionSplit({ gross_cents: gross, on: "2040-01-01" }, rules), result);
  }
});

test("ordered fixed rules stop at available gross", () => {
  const rules = [
    { bucket: "First", kind: "fixed", amount_cents: 80 },
    { bucket: "Second", kind: "fixed", amount_cents: 60 },
    { bucket: "Rest", kind: "remainder" },
  ];
  const result = computeCommissionSplit({ gross_cents: 100, on: "2040-01-01" }, rules);
  assert.deepEqual(
    result.buckets.map((b) => b.amount_cents),
    [80, 20, 0],
  );
  assert.match(result.buckets[1]?.reason ?? "", /limited/);
  assert.deepEqual(
    computeCommissionSplit({ gross_cents: 30, on: "2040-01-01" }, rules).buckets.map((b) => b.amount_cents),
    [30, 0, 0],
  );
  assert.deepEqual(
    computeCommissionSplit({ gross_cents: 100, on: "2040-01-01" }, [
      { bucket: "Fixed", kind: "fixed", amount_cents: 10 },
      { bucket: "P", kind: "percent", basis_points: 2500 },
      { bucket: "Q", kind: "percent", basis_points: 2500 },
      { bucket: "Rest", kind: "remainder" },
    ]).buckets.map((b) => b.amount_cents),
    [10, 25, 25, 40],
  );
});

test("fill rules honor the gap, cap, remaining gross and dated balances", () => {
  const rules = [
    { bucket: "Buffer", kind: "fill", target_cents: 1000, cap_cents: 300 },
    { bucket: "Rest", kind: "remainder" },
  ];
  for (const [balance, gross, expected] of [
    [900, 500, [100, 400]],
    [200, 500, [300, 200]],
    [200, 50, [50, 0]],
    [1200, 50, [0, 50]],
  ] satisfies [number, number, number[]][]) {
    const result = computeCommissionSplit(
      {
        gross_cents: gross,
        on: "2040-01-01",
        balances: [{ bucket: "Buffer", balance_cents: balance, as_of: "2040-01-01" }],
      },
      rules,
    );
    assert.deepEqual(
      result.buckets.map((b) => b.amount_cents),
      expected,
    );
  }
  for (const balances of [[], [{ bucket: "Buffer", balance_cents: 0, as_of: "2039-12-31" }]]) {
    const result = computeCommissionSplit({ gross_cents: 100, on: "2040-01-01", balances }, rules);
    assert.equal(result.status, "needs_balance");
    assert.deepEqual(result.buckets, []);
  }
});

test("empty plans explain the missing setup and zero gross stays exact", () => {
  const result = computeCommissionSplit({ gross_cents: 3, on: "2040-01-01" }, []);
  assert.equal(result.status, "no_plan");
  assert.match(result.message ?? "", /No commission split plan/);
  assert.equal(
    computeCommissionSplit({ gross_cents: 0, on: "2040-01-01" }, [{ bucket: "Rest", kind: "remainder" }]).total_cents,
    0,
  );
});

test("invalid plans and inputs are rejected through the public boundary", () => {
  const rest = { bucket: "Rest", kind: "remainder" };
  for (const rules of [
    [rest, rest],
    [{ bucket: "P", kind: "percent", basis_points: 10001 }, rest],
    [{ bucket: "P", kind: "percent", basis_points: 6000 }, { bucket: "Q", kind: "percent", basis_points: 5000 }, rest],
    [{ bucket: "F", kind: "fixed", amount_cents: -1 }, rest],
    [{ bucket: "F", kind: "fill", target_cents: 1, cap_cents: -1 }, rest],
    [rest, { bucket: "F", kind: "fixed", amount_cents: 1 }],
    [{ bucket: "F", kind: "fixed", amount_cents: 1 }],
  ])
    assert.throws(() => computeCommissionSplit({ gross_cents: 100, on: "2040-01-01" }, rules));
  for (const gross_cents of [-1, 0.1, Number.MAX_SAFE_INTEGER, Infinity])
    assert.throws(() => computeCommissionSplit({ gross_cents, on: "2040-01-01" }, [rest]));
});

test("plan revisions round-trip, retry unchanged and select by date on a disposable database", {
  skip: !process.env.COMMISSION_TEST_DATABASE_URL,
}, async () => {
  const { randomUUID } = await import("node:crypto");
  const { readFile } = await import("node:fs/promises");
  const { default: pg } = await import("pg");
  const { commissionSplit, recordCommissionPlan } = await import("./commission-split.ts");
  const db = new pg.Client({ connectionString: process.env.COMMISSION_TEST_DATABASE_URL });
  await db.connect();
  const namespace = `commission_${randomUUID().replaceAll("-", "")}`;
  const migration = await readFile(
    new URL("../../db/migrations/20261110200000_commission_plans.sql", import.meta.url),
    "utf8",
  );
  const [up, down] = migration.split("-- migrate:down");
  assert.ok(up && down);
  try {
    await db.query(`create schema ${namespace}`);
    await db.query(`set search_path to ${namespace}`);
    for (const name of [
      "20261108230000_obligations_charges_deadlines_loans",
      "20261109120000_pages_files",
      "20261110150000_accounts_budget_targets",
    ]) {
      const sql = await readFile(new URL(`../../db/migrations/${name}.sql`, import.meta.url), "utf8");
      await db.query(sql.split("-- migrate:down")[0] ?? "");
    }
    await db.query(up);
    await db.query(down);
    await db.query(up);
    await db.query("insert into pages(slug,type,title,body) values ('projects/fixture-plan','project','Fixture','')");
    const account = (
      await db.query(
        "insert into accounts(institution,name,kind,scope) values ('Fixture','Reserve','bank','household') returning id::text",
      )
    ).rows[0].id;
    const loan = (
      await db.query(
        "insert into obligations(name,kind,cadence) values ('Fixture','loan','monthly') returning id::text",
      )
    ).rows[0].id;
    await db.query("insert into loans(obligation_id,lender) values ($1,'Fixture')", [loan]);
    const input: Parameters<typeof recordCommissionPlan>[1] = {
      request_id: randomUUID(),
      effective_on: "2040-01-01",
      page_slug: "projects/fixture-plan",
      rules: [
        {
          bucket: "Reserve",
          kind: "percent",
          basis_points: 2500,
          destination: { kind: "account", id: account },
        },
        { bucket: "Debt", kind: "fixed", amount_cents: 20, destination: { kind: "loan", id: loan } },
        { bucket: "Rest", kind: "remainder" },
      ],
    };
    assert.equal((await commissionSplit(db, { gross_cents: 101, on: "2040-01-01" })).status, "no_plan");
    const first = await recordCommissionPlan(db, input);
    assert.equal(first.already_existed, false);
    assert.deepEqual(
      await recordCommissionPlan(db, {
        ...input,
        effective_on: "2041-01-01",
        rules: [{ bucket: "Rest", kind: "remainder" }],
      }),
      { plan: first.plan, already_existed: true },
    );
    const retryInput = { ...input, request_id: randomUUID(), effective_on: "2039-01-01" };
    const retry = async () => {
      const connection = new pg.Client({ connectionString: process.env.COMMISSION_TEST_DATABASE_URL });
      await connection.connect();
      try {
        await connection.query(`set search_path to ${namespace}`);
        return await recordCommissionPlan(connection, retryInput);
      } finally {
        await connection.end();
      }
    };
    const retries = await Promise.all([retry(), retry()]);
    assert.equal(retries[0]?.plan.id, retries[1]?.plan.id);
    assert.deepEqual(retries.map((r) => r.already_existed).sort(), [false, true]);
    const result = await commissionSplit(db, { gross_cents: 101, on: "2040-01-01" });
    assert.deepEqual(
      result.buckets.map((b) => b.amount_cents),
      [25, 20, 56],
    );
    assert.deepEqual(result.buckets[0]?.destination, { kind: "account", id: account });
    assert.deepEqual(result.buckets[1]?.destination, { kind: "loan", id: loan });
    assert.equal(result.total_cents, 101);
    const future = await recordCommissionPlan(db, {
      ...input,
      request_id: randomUUID(),
      effective_on: "2041-01-01",
      rules: [{ bucket: "Future", kind: "remainder" }],
    });
    assert.equal((await commissionSplit(db, { gross_cents: 101, on: "2040-01-01" })).plan?.id, first.plan?.id);
    assert.equal((await commissionSplit(db, { gross_cents: 101, on: "2041-01-01" })).plan?.id, future.plan?.id);
    const latest = await recordCommissionPlan(db, { ...input, request_id: randomUUID() });
    assert.equal((await commissionSplit(db, { gross_cents: 101, on: "2040-01-01" })).plan?.id, latest.plan?.id);
    await assert.rejects(
      recordCommissionPlan(db, {
        ...input,
        request_id: randomUUID(),
        rules: [{ bucket: "Missing", kind: "remainder", destination: { kind: "account", id: "9223372036854775807" } }],
      }),
      /not found/,
    );
    await assert.rejects(
      recordCommissionPlan(db, {
        ...input,
        request_id: randomUUID(),
        rules: [{ bucket: "Missing", kind: "remainder", destination: { kind: "loan", id: "9223372036854775807" } }],
      }),
      /not found/,
    );
    await assert.rejects(
      recordCommissionPlan(db, { ...input, request_id: randomUUID(), page_slug: "projects/missing" }),
      /not found/,
    );
    const rest = { bucket: "Rest", kind: "remainder" };
    for (const rules of [
      [],
      [rest, rest],
      [{ bucket: "P", kind: "percent", basis_points: 10001 }, rest],
      [
        { bucket: "P", kind: "percent", basis_points: 6000 },
        { bucket: "Q", kind: "percent", basis_points: 5000 },
        rest,
      ],
      [{ bucket: "F", kind: "fixed", amount_cents: -1 }, rest],
      [{ bucket: "F", kind: "fill", target_cents: 100, cap_cents: -1 }, rest],
      [{ bucket: "F", kind: "fill", target_cents: 100 }, rest],
      [{ bucket: "P", kind: "percent" }, rest],
      [{ bucket: "F", kind: "fixed", amount_cents: 1.5 }, rest],
      [{ bucket: "F", kind: "fixed", amount_cents: null }, rest],
      [rest, { bucket: "F", kind: "fixed", amount_cents: 1 }],
      [{ bucket: "P", kind: "unknown" }, rest],
      [{ ...rest, destination: { kind: null, id: "1" } }],
      [{ ...rest, destination: { kind: "account", id: "0" } }],
    ])
      await assert.rejects(
        db.query(
          "insert into commission_plans(request_id,effective_on,page_slug,rules) values ($1,'2040-01-01','projects/fixture-plan',$2)",
          [randomUUID(), JSON.stringify(rules)],
        ),
        { code: "23514" },
      );
    await db.query("delete from accounts where id = $1", [account]);
    assert.deepEqual((await commissionSplit(db, { gross_cents: 101, on: "2040-01-01" })).destinations_missing, [
      "Reserve",
    ]);
    await db.query(down);
    assert.equal((await db.query("select to_regclass('commission_plans') as name")).rows[0].name, null);
  } finally {
    await db.query(`drop schema ${namespace} cascade`);
    await db.end();
  }
});

test("integer arithmetic stays exact at the input limit", () => {
  const result = computeCommissionSplit({ gross_cents: 9_000_000_000_000, on: "2040-01-01" }, [
    { bucket: "Fraction", kind: "percent", basis_points: 3333 },
    { bucket: "Rest", kind: "remainder" },
  ]);
  assert.deepEqual(
    result.buckets.map((b) => b.amount_cents),
    [2_999_700_000_000, 6_000_300_000_000],
  );
});
