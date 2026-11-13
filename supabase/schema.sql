-- JOSH platform — production PostgreSQL schema for Supabase.
--
-- Apply with: psql "$DATABASE_URL" -f supabase/schema.sql
-- (or paste into the Supabase SQL editor).
--
-- Security model
--   * Creators may read only their own earnings, withdrawals and wallet address.
--   * Only profiles with role = 'admin' may read platform revenue, all creators'
--     earnings, all withdrawals, audit logs and OAuth token metadata.
--   * oauth_tokens has RLS enabled with no policies, so only the service role
--     (server-side) can ever touch encrypted Google tokens.
--   * Writes for financial records go through the server using the service role;
--     no policy grants direct INSERT/UPDATE to authenticated users.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- profiles
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  display_name text not null default '',
  role text not null default 'creator' check (role in ('creator','admin')),
  created_at timestamptz not null default now()
);

create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'
  );
$$;

alter table public.profiles enable row level security;

create policy "profiles self read" on public.profiles
  for select using (id = auth.uid() or public.is_admin());
create policy "profiles self update" on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid() and role = 'creator');

-- ------------------------------------------------------------ wallet addresses
create table if not exists public.wallet_addresses (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  address text not null,
  network text not null default 'BEP20',
  updated_at timestamptz not null default now()
);

alter table public.wallet_addresses enable row level security;
create policy "wallet self read" on public.wallet_addresses
  for select using (user_id = auth.uid() or public.is_admin());

-- --------------------------------------------------------------- ad revenue
create table if not exists public.ad_revenue_daily (
  period_date date not null,
  source text not null default 'adsense',
  currency text not null default 'USD',
  estimated_earnings numeric(14,6) not null default 0,
  finalized_earnings numeric(14,6) not null default 0,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  page_views bigint not null default 0,
  is_manual boolean not null default false,
  note text,
  updated_at timestamptz not null default now(),
  primary key (period_date, source)
);

alter table public.ad_revenue_daily enable row level security;
create policy "revenue admin read" on public.ad_revenue_daily
  for select using (public.is_admin());

create table if not exists public.adsense_sync_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null check (status in ('running','ok','error')),
  message text,
  rows_upserted integer not null default 0
);

alter table public.adsense_sync_runs enable row level security;
create policy "sync runs admin read" on public.adsense_sync_runs
  for select using (public.is_admin());

-- Encrypted OAuth tokens: RLS on, no policies => service role only.
create table if not exists public.oauth_tokens (
  provider text primary key,
  refresh_token_enc text,
  access_token_enc text,
  access_token_expires_at timestamptz,
  scope text,
  account_id text,
  updated_at timestamptz not null default now()
);
alter table public.oauth_tokens enable row level security;

-- ----------------------------------------------------------- creator metrics
create table if not exists public.creator_metrics_daily (
  user_id uuid not null references public.profiles(id) on delete cascade,
  period_date date not null,
  eligible_views bigint not null default 0,
  verified boolean not null default false,
  source text not null default 'manual',
  updated_at timestamptz not null default now(),
  primary key (user_id, period_date)
);

alter table public.creator_metrics_daily enable row level security;
create policy "metrics self read" on public.creator_metrics_daily
  for select using (user_id = auth.uid() or public.is_admin());

-- ---------------------------------------------------------- creator earnings
create table if not exists public.creator_earnings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  period text not null,                     -- 'YYYY-MM'
  gross_pool numeric(14,6) not null,
  share_rate numeric(6,4) not null,
  amount numeric(14,6) not null,
  eligible_views bigint not null,
  state text not null default 'finalized' check (state in ('estimated','finalized')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, period)                  -- duplicate creator credits impossible
);

alter table public.creator_earnings enable row level security;
create policy "earnings self read" on public.creator_earnings
  for select using (user_id = auth.uid() or public.is_admin());

-- --------------------------------------------------------------- withdrawals
create table if not exists public.withdrawals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  amount numeric(14,6) not null check (amount >= 0.5),
  address text not null,
  network text not null default 'BEP20',
  status text not null default 'pending'
    check (status in ('pending','approved','processing','paid','failed','rejected')),
  tx_hash text,
  provider_ref text,
  rejection_reason text,
  verification_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  decided_by uuid references public.profiles(id),
  decided_at timestamptz,
  verified_at timestamptz
);

create unique index if not exists ux_withdrawals_tx
  on public.withdrawals (tx_hash) where tx_hash is not null;

alter table public.withdrawals enable row level security;
create policy "withdrawals self read" on public.withdrawals
  for select using (user_id = auth.uid() or public.is_admin());

-- ----------------------------------------------------------------- audit log
create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid,
  action text not null,
  target text,
  metadata jsonb,
  created_at timestamptz not null default now()
);

alter table public.audit_logs enable row level security;
create policy "audit admin read" on public.audit_logs
  for select using (public.is_admin());

-- Keep audit rows immutable even for the service role via trigger.
create or replace function public.block_audit_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'audit_logs is append-only';
end;
$$;

drop trigger if exists audit_no_update on public.audit_logs;
create trigger audit_no_update before update or delete on public.audit_logs
  for each row execute function public.block_audit_mutation();

create index if not exists ix_earnings_user_period on public.creator_earnings (user_id, period);
create index if not exists ix_withdrawals_status on public.withdrawals (status, created_at desc);
create index if not exists ix_revenue_period on public.ad_revenue_daily (period_date);
