-- migrate:up
alter table files add column repo_path text;
-- migrate:down
alter table files drop column repo_path;
