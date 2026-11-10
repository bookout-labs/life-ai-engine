-- migrate:up
create table goals (
  id bigint generated always as identity primary key,
  request_id uuid not null unique,
  area text not null check (area = btrim(area) and area ~ '\S' and char_length(area) <= 80),
  title text not null check (title = btrim(title) and title ~ '\S'),
  status text not null default 'active' check (status in ('active', 'done', 'dropped')),
  target numeric check (target not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
  unit text check (unit = btrim(unit) and unit ~ '\S'),
  due_on date check (isfinite(due_on)),
  page_slug text not null references pages (slug),
  check ((target is null) = (unit is null))
);

create index goals_active_area_idx on goals (area, id) where status = 'active';

-- migrate:down
drop table goals;
