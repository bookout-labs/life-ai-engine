-- migrate:up
create table documents (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('will', 'durable_power_of_attorney', 'healthcare_directive', 'life_insurance', 'guardianship', 'birth_certificate', 'social_security_card', 'passport')),
  member_id bigint references members (id),
  location text check (length(location) <= 2000 and location ~ '[^[:space:]]'),
  file_key text references files (key),
  expires_on date check (expires_on between '1900-01-01'::date and '2200-12-31'::date),
  reviewed_on date check (reviewed_on between '1900-01-01'::date and '2200-12-31'::date),
  notes text check (length(notes) <= 4000),
  unique nulls not distinct (kind, member_id)
);

create table document_requests (
  request_id uuid primary key,
  result jsonb not null
);

-- migrate:down
drop table document_requests;
drop table documents;
