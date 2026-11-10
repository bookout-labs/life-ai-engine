-- migrate:up
create table contacts (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) <= 300 and name ~ '[^[:space:]]'),
  role text not null check (role in ('teacher', 'coach', 'doctor', 'dentist', 'vet', 'contractor', 'service_provider', 'neighbor', 'friend', 'other')),
  organisation text check (length(organisation) <= 300 and organisation ~ '[^[:space:]]'),
  phone text check (phone ~ '^[+0-9() .-]+$' and length(regexp_replace(phone, '[^0-9]', '', 'g')) between 7 and 20),
  email text check (length(email) <= 254 and email ~ '^[^[:space:]@]+@[^[:space:]@.]+[.][^[:space:]@]+$'),
  address text check (length(address) <= 2000 and address ~ '[^[:space:]]'),
  notes text check (length(notes) <= 4000)
);

create table contact_links (
  contact_id uuid not null references contacts (id) on delete cascade,
  member_id bigint references members (id),
  activity_id bigint references activities (id),
  check ((member_id is null) <> (activity_id is null)),
  unique nulls not distinct (contact_id, member_id, activity_id)
);
create index contact_links_member on contact_links (member_id) where member_id is not null;
create index contact_links_activity on contact_links (activity_id) where activity_id is not null;

create table contact_requests (
  request_id uuid primary key,
  result jsonb not null
);

-- migrate:down
drop table contact_requests;
drop table contact_links;
drop table contacts;
