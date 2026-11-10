-- migrate:up
alter table documents add constraint documents_ownership_check
  check ((kind = 'guardianship') = (member_id is null));

-- migrate:down
alter table documents drop constraint documents_ownership_check;
