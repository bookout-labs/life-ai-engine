import assert from "node:assert/strict";
import test from "node:test";
import { explore, type Loan, monthlyPayment, payoffExplorer, schedule } from "./amortize.ts";

const loan = (terms: Partial<Loan> & Pick<Loan, "principal" | "apr" | "termMonths">): Loan => ({
  name: "Example loan",
  firstPaymentOn: "2026-02-01",
  accrual: "monthly",
  ...terms,
  payment: terms.payment ?? monthlyPayment(terms.principal, terms.apr, terms.termMonths),
});

// Robert Foth, Topics in Mathematics (Pima Community College), 6.4 Amortized Loans, the $500 loan at 1% a month:
// https://pimaopen.pressbooks.pub/topicsinmathematics/chapter/6-4-amortized-loans/
test("reproduces the Pima six-payment table to the cent, with the last payment clearing its 0.03 residual", () => {
  const note = loan({ principal: 50_000n, apr: 12_000n, termMonths: 6 });
  assert.equal(note.payment, 8_627n);
  assert.deepEqual(
    schedule(note).map((r) => [r.payment, r.interest, r.principal, r.balance].join(" ")),
    [
      "86.27 5.00 81.27 418.73",
      "86.27 4.19 82.08 336.65",
      "86.27 3.37 82.90 253.75",
      "86.27 2.54 83.73 170.02",
      "86.27 1.70 84.57 85.45",
      "86.30 0.85 85.45 0.00",
    ],
  );
});

// OpenStax, Principles of Finance, 8.3 Loan Amortization, Table 8.5. Its later rows carry fractional cents
// between rows, so only the payment and the opening rows are comparable to a statement that rounds each month:
// https://openstax.org/books/principles-finance/pages/8-3-loan-amortization
test("matches the OpenStax 20-year mortgage payment and opening rows", () => {
  const mortgage = loan({ principal: 14_000_000n, apr: 3_600n, termMonths: 240 });
  assert.equal(mortgage.payment, 81_916n);
  const rows = schedule(mortgage).map((r) => [r.payment, r.interest, r.principal, r.balance].join(" "));
  assert.equal(rows.length, 240);
  assert.deepEqual(rows.slice(0, 9), [
    "819.16 420.00 399.16 139600.84",
    "819.16 418.80 400.36 139200.48",
    "819.16 417.60 401.56 138798.92",
    "819.16 416.40 402.76 138396.16",
    "819.16 415.19 403.97 137992.19",
    "819.16 413.98 405.18 137587.01",
    "819.16 412.76 406.40 137180.61",
    "819.16 411.54 407.62 136772.99",
    "819.16 410.32 408.84 136364.15",
  ]);
  assert.match(rows[239] ?? "", / 0\.00$/);
});

test("daily accrual charges interest for the days actually elapsed", () => {
  // 3.65% over 365 days is exactly 0.01% a day.
  const note = loan({ principal: 100_000n, apr: 3_650n, termMonths: 2, accrual: "daily" });
  assert.deepEqual(schedule(note), [
    { on: "2026-02-01", payment: "502.28", interest: "3.10", principal: "499.18", balance: "500.82" },
    { on: "2026-03-01", payment: "502.22", interest: "1.40", principal: "500.82", balance: "0.00" },
  ]);
});

const scenario = (result: ReturnType<typeof explore>, strategy: string) => {
  const found = result.loans[0]?.scenarios.find((s) => s.strategy === strategy);
  assert.ok(found, `${strategy} scenario present`);
  return found;
};

test("paying a lump sum earlier saves interest only on a daily-accrual loan", () => {
  const terms = { principal: 1_000_000n, apr: 7_300n, termMonths: 36 } as const;
  for (const [accrual, earlyCheaper] of [
    ["daily", true],
    ["monthly", false],
  ] as const) {
    const run = (on: string) =>
      scenario(explore([{ loan: loan({ ...terms, accrual }) }], { lumpSum: { on, amount: 200_000n } }), "lump_sum");
    const early = run("2026-06-11");
    const onDue = run("2026-07-01");
    assert.equal(Number(early.total_interest) < Number(onDue.total_interest), earlyCheaper, `${accrual} timing`);
    assert.ok(Number(onDue.interest_saved) > 0, `${accrual} lump sum saves interest`);
  }
});

test("biweekly finishes sooner, and its earlier half-payments count only on daily accrual", () => {
  const saved = (accrual: "daily" | "monthly") => {
    const result = explore([{ loan: loan({ principal: 2_000_000n, apr: 6_000n, termMonths: 60, accrual }) }], {});
    const biweekly = scenario(result, "biweekly");
    assert.equal(scenario(result, "baseline").payoff_on, "2031-01-01");
    assert.ok(biweekly.payoff_on < "2030-10-01", `${accrual} biweekly finishes months early`);
    return Number(biweekly.interest_saved);
  };
  const monthly = saved("monthly");
  assert.ok(monthly > 0, "the 13th payment a year saves interest on monthly accrual");
  assert.ok(saved("daily") > monthly, "half-payments between due dates save more on daily accrual");
});

test("extra monthly principal shortens the loan and saves interest", () => {
  const result = explore([{ loan: loan({ principal: 14_000_000n, apr: 3_600n, termMonths: 240 }) }], {
    extraMonthly: 10_000n,
  });
  const extra = scenario(result, "extra");
  assert.equal(scenario(result, "baseline").payments, 240);
  assert.ok(extra.payments < 240 && Number(extra.interest_saved) > 0);
});

test("avalanche targets the highest rate and snowball the smallest balance", () => {
  const small = loan({ name: "Small low-rate", principal: 300_000n, apr: 3_000n, termMonths: 60 });
  const large = loan({ name: "Large high-rate", principal: 2_000_000n, apr: 18_000n, termMonths: 60 });
  const { strategies } = explore([{ loan: small }, { loan: large }], { extraMonthly: 20_000n });
  const avalanche = strategies.find((s) => s.strategy === "avalanche");
  const snowball = strategies.find((s) => s.strategy === "snowball");
  assert.ok(avalanche && snowball);
  assert.deepEqual(
    snowball.paid_off.map((p) => p.name),
    ["Small low-rate", "Large high-rate"],
  );
  assert.equal(avalanche.paid_off[0]?.name, "Large high-rate");
  assert.ok(Number(avalanche.total_interest) < Number(snowball.total_interest));
  assert.ok(Number(snowball.interest_saved) > 0);
});

test("the explorer tool reads loans, checks statements and lists loans missing terms", async () => {
  const queries: unknown[][] = [];
  const db = {
    query: async (_sql: string, params: unknown[]) => {
      queries.push(params);
      return {
        rows: [
          {
            name: "Example mortgage",
            apr_percent: "3.600",
            original_principal: "140000.00",
            term_months: 240,
            first_payment_on: "2026-02-01",
            accrual: "monthly",
            balance_on: "2026-06-01",
            balance: "137992.19",
          },
          {
            name: "Example note",
            apr_percent: "5.000",
            original_principal: null,
            term_months: null,
            first_payment_on: null,
            accrual: null,
            balance_on: null,
            balance: null,
          },
        ],
      };
    },
  };
  const result = await payoffExplorer(db, { loans: ["Example mortgage", "Example note"], extra_monthly: "100.00" });
  assert.deepEqual(queries, [[["Example mortgage", "Example note"]]]);
  assert.deepEqual(result.incomplete, [
    { name: "Example note", missing: ["original_principal", "term_months", "first_payment_on", "accrual"] },
  ]);
  const [mortgage] = result.loans;
  assert.deepEqual(mortgage?.statement, {
    as_of: "2026-06-01",
    balance: "137992.19",
    computed: "137992.19",
    matches: true,
  });
  assert.equal(mortgage?.payment, "819.16");
  assert.deepEqual(
    mortgage?.scenarios.map((s) => s.strategy),
    ["baseline", "extra", "biweekly"],
  );
  assert.equal(mortgage?.scenarios[0]?.payments, 235);
});
