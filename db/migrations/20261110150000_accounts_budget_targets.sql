-- migrate:up
create table accounts (
  id bigint generated always as identity primary key,
  institution text not null check (institution = btrim(institution) and institution <> ''),
  name text not null check (name = btrim(name) and name <> ''),
  kind text not null check (kind in ('bank', 'card', 'investment', 'loan')),
  subtype text check (subtype = btrim(subtype) and subtype <> ''),
  scope text not null check (scope in ('household', 'business', 'unknown')),
  notes text,
  unique (institution, name)
);

-- Recurring monthly targets, not spending observations or bills. Equal bounds mean an exact target.
create table budget_targets (
  category text primary key check (category = btrim(category) and category <> ''),
  monthly_min numeric(12, 2) not null check (monthly_min >= 0 and monthly_min <> 'NaN'::numeric),
  monthly_max numeric(12, 2) not null check (monthly_max >= monthly_min and monthly_max <> 'NaN'::numeric),
  -- Draft proposals must not silently become agreed spending limits.
  status text not null check (status in ('draft', 'approved')),
  is_estimate boolean not null default false,
  notes text
);

-- migrate:down
drop table budget_targets;
drop table accounts;
