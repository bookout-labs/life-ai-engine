// Amortization and payoff strategies computed from a loan's terms; schedules are never stored.
// Money is integer cents in bigint. Every rounding is half-up to the cent: the payment once,
// and interest each time it is charged. The payment due at maturity pays off whatever remains.
import { z } from "zod";
import { decimal as dollars } from "./money.ts";

const ACCRUALS = ["daily", "monthly"] as const;
type Accrual = (typeof ACCRUALS)[number];
export type Loan = {
  name: string;
  principal: bigint;
  /** Thousandths of a percent, as numeric(6,3) stores it: 3.600% is 3600n. */
  apr: bigint;
  termMonths: number;
  firstPaymentOn: string;
  accrual: Accrual;
  payment: bigint;
};
type Position = { balance: bigint; on: string };
type Row = { on: string; payment: string; interest: string; principal: string; balance: string };
type Strategy =
  | { kind: "baseline" }
  | { kind: "extra"; monthly: bigint }
  | { kind: "lump_sum"; on: string; amount: bigint }
  | { kind: "biweekly" };
type Order = "avalanche" | "snowball";

const APR_SCALE = 100_000n;
const DAY_MS = 86_400_000;
const LIMIT = 2_000;

const round = (n: bigint, d: bigint): bigint => (2n * n + d) / (2n * d);
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const dayCount = (from: string, to: string): number => (Date.parse(to) - Date.parse(from)) / DAY_MS;
const addDays = (iso: string, n: number): string => new Date(Date.parse(iso) + n * DAY_MS).toISOString().slice(0, 10);

// The 31st falls on a short month's last day.
function addMonths(iso: string, n: number): string {
  const [y = 0, m = 1, d = 1] = iso.split("-").map(Number);
  const last = new Date(Date.UTC(y, m + n, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))).toISOString().slice(0, 10);
}

const dueDate = (loan: Loan, k: number): string => addMonths(loan.firstPaymentOn, k);
const maturity = (loan: Loan): string => dueDate(loan, loan.termMonths - 1);

// Index of the first due date after `date`; k = -1 is the month before the first payment.
function dueAfter(loan: Loan, date: string): number {
  const [y0 = 0, m0 = 0] = loan.firstPaymentOn.split("-").map(Number);
  const [y = 0, m = 0] = date.split("-").map(Number);
  let k = (y - y0) * 12 + (m - m0) - 1;
  while (dueDate(loan, k) <= date) k++;
  return k;
}

export function monthlyPayment(principal: bigint, apr: bigint, termMonths: number): bigint {
  if (apr === 0n) return round(principal, BigInt(termMonths));
  const d = APR_SCALE * 12n;
  const grown = (d + apr) ** BigInt(termMonths);
  return round(principal * apr * grown, d * (grown - d ** BigInt(termMonths)));
}

// Monthly accrual charges one month's interest per due date, so a payment counts on the due date it falls before.
const accruals: Record<
  Accrual,
  {
    interest(loan: Loan, balance: bigint, from: string, to: string): bigint;
    credited(loan: Loan, date: string): string;
  }
> = {
  daily: {
    interest: (loan, balance, from, to) => round(balance * loan.apr * BigInt(dayCount(from, to)), APR_SCALE * 365n),
    credited: (_loan, date) => date,
  },
  monthly: {
    interest: (loan, balance, from, to) =>
      BigInt(dueAfter(loan, to) - dueAfter(loan, from)) * round(balance * loan.apr, APR_SCALE * 12n),
    credited: (loan, date) => dueDate(loan, dueAfter(loan, addDays(date, -1))),
  },
};

class Account {
  readonly loan: Loan;
  balance: bigint;
  owed = 0n;
  through: string;
  rows: Row[] = [];
  interestPaid = 0n;
  constructor(loan: Loan, start: Position) {
    this.loan = loan;
    this.balance = start.balance;
    this.through = start.on;
  }
  get open(): boolean {
    return this.balance > 0n || this.owed > 0n;
  }
  accrue(date: string): void {
    if (date <= this.through) return;
    this.owed += accruals[this.loan.accrual].interest(this.loan, this.balance, this.through, date);
    this.through = date;
  }
  payoff(): bigint {
    return this.balance + this.owed;
  }
  pay(date: string, amount: bigint): void {
    const total = min(amount, this.payoff());
    if (total <= 0n) return;
    const interest = min(total, this.owed);
    this.owed -= interest;
    this.balance -= total - interest;
    this.interestPaid += interest;
    const row = {
      on: date,
      payment: dollars(total),
      interest: dollars(interest),
      principal: dollars(total - interest),
    };
    this.rows.push({ ...row, balance: dollars(this.balance) });
    if (this.rows.length > LIMIT) throw new Error(`${this.loan.name}: the payment never covers the interest`);
  }
}

function* payments(loan: Loan, start: Position, strategy: Strategy): Generator<[string, bigint | null]> {
  const first = dueAfter(loan, start.on);
  const lump = strategy.kind === "lump_sum" ? strategy : undefined;
  const end = maturity(loan);
  let lumpDone = !lump;
  for (let i = 0; ; i++) {
    const [date, amount] =
      strategy.kind === "biweekly"
        ? [addDays(dueDate(loan, first), 14 * i), round(loan.payment, 2n)]
        : [dueDate(loan, first + i), loan.payment + (strategy.kind === "extra" ? strategy.monthly : 0n)];
    const on = date < end ? date : end;
    if (lump && !lumpDone && lump.on <= on) {
      lumpDone = true;
      yield [lump.on, lump.amount];
    }
    yield [on, on === end ? null : amount];
    if (on === end) return;
  }
}

function run(loan: Loan, start: Position, strategy: Strategy): Account {
  const account = new Account(loan, start);
  for (const [date, amount] of payments(loan, start, strategy)) {
    if (!account.open) break;
    const on = accruals[loan.accrual].credited(loan, date);
    account.accrue(on);
    account.pay(on, amount ?? account.payoff());
  }
  return account;
}

const origination = (loan: Loan): Position => ({ balance: loan.principal, on: dueDate(loan, -1) });

export const schedule = (loan: Loan): Row[] => run(loan, origination(loan), { kind: "baseline" }).rows;

// The balance a statement on `date` should show if every scheduled payment was made on its due date.
function scheduledBalance(loan: Loan, date: string): string {
  const paid = schedule(loan).filter((r) => r.on <= date);
  return paid.at(-1)?.balance ?? dollars(loan.principal);
}

// The budget is spent one calendar month at a time on the loans due that month. Each pays its own
// payment; what is left, including payments freed by loans already paid off, goes to them in strategy
// order. A loan whose first payment is still ahead neither draws on the budget nor adds to it.
function payDown(accounts: Account[], extra: bigint, order: Order): void {
  const rank = (a: Account, b: Account): number => {
    const byRate = Number(b.loan.apr - a.loan.apr);
    const byBalance = Number(a.balance - b.balance);
    const first = order === "avalanche" ? byRate || byBalance : byBalance || byRate;
    return first || a.loan.name.localeCompare(b.loan.name);
  };
  const next = new Map(accounts.map((a) => [a, dueAfter(a.loan, a.through)]));
  const due = (a: Account): string => dueDate(a.loan, next.get(a) ?? 0);
  while (accounts.some((a) => a.open)) {
    const [month = ""] = accounts
      .filter((a) => a.open)
      .map((a) => due(a).slice(0, 7))
      .sort();
    const paying = accounts.filter((a) => a.open && due(a).startsWith(month)).sort(rank);
    const budget = accounts
      .filter((a) => !a.open || paying.includes(a))
      .reduce((sum, a) => sum + a.loan.payment, extra);
    for (const a of paying) a.accrue(due(a));
    const amounts = new Map(paying.map((a) => [a, min(a.loan.payment, a.payoff())]));
    let left = budget - [...amounts.values()].reduce((sum, v) => sum + v, 0n);
    for (const a of paying) {
      const more = a.payoff() - (amounts.get(a) ?? 0n);
      const add = min(more, left);
      amounts.set(a, (amounts.get(a) ?? 0n) + add);
      left -= add;
    }
    for (const a of paying) {
      const on = due(a);
      a.pay(on, on === maturity(a.loan) ? a.payoff() : (amounts.get(a) ?? 0n));
      next.set(a, (next.get(a) ?? 0) + 1);
    }
  }
}

const summary = (account: Account, baseline: Account) => ({
  payoff_on: account.rows.at(-1)?.on ?? account.through,
  payments: account.rows.length,
  total_interest: dollars(account.interestPaid),
  interest_saved: dollars(baseline.interestPaid - account.interestPaid),
});

type Holding = { loan: Loan; start?: Position };
type Standing =
  | { status: "projected" }
  | { status: "matured_with_balance_outstanding" | "unsupported_start"; reason: string };

// A recorded balance is principal only, and no payment history is stored, so a projection may start
// only where nothing else is owed: before maturity, and on a due date for interest-bearing daily accrual.
function standing(loan: Loan, start: Position): Standing {
  const end = maturity(loan);
  if (start.balance > 0n && start.on >= end) {
    return {
      status: "matured_with_balance_outstanding",
      reason: `${dollars(start.balance)} is still owed on ${start.on}, at or after the final payment due ${end}, so no schedule remains to project. The lender's payoff quote is the amount due.`,
    };
  }
  if (loan.accrual === "daily" && loan.apr > 0n && dueDate(loan, dueAfter(loan, start.on) - 1) !== start.on) {
    return {
      status: "unsupported_start",
      reason: `The balance on ${start.on} falls between payment dates. Interest accrues daily and the balance is principal only, so the interest accrued since the last payment is unknown. Record a balance as of a payment date to project this loan.`,
    };
  }
  return { status: "projected" };
}

export function explore(
  holdings: Holding[],
  plan: { extraMonthly?: bigint; lumpSum?: { on: string; amount: bigint } },
) {
  const positioned = holdings.map(({ loan, start = origination(loan) }) => ({ loan, start, ...standing(loan, start) }));
  const projected = positioned.filter((h) => h.status === "projected");
  const strategies: Strategy[] = [
    { kind: "baseline" },
    ...(plan.extraMonthly ? [{ kind: "extra", monthly: plan.extraMonthly } as const] : []),
    ...(plan.lumpSum ? [{ kind: "lump_sum", ...plan.lumpSum } as const] : []),
    { kind: "biweekly" },
  ];
  const baselines = new Map<(typeof positioned)[number], Account>(
    projected.map((h) => [h, run(h.loan, h.start, { kind: "baseline" })]),
  );
  const baselineInterest = [...baselines.values()].reduce((sum, a) => sum + a.interestPaid, 0n);
  const loans = positioned.map((h) => {
    const { loan, start, ...standing } = h;
    const baseline = baselines.get(h);
    return {
      name: loan.name,
      accrual: loan.accrual,
      payment: dollars(loan.payment),
      start: { balance: dollars(start.balance), on: start.on },
      timing:
        loan.accrual === "daily"
          ? "Interest accrues daily, so paying earlier or more often saves interest."
          : "Interest is charged once a month, and a payment counts on its due date or the next one, so paying earlier in the month saves nothing; only paying more does. A biweekly half-payment waits for the next due date, so biweekly saves only through its extra payment each year, and it starts half a payment behind, so with a few months left it costs more.",
      ...standing,
      scenarios: baseline
        ? strategies.map((s) =>
            s.kind === "lump_sum" && s.on < start.on
              ? {
                  strategy: s.kind,
                  excluded: `The lump sum on ${s.on} predates the starting balance on ${start.on}, which already reflects it.`,
                }
              : { strategy: s.kind, ...summary(run(loan, start, s), baseline) },
          )
        : [],
    };
  });
  const orders =
    projected.length < 2
      ? []
      : (["avalanche", "snowball"] as const).map((order) => {
          const accounts = projected.map(({ loan, start }) => new Account(loan, start));
          payDown(accounts, plan.extraMonthly ?? 0n, order);
          const interest = accounts.reduce((sum, a) => sum + a.interestPaid, 0n);
          const paid_off = accounts
            .map((a) => ({ name: a.loan.name, on: a.rows.at(-1)?.on ?? a.through }))
            .sort((a, b) => a.on.localeCompare(b.on) || a.name.localeCompare(b.name));
          return {
            strategy: order,
            payoff_on: paid_off.at(-1)?.on,
            total_interest: dollars(interest),
            interest_saved: dollars(baselineInterest - interest),
            paid_off,
          };
        });
  return { loans, strategies: orders };
}

const money = z.string().regex(/^\d+(\.\d{1,2})?$/, "dollars as a decimal string, like 250.00");
export const payoffInputSchema = z.object({
  loans: z.array(z.string()).optional(),
  extra_monthly: money.optional(),
  lump_sum: z.object({ amount: money, on: z.iso.date() }).optional(),
});

// A numeric column as an integer count of its smallest unit: "3.6" at 3 places is 3600n.
function fixed(value: string, places: number): bigint {
  const [whole = "0", frac = ""] = value.split(".");
  return BigInt(whole) * 10n ** BigInt(places) + BigInt(frac.padEnd(places, "0").slice(0, places) || "0");
}

type LoanRow = {
  name: string;
  apr_percent: string | null;
  original_principal: string | null;
  term_months: number | null;
  first_payment_on: string | null;
  accrual: string | null;
  balance_on: string | null;
  balance: string | null;
};
const TERMS = ["apr_percent", "original_principal", "term_months", "first_payment_on", "accrual"] as const;

type Db = { query(sql: string, params: unknown[]): Promise<{ rows: LoanRow[] }> };

export async function payoffExplorer(db: Db, input: z.infer<typeof payoffInputSchema>) {
  const { rows } = await db.query(
    `select o.name, l.apr_percent::text as apr_percent, l.original_principal::text as original_principal,
            l.term_months, l.first_payment_on::text as first_payment_on, l.accrual,
            b.as_of::text as balance_on, b.balance::text as balance
       from loans l
       join obligations o on o.id = l.obligation_id
       left join lateral (
         select as_of, balance from loan_balances where obligation_id = l.obligation_id order by as_of desc limit 1
       ) b on true
      where o.ended_on is null and ($1::text[] is null or o.name = any($1))
      order by o.name`,
    [input.loans ?? null],
  );
  const incomplete = rows
    .map((r) => ({ name: r.name, missing: TERMS.filter((t) => r[t] === null) }))
    .filter((r) => r.missing.length > 0);
  const holdings = rows.flatMap((r) => {
    const accrual = ACCRUALS.find((a) => a === r.accrual);
    if (!r.apr_percent || !r.original_principal || !r.term_months || !r.first_payment_on || !accrual) return [];
    const terms = {
      name: r.name,
      principal: fixed(r.original_principal, 2),
      apr: fixed(r.apr_percent, 3),
      termMonths: r.term_months,
      firstPaymentOn: r.first_payment_on,
      accrual,
    };
    const loan = { ...terms, payment: monthlyPayment(terms.principal, terms.apr, terms.termMonths) };
    const start = r.balance_on && r.balance ? { balance: fixed(r.balance, 2), on: r.balance_on } : undefined;
    return [{ loan, ...(start && { start }) }];
  });
  const result = explore(holdings, {
    ...(input.extra_monthly && { extraMonthly: fixed(input.extra_monthly, 2) }),
    ...(input.lump_sum && { lumpSum: { on: input.lump_sum.on, amount: fixed(input.lump_sum.amount, 2) } }),
  });
  return {
    loans: result.loans.map((summary, i) => {
      const h = holdings[i];
      if (!h?.start) return { ...summary, statement: null };
      const computed = scheduledBalance(h.loan, h.start.on);
      const balance = dollars(h.start.balance);
      return { ...summary, statement: { as_of: h.start.on, balance, computed, matches: computed === balance } };
    }),
    strategies: result.strategies,
    incomplete,
  };
}
