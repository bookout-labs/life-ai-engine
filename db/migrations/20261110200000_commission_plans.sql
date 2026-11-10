-- migrate:up
create function commission_rules_valid(rules jsonb) returns boolean
language plpgsql immutable as $$
declare
  rule jsonb;
  field text;
  names text[] := '{}';
  percent_total integer := 0;
  remainders integer := 0;
begin
  if jsonb_typeof(rules) <> 'array' or jsonb_array_length(rules) not between 1 and 50 then return false; end if;
  for rule in select value from jsonb_array_elements(rules) loop
    if jsonb_typeof(rule) <> 'object' or not (rule ?& array['kind', 'bucket']) then return false; end if;
    if jsonb_typeof(rule->'bucket') <> 'string' or length(rule->>'bucket') not between 1 and 120
       or rule->>'bucket' <> btrim(rule->>'bucket') or rule->>'bucket' !~ '\S'
       or rule->>'bucket' = any(names) then return false; end if;
    names := array_append(names, rule->>'bucket');
    if rule ? 'destination' then
      if jsonb_typeof(rule->'destination') <> 'object'
         or not ((rule->'destination') ?& array['kind', 'id'])
         or jsonb_typeof(rule->'destination'->'kind') <> 'string'
         or rule->'destination'->>'kind' not in ('account', 'loan')
         or jsonb_typeof(rule->'destination'->'id') <> 'string'
         or rule->'destination'->>'id' !~ '^[1-9][0-9]{0,18}$'
         or (rule->'destination'->>'id')::numeric > 9223372036854775807
         or (rule->'destination') - array['kind', 'id'] <> '{}'::jsonb then return false; end if;
    end if;
    if rule->>'kind' = 'percent' then
      if not (rule ? 'basis_points') then return false; end if;
      if jsonb_typeof(rule->'basis_points') <> 'number' or rule->>'basis_points' !~ '^[0-9]+$'
         or (rule->>'basis_points')::numeric > 10000 then return false; end if;
      percent_total := percent_total + (rule->>'basis_points')::integer;
      if rule - array['kind','bucket','destination','basis_points'] <> '{}'::jsonb then return false; end if;
    elsif rule->>'kind' in ('fixed', 'fill') then
      foreach field in array case when rule->>'kind' = 'fixed' then array['amount_cents'] else array['target_cents', 'cap_cents'] end loop
        if not (rule ? field) or jsonb_typeof(rule->field) <> 'number' or rule->>field !~ '^[0-9]+$'
           or (rule->>field)::numeric > 9000000000000 then return false; end if;
      end loop;
      if rule->>'kind' = 'fixed' and rule - array['kind','bucket','destination','amount_cents'] <> '{}'::jsonb then return false; end if;
      if rule->>'kind' = 'fill' and rule - array['kind','bucket','destination','target_cents','cap_cents'] <> '{}'::jsonb then return false; end if;
    elsif rule->>'kind' = 'remainder' then
      remainders := remainders + 1;
      if rule - array['kind','bucket','destination'] <> '{}'::jsonb then return false; end if;
    else return false;
    end if;
  end loop;
  return percent_total <= 10000 and remainders = 1 and rules->-1->>'kind' = 'remainder';
exception when others then return false;
end;
$$;

create table commission_plans (
  id bigint generated always as identity primary key,
  request_id uuid not null unique,
  effective_on date not null check (isfinite(effective_on) and effective_on between date '0001-01-01' and date '9999-12-31'),
  page_slug text not null references pages(slug),
  rules jsonb not null check (commission_rules_valid(rules))
);
create index commission_plans_effective on commission_plans (effective_on desc, id desc);

-- migrate:down
drop table commission_plans;
drop function commission_rules_valid(jsonb);
