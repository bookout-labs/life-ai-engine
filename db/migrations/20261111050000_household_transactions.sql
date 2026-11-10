-- migrate:up
alter table accounts add column source_ref text unique
  check (source_ref = btrim(source_ref) and source_ref ~ '\S');

create view household_transactions as
select t.* from transactions t
where not exists (
  select 1 from accounts a where a.source_ref = t.account_ref and a.scope = 'business'
);

-- migrate:down
drop view household_transactions;
alter table accounts drop column source_ref;
