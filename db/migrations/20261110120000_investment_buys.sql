-- migrate:up
create table investment_buys (
  id bigint generated always as identity primary key,
  state text not null check (state in ('planned', 'completed')),
  symbol text not null check (length(trim(symbol)) > 0),
  account_ref text not null check (length(trim(account_ref)) > 0),
  planned_on date,
  planned_condition text check (length(trim(planned_condition)) > 0),
  executed_on date,
  amount numeric(14, 2) check (amount > 0),
  check (state <> 'planned' or ((planned_on is not null or planned_condition is not null) and executed_on is null)),
  check (state <> 'completed' or (executed_on is not null and amount is not null))
);

-- migrate:down
drop table investment_buys;
