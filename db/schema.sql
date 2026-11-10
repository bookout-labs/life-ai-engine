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
    CONSTRAINT accounts_institution_check CHECK (((institution = btrim(institution)) AND (institution ~ '\S'::text))),
    CONSTRAINT accounts_kind_check CHECK ((kind = ANY (ARRAY['bank'::text, 'card'::text, 'investment'::text, 'loan'::text]))),
    CONSTRAINT accounts_name_check CHECK (((name = btrim(name)) AND (name ~ '\S'::text))),
    CONSTRAINT accounts_scope_check CHECK ((scope = ANY (ARRAY['household'::text, 'business'::text, 'unknown'::text]))),
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
-- Name: deadlines deadlines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deadlines
    ADD CONSTRAINT deadlines_pkey PRIMARY KEY (id);


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
-- Name: goals_active_area_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX goals_active_area_idx ON public.goals USING btree (area, id) WHERE (status = 'active'::text);


--
-- Name: page_revisions_history; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX page_revisions_history ON public.page_revisions USING btree (page_id, saved_at DESC, id DESC);


--
-- Name: pages_search; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pages_search ON public.pages USING gin (search) WHERE (deleted_at IS NULL);


--
-- Name: transactions_posted_on_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_posted_on_idx ON public.transactions USING btree (posted_on);


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
-- Name: deadlines deadlines_obligation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deadlines
    ADD CONSTRAINT deadlines_obligation_id_fkey FOREIGN KEY (obligation_id) REFERENCES public.obligations(id);


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
-- Name: page_revisions page_revisions_page_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.page_revisions
    ADD CONSTRAINT page_revisions_page_id_fkey FOREIGN KEY (page_id) REFERENCES public.pages(id);


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
    ('20261110180000');
