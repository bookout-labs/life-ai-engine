-- migrate:up
create table pages (
  id bigint generated always as identity primary key,
  slug text not null unique check (slug ~ '^[a-zA-Z0-9_-]+(/[a-zA-Z0-9_-]+)*$'),
  type text not null,
  title text not null,
  summary text not null default '',
  tags text[] not null default '{}',
  body text not null,
  created_on date not null default current_date,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  search tsvector generated always as (to_tsvector('english', title || ' ' || summary || ' ' || body)) stored
);
create index pages_search on pages using gin (search) where deleted_at is null;
create table page_revisions (
  id bigint generated always as identity primary key,
  page_id bigint not null references pages(id),
  body text not null,
  kind text not null check (kind in ('ingest', 'query', 'lint', 'note', 'edit')),
  saved_at timestamptz not null default now(),
  agent text not null,
  session text not null,
  work text not null
);
create index page_revisions_history on page_revisions(page_id, saved_at desc, id desc);
create table files (
  key text primary key,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  mime text not null,
  bytes bigint not null check (bytes >= 0),
  title text not null,
  source_page_id bigint references pages(id)
);
-- migrate:down
drop table files;
drop table page_revisions;
drop table pages;
