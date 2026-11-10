-- migrate:up
create table warranties (
  id uuid primary key default gen_random_uuid(),
  item text not null check (length(item) <= 2000 and item ~ '[^[:space:]]'),
  provider text not null check (length(provider) <= 2000 and provider ~ '[^[:space:]]'),
  kind text not null check (kind in ('manufacturer', 'extended', 'service_plan')),
  purchased_on date not null check (purchased_on between '1900-01-01'::date and '2200-12-31'::date),
  expires_on date check (expires_on between '1900-01-01'::date and '2200-12-31'::date and expires_on >= purchased_on),
  expiry_unknown boolean not null,
  cost_cents integer check (cost_cents >= 0),
  file_key text references files (key),
  source_ref text unique check (length(source_ref) <= 2000 and source_ref ~ '[^[:space:]]'),
  notes text check (length(notes) <= 4000),
  check (not expiry_unknown or expires_on is null)
);

create table warranty_requests (
  request_id uuid primary key,
  result jsonb not null
);

-- migrate:down
drop table warranty_requests;
drop table warranties;
