-- migrate:up
lock table gift_occasions, gift_recipients, gifts, gift_requests in access exclusive mode;
do $$
begin
  if exists (select 1 from gift_occasions) or exists (select 1 from gift_recipients)
    or exists (select 1 from gifts) or exists (select 1 from gift_requests) then
    raise exception 'Gift tables must all be empty before reshaping recipients';
  end if;
end $$;

drop table gifts;
drop table gift_recipients;

create table gift_recipients (
  id uuid primary key default gen_random_uuid(),
  occasion_id text not null references gift_occasions (id),
  member_id bigint references members (id),
  budget numeric(12, 2) check (budget >= 0 and budget <> 'NaN'::numeric),
  name text check (length(btrim(name)) between 1 and 200 and name = btrim(name)),
  check (num_nonnulls(member_id, name) = 1),
  unique nulls not distinct (occasion_id, member_id, name),
  unique (occasion_id, id)
);

create table gifts (
  id uuid primary key default gen_random_uuid(),
  occasion_id text not null,
  recipient_id uuid not null,
  idea text not null check (length(btrim(idea)) between 1 and 500),
  amount numeric(12, 2) check (amount >= 0 and amount <> 'NaN'::numeric),
  status text not null check (status in ('idea', 'planned', 'bought', 'wrapped', 'given')),
  check (status = 'idea' or amount is not null),
  buyer_id bigint references members (id),
  link text check (length(link) <= 2000 and link ~ '^https?://'),
  note text check (length(note) <= 4000),
  foreign key (occasion_id, recipient_id) references gift_recipients (occasion_id, id)
);
create index gifts_occasion_recipient on gifts (occasion_id, recipient_id);

-- migrate:down
lock table gift_occasions, gift_recipients, gifts, gift_requests in access exclusive mode;
do $$
begin
  if exists (select 1 from gift_occasions) or exists (select 1 from gift_recipients)
    or exists (select 1 from gifts) or exists (select 1 from gift_requests) then
    raise exception 'Gift tables must all be empty before reshaping recipients';
  end if;
end $$;

drop table gifts;
drop table gift_recipients;

create table gift_recipients (
  occasion_id text not null references gift_occasions (id),
  member_id bigint not null references members (id),
  budget numeric(12, 2) check (budget >= 0 and budget <> 'NaN'::numeric),
  primary key (occasion_id, member_id)
);

create table gifts (
  id uuid primary key default gen_random_uuid(),
  occasion_id text not null,
  recipient_id bigint not null,
  idea text not null check (length(btrim(idea)) between 1 and 500),
  amount numeric(12, 2) not null check (amount >= 0 and amount <> 'NaN'::numeric),
  status text not null check (status in ('idea', 'planned', 'bought', 'wrapped', 'given')),
  buyer_id bigint references members (id),
  link text check (length(link) <= 2000 and link ~ '^https?://'),
  note text check (length(note) <= 4000),
  foreign key (occasion_id, recipient_id) references gift_recipients (occasion_id, member_id)
);
create index gifts_occasion_recipient on gifts (occasion_id, recipient_id);

