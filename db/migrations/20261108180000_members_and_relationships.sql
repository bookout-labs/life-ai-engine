-- migrate:up
-- Pets and extended family belong here too, so "people" and a single-member relation no longer fit.
alter table people rename to members;
alter table members rename constraint people_pkey to members_pkey;
alter sequence people_id_seq rename to members_id_seq;
alter table members
  drop column name,
  drop column relation,
  add column first_name text not null,
  add column last_name text,
  add column goes_by text,
  add column species text not null default 'human' check (species = lower(species)),
  add column born date;

alter table activities rename column person_id to member_id;
alter table activities rename constraint activities_person_id_fkey to activities_member_id_fkey;
alter table activities rename constraint activities_person_id_activity_season_start_key to activities_member_id_activity_season_start_key;
alter table involvement rename column person_id to member_id;
alter table involvement rename constraint involvement_person_id_fkey to involvement_member_id_fkey;
alter table involvement rename constraint involvement_person_id_activity_id_role_key to involvement_member_id_activity_id_role_key;

-- Only direct links are stored (member is the parent or spouse of related); siblings and in-laws come from queries.
create table relationships (
  member_id bigint not null references members (id),
  related_id bigint not null references members (id),
  kind text not null check (kind in ('parent', 'spouse')),
  primary key (member_id, related_id, kind),
  constraint no_self_link check (member_id <> related_id),
  -- A marriage is stored once, lower id first, so it can't be entered from both sides.
  constraint spouse_stored_once check (kind <> 'spouse' or member_id < related_id)
);

-- migrate:down
drop table relationships;

alter table involvement rename constraint involvement_member_id_activity_id_role_key to involvement_person_id_activity_id_role_key;
alter table involvement rename constraint involvement_member_id_fkey to involvement_person_id_fkey;
alter table involvement rename column member_id to person_id;
alter table activities rename constraint activities_member_id_activity_season_start_key to activities_person_id_activity_season_start_key;
alter table activities rename constraint activities_member_id_fkey to activities_person_id_fkey;
alter table activities rename column member_id to person_id;

alter table members
  drop column first_name,
  drop column last_name,
  drop column goes_by,
  drop column species,
  drop column born,
  add column name text not null,
  add column relation text not null check (relation = lower(relation));
alter sequence members_id_seq rename to people_id_seq;
alter table members rename constraint members_pkey to people_pkey;
alter table members rename to people;
