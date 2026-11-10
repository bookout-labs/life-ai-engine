-- migrate:up
create table gift_occasions (
  id text primary key check (id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title text not null check (length(btrim(title)) between 1 and 200),
  budget numeric(12, 2) check (budget >= 0 and budget <> 'NaN'::numeric)
);

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

create table gift_requests (
  request_id uuid primary key,
  result jsonb not null
);

-- migrate:down
drop table gift_requests;
drop table gifts;
drop table gift_recipients;
drop table gift_occasions;
