\restrict dbmate

-- Dumped from database version 18.6 (ac70818)
-- Dumped by pg_dump version 18.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: commission_rules_valid(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.commission_rules_valid(rules jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $_$
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
$_$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.accounts (
    id bigint NOT NULL,
    institution text NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    subtype text,
    scope text NOT NULL,
    notes text,
    source_ref text,
    CONSTRAINT accounts_institution_check CHECK (((institution = btrim(institution)) AND (institution ~ '\S'::text))),
    CONSTRAINT accounts_kind_check CHECK ((kind = ANY (ARRAY['bank'::text, 'card'::text, 'investment'::text, 'loan'::text]))),
    CONSTRAINT accounts_name_check CHECK (((name = btrim(name)) AND (name ~ '\S'::text))),
    CONSTRAINT accounts_scope_check CHECK ((scope = ANY (ARRAY['household'::text, 'business'::text, 'unknown'::text]))),
    CONSTRAINT accounts_source_ref_check CHECK (((source_ref = btrim(source_ref)) AND (source_ref ~ '\S'::text))),
    CONSTRAINT accounts_subtype_check CHECK (((subtype = btrim(subtype)) AND (subtype ~ '\S'::text)))
);


--
-- Name: accounts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.accounts ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.accounts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: activities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.activities (
    id bigint NOT NULL,
    member_id bigint CONSTRAINT activities_person_id_not_null NOT NULL,
    activity text NOT NULL,
    season_start date NOT NULL,
    season_end date,
    CONSTRAINT activities_activity_check CHECK ((activity = lower(activity))),
    CONSTRAINT activities_check CHECK ((season_end >= season_start))
);


--
-- Name: activities_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.activities ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.activities_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: budget_targets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.budget_targets (
    category text NOT NULL,
    monthly_min numeric(12,2) NOT NULL,
    monthly_max numeric(12,2) NOT NULL,
    status text NOT NULL,
    is_estimate boolean DEFAULT false NOT NULL,
    notes text,
    CONSTRAINT budget_targets_category_check CHECK (((category = btrim(category)) AND (category ~ '\S'::text))),
    CONSTRAINT budget_targets_check CHECK (((monthly_max >= monthly_min) AND (monthly_max <> 'NaN'::numeric))),
    CONSTRAINT budget_targets_monthly_min_check CHECK (((monthly_min >= (0)::numeric) AND (monthly_min <> 'NaN'::numeric))),
    CONSTRAINT budget_targets_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'approved'::text])))
);


--
-- Name: charges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.charges (
    id bigint NOT NULL,
    obligation_id bigint NOT NULL,
    due_on date NOT NULL,
    amount numeric(10,2) NOT NULL,
    amount_is_estimate boolean DEFAULT false NOT NULL,
    paid_on date,
    source_ref text,
    CONSTRAINT charges_amount_check CHECK ((amount >= (0)::numeric))
);


--
-- Name: charges_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.charges ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.charges_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: commission_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.commission_plans (
    id bigint NOT NULL,
    request_id uuid NOT NULL,
    effective_on date NOT NULL,
    page_slug text NOT NULL,
    rules jsonb NOT NULL,
    CONSTRAINT commission_plans_effective_on_check CHECK ((isfinite(effective_on) AND ((effective_on >= '0001-01-01'::date) AND (effective_on <= '9999-12-31'::date)))),
    CONSTRAINT commission_plans_rules_check CHECK (public.commission_rules_valid(rules))
);


--
-- Name: commission_plans_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.commission_plans ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.commission_plans_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: contact_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contact_links (
    contact_id uuid NOT NULL,
    member_id bigint,
    activity_id bigint,
    CONSTRAINT contact_links_check CHECK (((member_id IS NULL) <> (activity_id IS NULL)))
);


--
-- Name: contact_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contact_requests (
    request_id uuid NOT NULL,
    result jsonb NOT NULL
);


--
-- Name: contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    role text NOT NULL,
    organisation text,
    phone text,
    email text,
    address text,
    notes text,
    CONSTRAINT contacts_address_check CHECK (((length(address) <= 2000) AND (address ~ '[^[:space:]]'::text))),
    CONSTRAINT contacts_email_check CHECK (((length(email) <= 254) AND (email ~ '^[^[:space:]@]+@[^[:space:]@.]+[.][^[:space:]@]+$'::text))),
    CONSTRAINT contacts_name_check CHECK (((length(name) <= 300) AND (name ~ '[^[:space:]]'::text))),
    CONSTRAINT contacts_notes_check CHECK ((length(notes) <= 4000)),
    CONSTRAINT contacts_organisation_check CHECK (((length(organisation) <= 300) AND (organisation ~ '[^[:space:]]'::text))),
    CONSTRAINT contacts_phone_check CHECK (((phone ~ '^[+0-9() .-]+$'::text) AND ((length(regexp_replace(phone, '[^0-9]'::text, ''::text, 'g'::text)) >= 7) AND (length(regexp_replace(phone, '[^0-9]'::text, ''::text, 'g'::text)) <= 20)))),
    CONSTRAINT contacts_role_check CHECK ((role = ANY (ARRAY['teacher'::text, 'coach'::text, 'doctor'::text, 'dentist'::text, 'vet'::text, 'contractor'::text, 'service_provider'::text, 'neighbor'::text, 'friend'::text, 'other'::text])))
);


--
-- Name: deadlines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deadlines (
    id bigint NOT NULL,
    item text NOT NULL,
    action text NOT NULL,
    due_on date,
    due_is_estimate boolean DEFAULT false NOT NULL,
    done_on date,
    obligation_id bigint
);


--
-- Name: deadlines_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.deadlines ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.deadlines_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: document_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_requests (
    request_id uuid NOT NULL,
    result jsonb NOT NULL
);


--
-- Name: documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    member_id bigint,
    location text,
    file_key text,
    expires_on date,
    reviewed_on date,
    notes text,
    CONSTRAINT documents_expires_on_check CHECK (((expires_on >= '1900-01-01'::date) AND (expires_on <= '2200-12-31'::date))),
    CONSTRAINT documents_kind_check CHECK ((kind = ANY (ARRAY['will'::text, 'durable_power_of_attorney'::text, 'healthcare_directive'::text, 'life_insurance'::text, 'guardianship'::text, 'birth_certificate'::text, 'social_security_card'::text, 'passport'::text]))),
    CONSTRAINT documents_location_check CHECK (((length(location) <= 2000) AND (location ~ '[^[:space:]]'::text))),
    CONSTRAINT documents_notes_check CHECK ((length(notes) <= 4000)),
    CONSTRAINT documents_ownership_check CHECK (((kind = 'guardianship'::text) = (member_id IS NULL))),
    CONSTRAINT documents_reviewed_on_check CHECK (((reviewed_on >= '1900-01-01'::date) AND (reviewed_on <= '2200-12-31'::date)))
);


--
-- Name: events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.events (
    id bigint NOT NULL,
    activity_id bigint NOT NULL,
    kind text NOT NULL,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone,
    location text,
    cancelled boolean DEFAULT false NOT NULL,
    CONSTRAINT events_check CHECK ((ends_at > starts_at)),
    CONSTRAINT events_kind_check CHECK ((kind = lower(kind))),
    CONSTRAINT events_kind_not_status CHECK ((kind <> 'cancelled'::text))
);


--
-- Name: events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.files (
    key text NOT NULL,
    sha256 text NOT NULL,
    mime text NOT NULL,
    bytes bigint NOT NULL,
    title text NOT NULL,
    source_page_id bigint,
    repo_path text,
    CONSTRAINT files_bytes_check CHECK ((bytes >= 0)),
    CONSTRAINT files_sha256_check CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: gift_occasions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gift_occasions (
    id text NOT NULL,
    title text NOT NULL,
    budget numeric(12,2),
    CONSTRAINT gift_occasions_budget_check CHECK (((budget >= (0)::numeric) AND (budget <> 'NaN'::numeric))),
    CONSTRAINT gift_occasions_id_check CHECK ((id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text)),
    CONSTRAINT gift_occasions_title_check CHECK (((length(btrim(title)) >= 1) AND (length(btrim(title)) <= 200)))
);


--
-- Name: gift_recipients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gift_recipients (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    occasion_id text NOT NULL,
    member_id bigint,
    budget numeric(12,2),
    name text,
    CONSTRAINT gift_recipients_budget_check CHECK (((budget >= (0)::numeric) AND (budget <> 'NaN'::numeric))),
    CONSTRAINT gift_recipients_check CHECK ((num_nonnulls(member_id, name) = 1)),
    CONSTRAINT gift_recipients_name_check CHECK ((((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 200)) AND (name = btrim(name))))
);


--
-- Name: gift_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gift_requests (
    request_id uuid NOT NULL,
    result jsonb NOT NULL
);


--
-- Name: gifts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gifts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    occasion_id text NOT NULL,
    recipient_id uuid NOT NULL,
    idea text NOT NULL,
    amount numeric(12,2),
    status text NOT NULL,
    buyer_id bigint,
    link text,
    note text,
    CONSTRAINT gifts_amount_check CHECK (((amount >= (0)::numeric) AND (amount <> 'NaN'::numeric))),
    CONSTRAINT gifts_check CHECK (((status = 'idea'::text) OR (amount IS NOT NULL))),
    CONSTRAINT gifts_idea_check CHECK (((length(btrim(idea)) >= 1) AND (length(btrim(idea)) <= 500))),
    CONSTRAINT gifts_link_check CHECK (((length(link) <= 2000) AND (link ~ '^https?://'::text))),
    CONSTRAINT gifts_note_check CHECK ((length(note) <= 4000)),
    CONSTRAINT gifts_status_check CHECK ((status = ANY (ARRAY['idea'::text, 'planned'::text, 'bought'::text, 'wrapped'::text, 'given'::text])))
);


--
-- Name: goals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.goals (
    id bigint NOT NULL,
    request_id uuid NOT NULL,
    area text NOT NULL,
    title text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    target numeric,
    unit text,
    due_on date,
    page_slug text NOT NULL,
    CONSTRAINT goals_area_check CHECK (((area = btrim(area)) AND (area ~ '\S'::text) AND (char_length(area) <= 80))),
    CONSTRAINT goals_check CHECK (((target IS NULL) = (unit IS NULL))),
    CONSTRAINT goals_due_on_check CHECK (isfinite(due_on)),
    CONSTRAINT goals_status_check CHECK ((status = ANY (ARRAY['active'::text, 'done'::text, 'dropped'::text]))),
    CONSTRAINT goals_target_check CHECK ((target <> ALL (ARRAY['NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric]))),
    CONSTRAINT goals_title_check CHECK (((title = btrim(title)) AND (title ~ '\S'::text))),
    CONSTRAINT goals_unit_check CHECK (((unit = btrim(unit)) AND (unit ~ '\S'::text)))
);


--
-- Name: goals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.goals ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.goals_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transactions (
    source text NOT NULL,
    source_id text NOT NULL,
    posted_on date NOT NULL,
    amount numeric(12,2) NOT NULL,
    merchant text NOT NULL,
    category text NOT NULL,
    account_ref text NOT NULL,
    pending boolean NOT NULL,
    exclusion_reason text,
    CONSTRAINT transactions_account_ref_check CHECK (((account_ref = btrim(account_ref)) AND (account_ref ~ '\S'::text))),
    CONSTRAINT transactions_amount_check CHECK ((amount <> 'NaN'::numeric)),
    CONSTRAINT transactions_category_check CHECK (((category = btrim(category)) AND (category ~ '\S'::text))),
    CONSTRAINT transactions_exclusion_reason_check CHECK ((exclusion_reason = ANY (ARRAY['transfer'::text, 'hidden'::text, 'income'::text]))),
    CONSTRAINT transactions_merchant_check CHECK (((merchant = btrim(merchant)) AND (merchant ~ '\S'::text))),
    CONSTRAINT transactions_posted_on_check CHECK (isfinite(posted_on)),
    CONSTRAINT transactions_source_check CHECK (((source = btrim(source)) AND (source ~ '\S'::text))),
    CONSTRAINT transactions_source_id_check CHECK (((source_id = btrim(source_id)) AND (source_id ~ '\S'::text)))
);


--
-- Name: household_transactions; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.household_transactions AS
 SELECT source,
    source_id,
    posted_on,
    amount,
    merchant,
    category,
    account_ref,
    pending,
    exclusion_reason
   FROM public.transactions t
  WHERE (NOT (EXISTS ( SELECT 1
           FROM public.accounts a
          WHERE ((a.source_ref = t.account_ref) AND (a.scope = 'business'::text)))));


--
-- Name: investment_buys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.investment_buys (
    id bigint NOT NULL,
    state text NOT NULL,
    symbol text NOT NULL,
    account_ref text NOT NULL,
    planned_on date,
    planned_condition text,
    executed_on date,
    amount numeric(14,2),
    request_id uuid,
    CONSTRAINT investment_buys_account_ref_check CHECK ((length(TRIM(BOTH FROM account_ref)) > 0)),
    CONSTRAINT investment_buys_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT investment_buys_check CHECK (((state <> 'planned'::text) OR (((planned_on IS NOT NULL) OR (planned_condition IS NOT NULL)) AND (executed_on IS NULL)))),
    CONSTRAINT investment_buys_check1 CHECK (((state <> 'completed'::text) OR ((executed_on IS NOT NULL) AND (amount IS NOT NULL)))),
    CONSTRAINT investment_buys_planned_condition_check CHECK ((length(TRIM(BOTH FROM planned_condition)) > 0)),
    CONSTRAINT investment_buys_state_check CHECK ((state = ANY (ARRAY['planned'::text, 'completed'::text]))),
    CONSTRAINT investment_buys_symbol_check CHECK ((length(TRIM(BOTH FROM symbol)) > 0))
);


--
-- Name: investment_buys_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.investment_buys ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.investment_buys_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: involvement; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.involvement (
    id bigint NOT NULL,
    member_id bigint CONSTRAINT involvement_person_id_not_null NOT NULL,
    activity_id bigint NOT NULL,
    role text NOT NULL,
    CONSTRAINT involvement_role_check CHECK ((role = lower(role)))
);


--
-- Name: involvement_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.involvement ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.involvement_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: loan_balances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.loan_balances (
    obligation_id bigint NOT NULL,
    as_of date NOT NULL,
    balance numeric(12,2) NOT NULL,
    CONSTRAINT loan_balances_balance_check CHECK ((balance >= (0)::numeric))
);


--
-- Name: loans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.loans (
    obligation_id bigint NOT NULL,
    lender text NOT NULL,
    apr_percent numeric(6,3),
    original_principal numeric(12,2),
    term_months smallint,
    first_payment_on date,
    accrual text,
    CONSTRAINT loans_accrual_check CHECK ((accrual = ANY (ARRAY['daily'::text, 'monthly'::text]))),
    CONSTRAINT loans_apr_percent_check CHECK (((apr_percent >= (0)::numeric) AND (apr_percent <= (100)::numeric))),
    CONSTRAINT loans_original_principal_check CHECK ((original_principal > (0)::numeric)),
    CONSTRAINT loans_term_months_check CHECK ((term_months > 0))
);


--
-- Name: members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.members (
    id bigint CONSTRAINT people_id_not_null NOT NULL,
    first_name text NOT NULL,
    last_name text,
    goes_by text,
    species text DEFAULT 'human'::text NOT NULL,
    born date,
    CONSTRAINT members_species_check CHECK ((species = lower(species)))
);


--
-- Name: members_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.members ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.members_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: obligation_merchant_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.obligation_merchant_requests (
    request_id uuid NOT NULL,
    result jsonb NOT NULL,
    CONSTRAINT obligation_merchant_requests_result_check CHECK ((jsonb_typeof(result) = 'object'::text))
);


--
-- Name: obligation_merchants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.obligation_merchants (
    merchant text NOT NULL,
    obligation_id bigint NOT NULL,
    CONSTRAINT obligation_merchants_merchant_check CHECK (((merchant = btrim(merchant)) AND ((length(merchant) >= 1) AND (length(merchant) <= 1000))))
);


--
-- Name: obligations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.obligations (
    id bigint NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    cadence text NOT NULL,
    due_day smallint,
    due_month smallint,
    day_is_estimate boolean DEFAULT false NOT NULL,
    pays_from text,
    notes text,
    ended_on date,
    CONSTRAINT obligations_cadence_check CHECK ((cadence = ANY (ARRAY['monthly'::text, 'yearly'::text]))),
    CONSTRAINT obligations_due_day_check CHECK (((due_day >= 1) AND (due_day <= 31))),
    CONSTRAINT obligations_due_month_check CHECK (((due_month >= 1) AND (due_month <= 12))),
    CONSTRAINT obligations_kind_check CHECK ((kind = ANY (ARRAY['bill'::text, 'loan'::text, 'card'::text, 'subscription'::text, 'transfer'::text, 'investment'::text]))),
    CONSTRAINT yearly_has_month CHECK (((cadence = 'yearly'::text) = (due_month IS NOT NULL)))
);


--
-- Name: obligations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.obligations ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.obligations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: page_revisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.page_revisions (
    id bigint NOT NULL,
    page_id bigint NOT NULL,
    body text NOT NULL,
    kind text NOT NULL,
    saved_at timestamp with time zone DEFAULT now() NOT NULL,
    agent text NOT NULL,
    session text NOT NULL,
    work text NOT NULL,
    CONSTRAINT page_revisions_kind_check CHECK ((kind = ANY (ARRAY['ingest'::text, 'query'::text, 'lint'::text, 'note'::text, 'edit'::text])))
);


--
-- Name: page_revisions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.page_revisions ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.page_revisions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: pages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pages (
    id bigint NOT NULL,
    slug text NOT NULL,
    type text NOT NULL,
    title text NOT NULL,
    summary text DEFAULT ''::text NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    body text NOT NULL,
    created_on date DEFAULT CURRENT_DATE NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    search tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, ((((title || ' '::text) || summary) || ' '::text) || body))) STORED,
    CONSTRAINT pages_slug_check CHECK ((slug ~ '^[a-zA-Z0-9_-]+(/[a-zA-Z0-9_-]+)*$'::text))
);


--
-- Name: pages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.pages ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.pages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: receipt_charge_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.receipt_charge_requests (
    request_id uuid NOT NULL,
    result jsonb NOT NULL,
    CONSTRAINT receipt_charge_requests_result_check CHECK ((jsonb_typeof(result) = 'object'::text))
);


--
-- Name: receipt_charges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.receipt_charges (
    obligation_id bigint NOT NULL,
    posted_on date NOT NULL,
    amount numeric(12,2) NOT NULL,
    source_ref text NOT NULL,
    CONSTRAINT receipt_charges_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT receipt_charges_source_ref_check CHECK (((length(source_ref) >= 1) AND (length(source_ref) <= 4000)))
);


--
-- Name: relationships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.relationships (
    member_id bigint NOT NULL,
    related_id bigint NOT NULL,
    kind text NOT NULL,
    CONSTRAINT no_self_link CHECK ((member_id <> related_id)),
    CONSTRAINT relationships_kind_check CHECK ((kind = ANY (ARRAY['parent'::text, 'spouse'::text]))),
    CONSTRAINT spouse_stored_once CHECK (((kind <> 'spouse'::text) OR (member_id < related_id)))
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version character varying NOT NULL
);


--
-- Name: upkeep_completions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.upkeep_completions (
    id bigint NOT NULL,
    request_id uuid NOT NULL,
    task_id bigint NOT NULL,
    completed_on date NOT NULL,
    notes text,
    CONSTRAINT upkeep_completions_completed_on_check CHECK (((completed_on >= '1900-01-01'::date) AND (completed_on <= '2200-12-31'::date)))
);


--
-- Name: upkeep_completions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.upkeep_completions ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.upkeep_completions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: upkeep_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.upkeep_tasks (
    id bigint NOT NULL,
    name text NOT NULL,
    category text NOT NULL,
    interval_months smallint,
    yearly_month smallint,
    yearly_day smallint,
    notes text,
    CONSTRAINT upkeep_schedule CHECK ((((interval_months IS NOT NULL) AND (yearly_month IS NULL) AND (yearly_day IS NULL)) OR ((interval_months IS NULL) AND (yearly_month IS NOT NULL) AND (yearly_day IS NOT NULL) AND ((yearly_month >= 1) AND (yearly_month <= 12)) AND ((yearly_day >= 1) AND (yearly_day <=
CASE yearly_month
    WHEN 2 THEN 29
    WHEN 4 THEN 30
    WHEN 6 THEN 30
    WHEN 9 THEN 30
    WHEN 11 THEN 30
    ELSE 31
END))))),
    CONSTRAINT upkeep_tasks_category_check CHECK ((category = ANY (ARRAY['home'::text, 'vehicle'::text]))),
    CONSTRAINT upkeep_tasks_interval_months_check CHECK ((interval_months > 0)),
    CONSTRAINT upkeep_tasks_name_check CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 200)))
);


--
-- Name: upkeep_tasks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.upkeep_tasks ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.upkeep_tasks_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: warranties; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.warranties (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    item text NOT NULL,
    provider text NOT NULL,
    kind text NOT NULL,
    purchased_on date NOT NULL,
    expires_on date,
    expiry_unknown boolean NOT NULL,
    cost_cents integer,
    file_key text,
    source_ref text,
    notes text,
    CONSTRAINT warranties_check CHECK ((((expires_on >= '1900-01-01'::date) AND (expires_on <= '2200-12-31'::date)) AND (expires_on >= purchased_on))),
    CONSTRAINT warranties_check1 CHECK (((NOT expiry_unknown) OR (expires_on IS NULL))),
    CONSTRAINT warranties_cost_cents_check CHECK ((cost_cents >= 0)),
    CONSTRAINT warranties_item_check CHECK (((length(item) <= 2000) AND (item ~ '[^[:space:]]'::text))),
    CONSTRAINT warranties_kind_check CHECK ((kind = ANY (ARRAY['manufacturer'::text, 'extended'::text, 'service_plan'::text]))),
    CONSTRAINT warranties_notes_check CHECK ((length(notes) <= 4000)),
    CONSTRAINT warranties_provider_check CHECK (((length(provider) <= 2000) AND (provider ~ '[^[:space:]]'::text))),
    CONSTRAINT warranties_purchased_on_check CHECK (((purchased_on >= '1900-01-01'::date) AND (purchased_on <= '2200-12-31'::date))),
    CONSTRAINT warranties_source_ref_check CHECK (((length(source_ref) <= 2000) AND (source_ref ~ '[^[:space:]]'::text)))
);


--
-- Name: warranty_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.warranty_requests (
    request_id uuid NOT NULL,
    result jsonb NOT NULL
);


--
-- Name: weekly_occurrences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.weekly_occurrences (
    pattern_id bigint NOT NULL,
    local_date date NOT NULL,
    event_id bigint,
    status text NOT NULL,
    CONSTRAINT weekly_occurrences_check CHECK (((status = 'skipped'::text) OR (event_id IS NOT NULL))),
    CONSTRAINT weekly_occurrences_local_date_check CHECK (((local_date >= '1900-01-01'::date) AND (local_date <= '2200-12-31'::date))),
    CONSTRAINT weekly_occurrences_status_check CHECK ((status = ANY (ARRAY['created'::text, 'skipped'::text])))
);


--
-- Name: weekly_patterns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.weekly_patterns (
    id bigint NOT NULL,
    activity_id bigint NOT NULL,
    weekday integer NOT NULL,
    local_start time without time zone NOT NULL,
    duration_minutes integer NOT NULL,
    kind text NOT NULL,
    location text,
    active_from date NOT NULL,
    active_until date NOT NULL,
    CONSTRAINT weekly_patterns_active_from_check CHECK (((active_from >= '1900-01-01'::date) AND (active_from <= '2200-12-31'::date))),
    CONSTRAINT weekly_patterns_active_until_check CHECK (((active_until >= '1900-01-01'::date) AND (active_until <= '2200-12-31'::date))),
    CONSTRAINT weekly_patterns_check CHECK ((active_until >= active_from)),
    CONSTRAINT weekly_patterns_duration_minutes_check CHECK (((duration_minutes >= 1) AND (duration_minutes <= 1440))),
    CONSTRAINT weekly_patterns_kind_check CHECK (((length(TRIM(BOTH FROM kind)) > 0) AND (kind = lower(kind)) AND (kind <> 'cancelled'::text))),
    CONSTRAINT weekly_patterns_local_start_check CHECK ((local_start < '24:00:00'::time without time zone)),
    CONSTRAINT weekly_patterns_weekday_check CHECK (((weekday >= 1) AND (weekday <= 7)))
);


--
-- Name: weekly_patterns_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.weekly_patterns ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.weekly_patterns_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: weekly_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.weekly_requests (
    request_id uuid NOT NULL,
    operation text NOT NULL,
    result jsonb NOT NULL,
    CONSTRAINT weekly_requests_operation_check CHECK ((operation = ANY (ARRAY['pattern'::text, 'week'::text])))
);


--
-- Name: workout_blocks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workout_blocks (
    id bigint NOT NULL,
    workout_id bigint NOT NULL,
    "position" integer NOT NULL,
    name text NOT NULL,
    sets integer,
    reps integer,
    weight numeric,
    weight_unit text,
    duration_seconds integer,
    notes text,
    CONSTRAINT workout_blocks_check CHECK (((weight IS NULL) = (weight_unit IS NULL))),
    CONSTRAINT workout_blocks_duration_seconds_check CHECK ((duration_seconds > 0)),
    CONSTRAINT workout_blocks_name_check CHECK ((length(TRIM(BOTH FROM name)) > 0)),
    CONSTRAINT workout_blocks_position_check CHECK (("position" > 0)),
    CONSTRAINT workout_blocks_reps_check CHECK ((reps > 0)),
    CONSTRAINT workout_blocks_sets_check CHECK ((sets > 0)),
    CONSTRAINT workout_blocks_weight_check CHECK (((weight >= (0)::numeric) AND (weight < 'Infinity'::numeric))),
    CONSTRAINT workout_blocks_weight_unit_check CHECK ((weight_unit = ANY (ARRAY['lb'::text, 'kg'::text])))
);


--
-- Name: workout_blocks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.workout_blocks ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.workout_blocks_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: workouts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workouts (
    id bigint NOT NULL,
    performed_on date NOT NULL,
    kind text NOT NULL,
    notes text,
    request_id uuid,
    CONSTRAINT workouts_kind_check CHECK ((length(TRIM(BOTH FROM kind)) > 0))
);


--
-- Name: workouts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.workouts ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.workouts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: accounts accounts_institution_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_institution_name_key UNIQUE (institution, name);


--
-- Name: accounts accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);


--
-- Name: accounts accounts_source_ref_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_source_ref_key UNIQUE (source_ref);


--
-- Name: activities activities_member_id_activity_season_start_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activities
    ADD CONSTRAINT activities_member_id_activity_season_start_key UNIQUE (member_id, activity, season_start);


--
-- Name: activities activities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activities
    ADD CONSTRAINT activities_pkey PRIMARY KEY (id);


--
-- Name: budget_targets budget_targets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_targets
    ADD CONSTRAINT budget_targets_pkey PRIMARY KEY (category);


--
-- Name: charges charges_obligation_id_due_on_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.charges
    ADD CONSTRAINT charges_obligation_id_due_on_key UNIQUE (obligation_id, due_on);


--
-- Name: charges charges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.charges
    ADD CONSTRAINT charges_pkey PRIMARY KEY (id);


--
-- Name: charges charges_source_ref_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.charges
    ADD CONSTRAINT charges_source_ref_key UNIQUE (source_ref);


--
-- Name: commission_plans commission_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_plans
    ADD CONSTRAINT commission_plans_pkey PRIMARY KEY (id);


--
-- Name: commission_plans commission_plans_request_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_plans
    ADD CONSTRAINT commission_plans_request_id_key UNIQUE (request_id);


--
-- Name: contact_links contact_links_contact_id_member_id_activity_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_links
    ADD CONSTRAINT contact_links_contact_id_member_id_activity_id_key UNIQUE NULLS NOT DISTINCT (contact_id, member_id, activity_id);


--
-- Name: contact_requests contact_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_requests
    ADD CONSTRAINT contact_requests_pkey PRIMARY KEY (request_id);


--
-- Name: contacts contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_pkey PRIMARY KEY (id);


--
-- Name: deadlines deadlines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deadlines
    ADD CONSTRAINT deadlines_pkey PRIMARY KEY (id);


--
-- Name: document_requests document_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_requests
    ADD CONSTRAINT document_requests_pkey PRIMARY KEY (request_id);


--
-- Name: documents documents_kind_member_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_kind_member_id_key UNIQUE NULLS NOT DISTINCT (kind, member_id);


--
-- Name: documents documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_pkey PRIMARY KEY (id);


--
-- Name: events events_activity_id_starts_at_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_activity_id_starts_at_key UNIQUE (activity_id, starts_at);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);


--
-- Name: files files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_pkey PRIMARY KEY (key);


--
-- Name: gift_occasions gift_occasions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gift_occasions
    ADD CONSTRAINT gift_occasions_pkey PRIMARY KEY (id);


--
-- Name: gift_recipients gift_recipients_occasion_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gift_recipients
    ADD CONSTRAINT gift_recipients_occasion_id_id_key UNIQUE (occasion_id, id);


--
-- Name: gift_recipients gift_recipients_occasion_id_member_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gift_recipients
    ADD CONSTRAINT gift_recipients_occasion_id_member_id_name_key UNIQUE NULLS NOT DISTINCT (occasion_id, member_id, name);


--
-- Name: gift_recipients gift_recipients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gift_recipients
    ADD CONSTRAINT gift_recipients_pkey PRIMARY KEY (id);


--
-- Name: gift_requests gift_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gift_requests
    ADD CONSTRAINT gift_requests_pkey PRIMARY KEY (request_id);


--
-- Name: gifts gifts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gifts
    ADD CONSTRAINT gifts_pkey PRIMARY KEY (id);


--
-- Name: goals goals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.goals
    ADD CONSTRAINT goals_pkey PRIMARY KEY (id);


--
-- Name: goals goals_request_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.goals
    ADD CONSTRAINT goals_request_id_key UNIQUE (request_id);


--
-- Name: investment_buys investment_buys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.investment_buys
    ADD CONSTRAINT investment_buys_pkey PRIMARY KEY (id);


--
-- Name: investment_buys investment_buys_request_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.investment_buys
    ADD CONSTRAINT investment_buys_request_id_key UNIQUE (request_id);


--
-- Name: involvement involvement_member_id_activity_id_role_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.involvement
    ADD CONSTRAINT involvement_member_id_activity_id_role_key UNIQUE (member_id, activity_id, role);


--
-- Name: involvement involvement_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.involvement
    ADD CONSTRAINT involvement_pkey PRIMARY KEY (id);


--
-- Name: loan_balances loan_balances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loan_balances
    ADD CONSTRAINT loan_balances_pkey PRIMARY KEY (obligation_id, as_of);


--
-- Name: loans loans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loans
    ADD CONSTRAINT loans_pkey PRIMARY KEY (obligation_id);


--
-- Name: members members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.members
    ADD CONSTRAINT members_pkey PRIMARY KEY (id);


--
-- Name: obligation_merchant_requests obligation_merchant_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.obligation_merchant_requests
    ADD CONSTRAINT obligation_merchant_requests_pkey PRIMARY KEY (request_id);


--
-- Name: obligation_merchants obligation_merchants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.obligation_merchants
    ADD CONSTRAINT obligation_merchants_pkey PRIMARY KEY (merchant);


--
-- Name: obligations obligations_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.obligations
    ADD CONSTRAINT obligations_name_key UNIQUE (name);


--
-- Name: obligations obligations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.obligations
    ADD CONSTRAINT obligations_pkey PRIMARY KEY (id);


--
-- Name: page_revisions page_revisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.page_revisions
    ADD CONSTRAINT page_revisions_pkey PRIMARY KEY (id);


--
-- Name: pages pages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pages
    ADD CONSTRAINT pages_pkey PRIMARY KEY (id);


--
-- Name: pages pages_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pages
    ADD CONSTRAINT pages_slug_key UNIQUE (slug);


--
-- Name: receipt_charge_requests receipt_charge_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipt_charge_requests
    ADD CONSTRAINT receipt_charge_requests_pkey PRIMARY KEY (request_id);


--
-- Name: receipt_charges receipt_charges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipt_charges
    ADD CONSTRAINT receipt_charges_pkey PRIMARY KEY (source_ref);


--
-- Name: relationships relationships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.relationships
    ADD CONSTRAINT relationships_pkey PRIMARY KEY (member_id, related_id, kind);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: transactions transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_pkey PRIMARY KEY (source, source_id);


--
-- Name: upkeep_completions upkeep_completions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upkeep_completions
    ADD CONSTRAINT upkeep_completions_pkey PRIMARY KEY (id);


--
-- Name: upkeep_completions upkeep_completions_request_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upkeep_completions
    ADD CONSTRAINT upkeep_completions_request_id_key UNIQUE (request_id);


--
-- Name: upkeep_tasks upkeep_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upkeep_tasks
    ADD CONSTRAINT upkeep_tasks_pkey PRIMARY KEY (id);


--
-- Name: warranties warranties_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warranties
    ADD CONSTRAINT warranties_pkey PRIMARY KEY (id);


--
-- Name: warranties warranties_source_ref_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warranties
    ADD CONSTRAINT warranties_source_ref_key UNIQUE (source_ref);


--
-- Name: warranty_requests warranty_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warranty_requests
    ADD CONSTRAINT warranty_requests_pkey PRIMARY KEY (request_id);


--
-- Name: weekly_occurrences weekly_occurrences_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.weekly_occurrences
    ADD CONSTRAINT weekly_occurrences_event_id_key UNIQUE (event_id);


--
-- Name: weekly_occurrences weekly_occurrences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.weekly_occurrences
    ADD CONSTRAINT weekly_occurrences_pkey PRIMARY KEY (pattern_id, local_date);


--
-- Name: weekly_patterns weekly_patterns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.weekly_patterns
    ADD CONSTRAINT weekly_patterns_pkey PRIMARY KEY (id);


--
-- Name: weekly_requests weekly_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.weekly_requests
    ADD CONSTRAINT weekly_requests_pkey PRIMARY KEY (request_id);


--
-- Name: workout_blocks workout_blocks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workout_blocks
    ADD CONSTRAINT workout_blocks_pkey PRIMARY KEY (id);


--
-- Name: workout_blocks workout_blocks_workout_id_position_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workout_blocks
    ADD CONSTRAINT workout_blocks_workout_id_position_key UNIQUE (workout_id, "position");


--
-- Name: workouts workouts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workouts
    ADD CONSTRAINT workouts_pkey PRIMARY KEY (id);


--
-- Name: workouts workouts_request_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workouts
    ADD CONSTRAINT workouts_request_id_key UNIQUE (request_id);


--
-- Name: commission_plans_effective; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX commission_plans_effective ON public.commission_plans USING btree (effective_on DESC, id DESC);


--
-- Name: contact_links_activity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contact_links_activity ON public.contact_links USING btree (activity_id) WHERE (activity_id IS NOT NULL);


--
-- Name: contact_links_member; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contact_links_member ON public.contact_links USING btree (member_id) WHERE (member_id IS NOT NULL);


--
-- Name: gifts_occasion_recipient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gifts_occasion_recipient ON public.gifts USING btree (occasion_id, recipient_id);


--
-- Name: goals_active_area_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX goals_active_area_idx ON public.goals USING btree (area, id) WHERE (status = 'active'::text);


--
-- Name: obligation_merchants_obligation_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX obligation_merchants_obligation_id_idx ON public.obligation_merchants USING btree (obligation_id);


--
-- Name: page_revisions_history; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX page_revisions_history ON public.page_revisions USING btree (page_id, saved_at DESC, id DESC);


--
-- Name: pages_search; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pages_search ON public.pages USING gin (search) WHERE (deleted_at IS NULL);


--
-- Name: receipt_charges_obligation_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX receipt_charges_obligation_id_idx ON public.receipt_charges USING btree (obligation_id);


--
-- Name: transactions_posted_on_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_posted_on_idx ON public.transactions USING btree (posted_on);


--
-- Name: upkeep_completions_latest; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX upkeep_completions_latest ON public.upkeep_completions USING btree (task_id, completed_on DESC);


--
-- Name: workouts_performed_on_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workouts_performed_on_idx ON public.workouts USING btree (performed_on DESC, id DESC);


--
-- Name: activities activities_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activities
    ADD CONSTRAINT activities_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.members(id);


--
-- Name: charges charges_obligation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.charges
    ADD CONSTRAINT charges_obligation_id_fkey FOREIGN KEY (obligation_id) REFERENCES public.obligations(id);


--
-- Name: commission_plans commission_plans_page_slug_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_plans
    ADD CONSTRAINT commission_plans_page_slug_fkey FOREIGN KEY (page_slug) REFERENCES public.pages(slug);


--
-- Name: contact_links contact_links_activity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_links
    ADD CONSTRAINT contact_links_activity_id_fkey FOREIGN KEY (activity_id) REFERENCES public.activities(id);


--
-- Name: contact_links contact_links_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_links
    ADD CONSTRAINT contact_links_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: contact_links contact_links_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_links
    ADD CONSTRAINT contact_links_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.members(id);


--
-- Name: deadlines deadlines_obligation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deadlines
    ADD CONSTRAINT deadlines_obligation_id_fkey FOREIGN KEY (obligation_id) REFERENCES public.obligations(id);


--
-- Name: documents documents_file_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_file_key_fkey FOREIGN KEY (file_key) REFERENCES public.files(key);


--
-- Name: documents documents_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.members(id);


--
-- Name: events events_activity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_activity_id_fkey FOREIGN KEY (activity_id) REFERENCES public.activities(id);


--
-- Name: files files_source_page_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_source_page_id_fkey FOREIGN KEY (source_page_id) REFERENCES public.pages(id);


--
-- Name: gift_recipients gift_recipients_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gift_recipients
    ADD CONSTRAINT gift_recipients_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.members(id);


--
-- Name: gift_recipients gift_recipients_occasion_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gift_recipients
    ADD CONSTRAINT gift_recipients_occasion_id_fkey FOREIGN KEY (occasion_id) REFERENCES public.gift_occasions(id);


--
-- Name: gifts gifts_buyer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gifts
    ADD CONSTRAINT gifts_buyer_id_fkey FOREIGN KEY (buyer_id) REFERENCES public.members(id);


--
-- Name: gifts gifts_occasion_id_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gifts
    ADD CONSTRAINT gifts_occasion_id_recipient_id_fkey FOREIGN KEY (occasion_id, recipient_id) REFERENCES public.gift_recipients(occasion_id, id);


--
-- Name: goals goals_page_slug_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.goals
    ADD CONSTRAINT goals_page_slug_fkey FOREIGN KEY (page_slug) REFERENCES public.pages(slug);


--
-- Name: involvement involvement_activity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.involvement
    ADD CONSTRAINT involvement_activity_id_fkey FOREIGN KEY (activity_id) REFERENCES public.activities(id);


--
-- Name: involvement involvement_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.involvement
    ADD CONSTRAINT involvement_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.members(id);


--
-- Name: loan_balances loan_balances_obligation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loan_balances
    ADD CONSTRAINT loan_balances_obligation_id_fkey FOREIGN KEY (obligation_id) REFERENCES public.loans(obligation_id);


--
-- Name: loans loans_obligation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loans
    ADD CONSTRAINT loans_obligation_id_fkey FOREIGN KEY (obligation_id) REFERENCES public.obligations(id);


--
-- Name: obligation_merchants obligation_merchants_obligation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.obligation_merchants
    ADD CONSTRAINT obligation_merchants_obligation_id_fkey FOREIGN KEY (obligation_id) REFERENCES public.obligations(id) ON DELETE CASCADE;


--
-- Name: page_revisions page_revisions_page_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.page_revisions
    ADD CONSTRAINT page_revisions_page_id_fkey FOREIGN KEY (page_id) REFERENCES public.pages(id);


--
-- Name: receipt_charges receipt_charges_obligation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipt_charges
    ADD CONSTRAINT receipt_charges_obligation_id_fkey FOREIGN KEY (obligation_id) REFERENCES public.obligations(id) ON DELETE CASCADE;


--
-- Name: relationships relationships_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.relationships
    ADD CONSTRAINT relationships_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.members(id);


--
-- Name: relationships relationships_related_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.relationships
    ADD CONSTRAINT relationships_related_id_fkey FOREIGN KEY (related_id) REFERENCES public.members(id);


--
-- Name: upkeep_completions upkeep_completions_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upkeep_completions
    ADD CONSTRAINT upkeep_completions_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.upkeep_tasks(id);


--
-- Name: warranties warranties_file_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warranties
    ADD CONSTRAINT warranties_file_key_fkey FOREIGN KEY (file_key) REFERENCES public.files(key);


--
-- Name: weekly_occurrences weekly_occurrences_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.weekly_occurrences
    ADD CONSTRAINT weekly_occurrences_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id);


--
-- Name: weekly_occurrences weekly_occurrences_pattern_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.weekly_occurrences
    ADD CONSTRAINT weekly_occurrences_pattern_id_fkey FOREIGN KEY (pattern_id) REFERENCES public.weekly_patterns(id);


--
-- Name: weekly_patterns weekly_patterns_activity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.weekly_patterns
    ADD CONSTRAINT weekly_patterns_activity_id_fkey FOREIGN KEY (activity_id) REFERENCES public.activities(id);


--
-- Name: workout_blocks workout_blocks_workout_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workout_blocks
    ADD CONSTRAINT workout_blocks_workout_id_fkey FOREIGN KEY (workout_id) REFERENCES public.workouts(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict dbmate


--
-- Dbmate schema migrations
--

INSERT INTO public.schema_migrations (version) VALUES
    ('20261108120000'),
    ('20261108180000'),
    ('20261108230000'),
    ('20261109120000'),
    ('20261109130000'),
    ('20261109180000'),
    ('20261110000000'),
    ('20261110120000'),
    ('20261110150000'),
    ('20261110160000'),
    ('20261110170000'),
    ('20261110180000'),
    ('20261110190000'),
    ('20261110200000'),
    ('20261110210000'),
    ('20261110220000'),
    ('20261110230000'),
    ('20261111010000'),
    ('20261111020000'),
    ('20261111030000'),
    ('20261111040000'),
    ('20261111050000'),
    ('20261111060000'),
    ('20261111070000');
