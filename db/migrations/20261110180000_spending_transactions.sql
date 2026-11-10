-- migrate:up
-- USD spending is positive; credits/refunds are negative. Importers normalize connector signs.
create table transactions (
  source text not null check (source = btrim(source) and source ~ '\S'),
  source_id text not null check (source_id = btrim(source_id) and source_id ~ '\S'),
  posted_on date not null check (isfinite(posted_on)),
  amount numeric(12, 2) not null check (amount <> 'NaN'::numeric),
  merchant text not null check (merchant = btrim(merchant) and merchant ~ '\S'),
  category text not null check (category = btrim(category) and category ~ '\S'),
  account_ref text not null check (account_ref = btrim(account_ref) and account_ref ~ '\S'),
  pending boolean not null,
  exclusion_reason text check (exclusion_reason in ('transfer', 'hidden', 'income')),
  primary key (source, source_id)
);
create index transactions_posted_on_idx on transactions (posted_on);

-- migrate:down
drop table transactions;
