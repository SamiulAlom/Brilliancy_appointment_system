-- Brilliancy Appointments: initial schema.
-- Run once in the appointments Supabase project (SQL Editor, as project owner). Standalone: no other app's tables needed.
-- Browsers never read or write these tables; only the Worker (secret key / service_role) does.
begin;

-- ---------- Administrators (Supabase Auth users allowed into /admin) ----------
-- Add one with: insert into public.appt_admins (auth_user_id, full_name)
--               select id, 'Your Name' from auth.users where email = 'you@example.com';
create table if not exists public.appt_admins (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique references auth.users(id) on delete cascade,
  full_name text not null check (length(trim(full_name)) between 1 and 120),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------- Settings (single row) ----------
create table if not exists public.appt_settings (
  id smallint primary key default 1 check (id = 1),
  open_time time not null default '10:00',
  close_time time not null default '19:00',
  -- 0 = Sunday ... 6 = Saturday (same numbering as attendance weekly_holiday). Friday (5) closed.
  working_days smallint[] not null default '{6,0,1,2,3,4}',
  slot_step_min integer not null default 30 check (slot_step_min between 5 and 240),
  min_notice_min integer not null default 120 check (min_notice_min between 0 and 10080),
  max_days_ahead integer not null default 30 check (max_days_ahead between 1 and 180),
  modes text[] not null default '{office,meet,phone}',
  office_address text not null default '201–202 BUET Market, Polashi, Dhaka-1000',
  calendar_id text not null default 'primary',
  notify_email text not null default 'brilliancycomms@gmail.com',
  updated_at timestamptz not null default now(),
  check (close_time > open_time),
  check (modes <@ array['office','meet','phone']::text[] and cardinality(modes) >= 1)
);
insert into public.appt_settings (id) values (1) on conflict (id) do nothing;

-- ---------- Services ----------
create table if not exists public.appt_services (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  description text not null default '' check (length(description) <= 600),
  duration_min integer not null default 30 check (duration_min between 15 and 480),
  sort_order integer not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
insert into public.appt_services (name, description, duration_min, sort_order)
select * from (values
  ('General consultation', 'Discuss your project, timeline and which service fits.', 30, 10),
  ('Manuscript writing & correction', 'Journal manuscript drafting, editing, correction and formatting.', 45, 20),
  ('Research proposal / systematic review', 'Proposal writing, literature review and SLR planning.', 45, 30),
  ('Thesis & document formatting', 'University template, references, tables and figures.', 30, 40),
  ('CV preparation', 'Academic or professional CV.', 30, 50),
  ('Scholarship application support', 'MEXT, DAAD, Erasmus and other applications: SOP, CV, documents.', 45, 60),
  ('GIS / spatial analysis consultancy', 'Mapping, spatial analysis and GIS-based research.', 45, 70)
) as v(name, description, duration_min, sort_order)
where not exists (select 1 from public.appt_services);

-- ---------- Office off days ----------
create table if not exists public.appt_off_days (
  id uuid primary key default gen_random_uuid(),
  from_date date not null,
  to_date date not null,
  reason text not null default '' check (length(reason) <= 200),
  created_at timestamptz not null default now(),
  check (to_date >= from_date and to_date - from_date <= 366)
);

-- ---------- Referring employees (the "Referred by" list shown to clients) ----------
-- Seeded from the communication/consultant contact list (supabase/private/002_seed_referrers.sql).
-- Email/phone are private: used only to notify the referrer, never shown on the public site.
create table if not exists public.appt_referrers (
  code text primary key check (code ~ '^[A-Za-z0-9-]{2,30}$'),
  full_name text not null check (length(trim(full_name)) between 1 and 120),
  designation text not null default '' check (length(designation) <= 120),
  email text check (email is null or email ~* '^[^\s@]+@[^\s@]+\.[^\s@]+$'),
  phone text not null default '' check (length(phone) <= 30),
  notify boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------- Office Google Calendar connection (single row) ----------
create table if not exists public.appt_google (
  id smallint primary key default 1 check (id = 1),
  google_email text,
  refresh_token_enc text,          -- AES-GCM ciphertext; key lives only in the Worker secret TOKEN_ENCRYPTION_KEY
  connected_at timestamptz,
  connected_by uuid references public.appt_admins(id) on delete set null,
  last_ok_at timestamptz,
  last_error text
);
insert into public.appt_google (id) values (1) on conflict (id) do nothing;

-- ---------- Bookings ----------
create table if not exists public.appt_bookings (
  id uuid primary key default gen_random_uuid(),
  idempotency_key uuid not null unique,
  service_id uuid references public.appt_services(id) on delete set null,
  service_name text not null,
  duration_min integer not null check (duration_min between 15 and 480),
  mode text not null check (mode in ('office','meet','phone')),
  start_at timestamptz not null,
  end_at timestamptz not null,
  status text not null default 'calendar_pending'
    check (status in ('calendar_pending','confirmed','completed','no_show','cancelled')),
  client_name text not null check (length(trim(client_name)) between 2 and 120),
  client_phone text not null check (client_phone ~ '^\+?[0-9]{8,15}$'),
  client_email text not null check (client_email ~* '^[^\s@]+@[^\s@]+\.[^\s@]+$' and length(client_email) <= 200),
  client_institution text not null default '' check (length(client_institution) <= 200),
  client_note text not null default '' check (length(client_note) <= 1500),
  referrer_code text references public.appt_referrers(code) on update cascade,
  referrer_source text not null default 'none' check (referrer_source in ('link','dropdown','other','none')),
  referrer_other text not null default '' check (length(referrer_other) <= 120),
  google_event_id text,
  meet_link text,
  calendar_attempts integer not null default 0,
  calendar_error text,
  calendar_lease_until timestamptz,
  manage_token_hash text not null unique,
  internal_note text not null default '' check (length(internal_note) <= 2000),
  cancelled_at timestamptz,
  cancelled_by text check (cancelled_by in ('client','admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_at > start_at),
  check (referrer_source <> 'other' or length(trim(referrer_other)) > 0),
  -- One appointment at a time on the office calendar: active bookings can never overlap.
  constraint appt_bookings_no_overlap exclude using gist (tstzrange(start_at, end_at, '[)') with &&)
    where (status in ('calendar_pending','confirmed'))
);
create index if not exists appt_bookings_start_idx on public.appt_bookings(start_at);
create index if not exists appt_bookings_referrer_idx on public.appt_bookings(referrer_code, start_at);
create index if not exists appt_bookings_phone_idx on public.appt_bookings(client_phone, start_at);

-- ---------- Email outbox (Classroom pattern) ----------
create table if not exists public.appt_email_outbox (
  id bigserial primary key,
  booking_id uuid not null references public.appt_bookings(id) on delete cascade,
  kind text not null check (kind in ('confirmation','reminder','cancellation','admin_alert','referrer_alert')),
  to_email text not null,
  to_name text not null default '',
  status text not null default 'pending' check (status in ('pending','sending','accepted','failed','needs_review','skipped')),
  attempts integer not null default 0,
  idem_key uuid not null default gen_random_uuid(),
  not_before timestamptz not null default now(),
  lease_until timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  unique (booking_id, kind, to_email)
);
create index if not exists appt_email_outbox_pending_idx on public.appt_email_outbox(status, not_before);

-- ---------- Audit ----------
create table if not exists public.appt_audit (
  id bigserial primary key,
  actor_employee_id uuid references public.appt_admins(id) on delete set null,
  action text not null,
  booking_id uuid references public.appt_bookings(id) on delete set null,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- ---------- Lock down: no browser access ----------
alter table public.appt_admins enable row level security;
alter table public.appt_settings enable row level security;
alter table public.appt_services enable row level security;
alter table public.appt_off_days enable row level security;
alter table public.appt_referrers enable row level security;
alter table public.appt_google enable row level security;
alter table public.appt_bookings enable row level security;
alter table public.appt_email_outbox enable row level security;
alter table public.appt_audit enable row level security;
revoke all on public.appt_admins, public.appt_settings, public.appt_services, public.appt_off_days, public.appt_referrers, public.appt_google,
  public.appt_bookings, public.appt_email_outbox, public.appt_audit from anon, authenticated;
grant all on public.appt_admins, public.appt_settings, public.appt_services, public.appt_off_days, public.appt_referrers, public.appt_google,
  public.appt_bookings, public.appt_email_outbox, public.appt_audit to service_role;
grant usage, select on sequence public.appt_email_outbox_id_seq, public.appt_audit_id_seq to service_role;

-- ---------- Worker helper functions (service_role only) ----------

-- Admin check for a Supabase Auth user.
create or replace function public.appt_admin_for_user(p_auth_user_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce((select jsonb_build_object('id', a.id, 'full_name', a.full_name)
    from public.appt_admins a where a.auth_user_id = p_auth_user_id and a.active), '{}'::jsonb);
$$;

-- Claim pending emails with a lease so overlapping Cron runs never send twice.
create or replace function public.appt_claim_emails(p_limit integer default 10)
returns setof public.appt_email_outbox language plpgsql security definer set search_path = '' as $$
begin
  return query
  update public.appt_email_outbox o set status = 'sending', attempts = o.attempts + 1, lease_until = now() + interval '2 minutes'
  where o.id in (
    select x.id from public.appt_email_outbox x
    where (x.status = 'pending' and x.not_before <= now())
       or (x.status = 'sending' and x.lease_until < now())
    order by x.id limit greatest(1, least(p_limit, 50))
    for update skip locked)
  returning o.*;
end $$;

-- Claim bookings whose Google Calendar event still needs creating (or deleting after cancellation).
create or replace function public.appt_claim_calendar(p_limit integer default 5)
returns setof public.appt_bookings language plpgsql security definer set search_path = '' as $$
begin
  return query
  update public.appt_bookings b set calendar_attempts = b.calendar_attempts + 1, calendar_lease_until = now() + interval '2 minutes'
  where b.id in (
    select x.id from public.appt_bookings x
    where ((x.status = 'calendar_pending' and x.end_at > now())
        or (x.status = 'cancelled' and x.google_event_id is not null))
      and x.calendar_attempts < 30
      and (x.calendar_lease_until is null or x.calendar_lease_until < now())
    order by x.start_at limit greatest(1, least(p_limit, 20))
    for update skip locked)
  returning b.*;
end $$;

-- Queue ~24 h reminders for confirmed bookings (only if booked more than 26 h ahead).
create or replace function public.appt_queue_reminders()
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  insert into public.appt_email_outbox (booking_id, kind, to_email, to_name)
  select b.id, 'reminder', b.client_email, b.client_name from public.appt_bookings b
  where b.status = 'confirmed'
    and b.start_at between now() + interval '1 hour' and now() + interval '24 hours'
    and b.start_at - b.created_at > interval '26 hours'
  on conflict (booking_id, kind, to_email) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- Referral report for a date range (by appointment date, Asia/Dhaka).
create or replace function public.appt_referral_report(p_from date, p_to date)
returns table (referrer_code text, full_name text, referrer_label text,
               total bigint, upcoming bigint, completed bigint, no_show bigint, cancelled bigint)
language sql stable security definer set search_path = '' as $$
  select b.referrer_code, r.full_name,
    case when b.referrer_source = 'other' then 'Other: ' || b.referrer_other
         when b.referrer_code is null then 'No referrer' else r.full_name end,
    count(*),
    count(*) filter (where b.status in ('confirmed','calendar_pending')),
    count(*) filter (where b.status = 'completed'),
    count(*) filter (where b.status = 'no_show'),
    count(*) filter (where b.status = 'cancelled')
  from public.appt_bookings b left join public.appt_referrers r on r.code = b.referrer_code
  where (b.start_at at time zone 'Asia/Dhaka')::date between p_from and p_to
  group by 1, 2, 3 order by 4 desc, 3;
$$;

revoke all on function public.appt_admin_for_user(uuid), public.appt_claim_emails(integer),
  public.appt_claim_calendar(integer), public.appt_queue_reminders(), public.appt_referral_report(date, date)
  from public, anon, authenticated;
grant execute on function public.appt_admin_for_user(uuid), public.appt_claim_emails(integer),
  public.appt_claim_calendar(integer), public.appt_queue_reminders(), public.appt_referral_report(date, date)
  to service_role;

commit;

select
  to_regclass('public.appt_bookings') is not null as bookings_table_ready,
  (select count(*) from public.appt_services) as services_count,
  exists(select 1 from pg_constraint where conname = 'appt_bookings_no_overlap') as overlap_guard_ready;
