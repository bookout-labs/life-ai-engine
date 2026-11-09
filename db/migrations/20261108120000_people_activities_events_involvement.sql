-- migrate:up
create table people (
  id bigint generated always as identity primary key,
  name text not null,
  relation text not null check (relation = lower(relation))
);

-- One row is one season, so a sport that repeats is a new row, never an edit.
create table activities (
  id bigint generated always as identity primary key,
  person_id bigint not null references people (id),
  activity text not null check (activity = lower(activity)),
  season_start date not null,
  season_end date check (season_end >= season_start),
  unique (person_id, activity, season_start)
);

-- Game and practice times change week to week, so each one is its own dated row.
create table events (
  id bigint generated always as identity primary key,
  activity_id bigint not null references activities (id),
  kind text not null check (kind = lower(kind)),
  starts_at timestamptz not null,
  ends_at timestamptz check (ends_at > starts_at),
  location text,
  unique (activity_id, starts_at)
);

-- The person's id is reached through activity_id, so it is never stored twice.
create table involvement (
  id bigint generated always as identity primary key,
  person_id bigint not null references people (id),
  activity_id bigint not null references activities (id),
  role text not null check (role = lower(role)),
  unique (person_id, activity_id, role)
);

-- migrate:down
drop table involvement;
drop table events;
drop table activities;
drop table people;
