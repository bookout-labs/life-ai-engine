-- migrate:up
-- The bill itself: what it is and when it comes due. Amounts change, so they live on charges, never here.
create table obligations (
  id bigint generated always as identity primary key,
  name text not null unique,
  kind text not null check (kind in ('bill', 'loan', 'card', 'subscription', 'transfer', 'investment')),
  cadence text not null check (cadence in ('monthly', 'yearly')),
  due_day smallint check (due_day between 1 and 31),
  due_month smallint check (due_month between 1 and 12),
  -- A day read off posting dates, not a real due date.
  day_is_estimate boolean not null default false,
  pays_from text,
  notes text,
  -- Cancelled bills keep their history, so they end instead of being deleted.
  ended_on date,
  constraint yearly_has_month check ((cadence = 'yearly') = (due_month is not null))
);

-- One row per billing; the latest one is the amount to expect next.
create table charges (
  id bigint generated always as identity primary key,
  obligation_id bigint not null references obligations (id),
  due_on date not null,
  amount numeric(10, 2) not null check (amount >= 0),
  amount_is_estimate boolean not null default false,
  paid_on date,
  unique (obligation_id, due_on)
);

create table deadlines (
  id bigint generated always as identity primary key,
  item text not null,
  action text not null,
  due_on date,
  due_is_estimate boolean not null default false,
  done_on date,
  obligation_id bigint references obligations (id)
);

-- A note's terms; the amortization schedule is computed from these, never stored.
create table loans (
  obligation_id bigint primary key references obligations (id),
  lender text not null,
  apr_percent numeric(6, 3) check (apr_percent between 0 and 100),
  original_principal numeric(12, 2) check (original_principal > 0),
  term_months smallint check (term_months > 0),
  first_payment_on date,
  -- Paying early or more often only saves interest when it accrues daily.
  accrual text check (accrual in ('daily', 'monthly'))
);

-- Statement or Monarch snapshots; they also check the computed schedule against reality.
create table loan_balances (
  obligation_id bigint not null references loans (obligation_id),
  as_of date not null,
  balance numeric(12, 2) not null check (balance >= 0),
  primary key (obligation_id, as_of)
);

-- migrate:down
drop table loan_balances;
drop table loans;
drop table deadlines;
drop table charges;
drop table obligations;
