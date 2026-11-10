-- migrate:up
create table weekly_patterns (
  id bigint generated always as identity primary key,
  activity_id bigint not null references activities (id),
  weekday integer not null check (weekday between 1 and 7),
  local_start time not null check (local_start < time '24:00'),
  duration_minutes integer not null check (duration_minutes between 1 and 1440),
  kind text not null check (length(trim(kind)) > 0 and kind = lower(kind) and kind <> 'cancelled'),
  location text,
  active_from date not null check (active_from between date '1900-01-01' and date '2200-12-31'),
  active_until date not null check (active_until between date '1900-01-01' and date '2200-12-31'),
  check (active_until >= active_from)
);

create table weekly_occurrences (
  pattern_id bigint not null references weekly_patterns (id),
  local_date date not null check (local_date between date '1900-01-01' and date '2200-12-31'),
  event_id bigint unique references events (id),
  status text not null check (status in ('created', 'skipped')),
  primary key (pattern_id, local_date),
  check (status = 'skipped' or event_id is not null)
);

create table weekly_requests (
  request_id uuid primary key,
  operation text not null check (operation in ('pattern', 'week')),
  result jsonb not null
);

-- migrate:down
drop table weekly_requests;
drop table weekly_occurrences;
drop table weekly_patterns;
