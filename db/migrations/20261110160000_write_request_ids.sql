-- migrate:up
alter table investment_buys add column request_id uuid unique;
alter table workouts add column request_id uuid unique;

-- migrate:down
alter table workouts drop column request_id;
alter table investment_buys drop column request_id;
