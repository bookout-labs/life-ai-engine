-- migrate:up
create table upkeep_tasks (
  id bigint generated always as identity primary key,
  name text not null check (length(btrim(name)) between 1 and 200),
  category text not null check (category in ('home', 'vehicle')),
  interval_months smallint check (interval_months > 0),
  yearly_month smallint,
  yearly_day smallint,
  notes text,
  constraint upkeep_schedule check (
    (interval_months is not null and yearly_month is null and yearly_day is null)
    or (interval_months is null and yearly_month is not null and yearly_day is not null
      and yearly_month between 1 and 12 and yearly_day between 1 and
        case yearly_month when 2 then 29 when 4 then 30 when 6 then 30 when 9 then 30 when 11 then 30 else 31 end)
  )
);

create table upkeep_completions (
  id bigint generated always as identity primary key,
  request_id uuid not null unique,
  task_id bigint not null references upkeep_tasks (id),
  completed_on date not null check (completed_on between date '1900-01-01' and date '2200-12-31'),
  notes text
);
create index upkeep_completions_latest on upkeep_completions (task_id, completed_on desc);

-- migrate:down
drop table upkeep_completions;
drop table upkeep_tasks;
