-- migrate:up
create table workouts (
  id bigint generated always as identity primary key,
  performed_on date not null,
  kind text not null check (length(trim(kind)) > 0),
  notes text
);

create index workouts_performed_on_idx on workouts (performed_on desc, id desc);

create table workout_blocks (
  id bigint generated always as identity primary key,
  workout_id bigint not null references workouts (id) on delete cascade,
  position integer not null check (position > 0),
  name text not null check (length(trim(name)) > 0),
  sets integer check (sets > 0),
  reps integer check (reps > 0),
  weight numeric check (weight >= 0 and weight < 'Infinity'::numeric),
  weight_unit text check (weight_unit in ('lb', 'kg')),
  duration_seconds integer check (duration_seconds > 0),
  notes text,
  check ((weight is null) = (weight_unit is null)),
  unique (workout_id, position)
);

-- migrate:down
drop table workout_blocks;
drop table workouts;
