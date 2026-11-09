-- migrate:up
-- Where a charge came from (a finance transaction id or statement reference), so the same one can't be entered twice.
alter table charges add column source_ref text unique;

-- Cancelled is a status, not a kind: a cancelled class is still a class.
-- The old rows lost their kind, so one is restored only when the activity has a single kind; otherwise it stays neutral.
alter table events add column cancelled boolean not null default false;
update events e
   set cancelled = true,
       kind = coalesce(
         (select min(o.kind) from events o
           where o.activity_id = e.activity_id and o.kind <> 'cancelled'
          having count(distinct o.kind) = 1),
         'event')
 where e.kind = 'cancelled';
alter table events add constraint events_kind_not_status check (kind <> 'cancelled');

-- migrate:down
alter table events drop constraint events_kind_not_status;
update events set kind = 'cancelled' where cancelled;
alter table events drop column cancelled;
alter table charges drop column source_ref;
