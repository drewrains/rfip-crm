-- =====================================================================
-- RFIP CRM — database schema and permission rules (Supabase / Postgres)
--
-- Run once in Supabase: SQL Editor → New query → paste this file → Run.
-- Safe to re-run: it only creates what is missing and replaces functions
-- and policies.
--
-- Who sees what:
--   * Only signed-in @rfip.com users with an active profile see anything.
--   * Accounts, contacts and go/no-go settings: everyone on the team.
--   * Deals (and their notes, sharing list and tasks): the deal owner,
--     the people the deal is shared with, and admins.
--   * Admins (Drew) see and edit everything, manage users and settings.
-- =====================================================================

-- ---------- settings you may change ----------------------------------
-- Allowed email domain(s) and the people who start as admins.
create table if not exists public.app_config (
  id            boolean primary key default true check (id),
  allowed_domains text[] not null default array['rfip.com'],
  admin_emails  text[] not null default array['drains@rfip.com']
);
insert into public.app_config (id) values (true) on conflict (id) do nothing;

-- ---------- people ----------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null unique,
  full_name   text not null default '',
  role        text not null default 'rep' check (role in ('admin','rep')),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- ---------- reference data shared with the whole team -----------------
create table if not exists public.accounts (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  type        text,
  vertical    text,
  city        text,
  state       text,
  website     text,
  notes       text,
  created_by  uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists accounts_name_uq on public.accounts (lower(trim(name)));

create table if not exists public.contacts (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid references public.accounts(id) on delete set null,
  name        text not null,
  title       text,
  email       text,
  phone       text,
  notes       text,
  created_by  uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists contacts_account_idx on public.contacts(account_id);

-- ---------- deals and who can see them -------------------------------
create table if not exists public.deals (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  account_id   uuid references public.accounts(id) on delete set null,
  contact_id   uuid references public.contacts(id) on delete set null,
  owner_id     uuid not null references public.profiles(id) default auth.uid(),
  stage        text not null default 'lead'
               check (stage in ('lead','qualifying','proposal','submitted','negotiation','won','lost','nobid')),
  value        numeric(14,2),
  probability  integer check (probability between 0 and 100),
  bid_due      date,
  close_date   date,
  rfp_no       text,
  source       text,
  vertical     text,
  services     text[] not null default '{}',
  description  text,
  gng          jsonb not null default '{"scores":{}}'::jsonb,
  created_by   uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists deals_owner_idx on public.deals(owner_id);
create index if not exists deals_account_idx on public.deals(account_id);

create table if not exists public.deal_members (
  deal_id   uuid not null references public.deals(id) on delete cascade,
  user_id   uuid not null references public.profiles(id) on delete cascade,
  added_by  uuid references public.profiles(id) on delete set null default auth.uid(),
  added_at  timestamptz not null default now(),
  primary key (deal_id, user_id)
);
create index if not exists deal_members_user_idx on public.deal_members(user_id);

create table if not exists public.deal_notes (
  id         uuid primary key default gen_random_uuid(),
  deal_id    uuid not null references public.deals(id) on delete cascade,
  author_id  uuid references public.profiles(id) on delete set null default auth.uid(),
  body       text not null,
  system     boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists deal_notes_deal_idx on public.deal_notes(deal_id);

create table if not exists public.tasks (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  due         date,
  done        boolean not null default false,
  done_at     timestamptz,
  deal_id     uuid references public.deals(id) on delete cascade,
  assignee_id uuid references public.profiles(id) on delete set null default auth.uid(),
  notes       text,
  created_by  uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists tasks_deal_idx on public.tasks(deal_id);
create index if not exists tasks_assignee_idx on public.tasks(assignee_id);

-- Go/no-go criteria (one row, edited by admins)
create table if not exists public.gng_config (
  id         boolean primary key default true check (id),
  config     jsonb not null,
  updated_at timestamptz not null default now()
);
insert into public.gng_config (id, config) values (true, '{
  "threshold": {"go": 70, "review": 55},
  "criteria": [
    {"id":"fit","name":"Fits our service lines and self-perform crews","weight":20},
    {"id":"relationship","name":"Relationship with the owner or GC","weight":15},
    {"id":"win","name":"Realistic chance to win against the field","weight":15},
    {"id":"margin","name":"Margin potential","weight":15},
    {"id":"capacity","name":"Crew and PM capacity in the schedule window","weight":15},
    {"id":"risk","name":"Contract, bonding, licensing and schedule risk (5 = low risk)","weight":10},
    {"id":"strategic","name":"Strategic value: vertical, reference, follow-on work","weight":10}
  ]}'::jsonb)
on conflict (id) do nothing;

-- ---------- history & results (added Oct 2026) -----------------------
-- Why a deal was won, lost or not bid, and who beat us.
alter table public.deals add column if not exists outcome_reason     text;
alter table public.deals add column if not exists winning_competitor text;
alter table public.deals add column if not exists winning_price      numeric(14,2);
alter table public.deals add column if not exists outcome_notes      text;

-- What kind of touch a note records.
alter table public.deal_notes add column if not exists kind text not null default 'note';
do $$ begin
  alter table public.deal_notes add constraint deal_notes_kind_chk check (kind in ('note','call','meeting','site_visit','email'));
exception when duplicate_object then null; end $$;

-- Yearly won-revenue targets: one company row (user_id null) and one per person.
create table if not exists public.targets (
  id         uuid primary key default gen_random_uuid(),
  year       integer not null check (year between 2000 and 2100),
  user_id    uuid references public.profiles(id) on delete cascade,
  won_value  numeric(14,2) not null default 0,
  updated_at timestamptz not null default now()
);
create unique index if not exists targets_year_user_uq
  on public.targets (year, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- Who reports to whom (a manager sees their reports' deals, tasks and targets).
alter table public.profiles add column if not exists manager_id uuid references public.profiles(id) on delete set null;
create index if not exists profiles_manager_idx on public.profiles(manager_id);

-- Deal team roles (the deal owner is the account manager) and each person's usual job.
alter table public.deal_members add column if not exists role text not null default 'support';
do $$ begin
  alter table public.deal_members add constraint deal_members_role_chk check (role in ('account_manager','sales_engineer','estimator','support'));
exception when duplicate_object then null; end $$;
alter table public.profiles add column if not exists job_role text;
do $$ begin
  alter table public.profiles add constraint profiles_job_role_chk check (job_role is null or job_role in ('account_manager','sales_engineer','estimator','manager','other'));
exception when duplicate_object then null; end $$;

-- ---------- helper functions (run with owner rights so policies don't loop)
create or replace function public.is_active_user() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and active);
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and active and role = 'admin');
$$;

-- True when person u reports to the signed-in user, directly or further down the chain.
create or replace function public.reports_to_me(u uuid) returns boolean
language sql stable security definer set search_path = public as $$
  with recursive chain(id, manager_id, depth) as (
    select id, manager_id, 1 from profiles where id = u
    union all
    select p.id, p.manager_id, c.depth + 1 from profiles p join chain c on p.id = c.manager_id where c.depth < 10)
  select u is not null and u <> auth.uid() and public.is_active_user()
     and exists (select 1 from chain where manager_id = auth.uid());
$$;

create or replace function public.can_see_deal(d uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin()
      or (public.is_active_user() and (
            exists (select 1 from deals where id = d and (owner_id = auth.uid() or public.reports_to_me(owner_id)))
         or exists (select 1 from deal_members where deal_id = d and (user_id = auth.uid() or public.reports_to_me(user_id)))));
$$;

create or replace function public.can_manage_deal(d uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin()
      or (public.is_active_user() and exists (select 1 from deals where id = d and (owner_id = auth.uid() or public.reports_to_me(owner_id))));
$$;

-- ---------- new sign-ins become profiles; only allowed domains get in ---
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  cfg app_config;
  em  text := lower(coalesce(new.email, ''));
  dom text := split_part(em, '@', 2);
begin
  select * into cfg from app_config where id;
  if em = '' or not (dom = any (cfg.allowed_domains)) then
    raise exception 'Sign-in is limited to RFIP accounts.';
  end if;
  insert into profiles (id, email, full_name, role)
  values (
    new.id, em,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(em,'@',1)),
    case when em = any (cfg.admin_emails) then 'admin' else 'rep' end)
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Give a profile to any RFIP login that was created before this script ran.
insert into public.profiles (id, email, full_name, role)
select u.id, lower(u.email),
       coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', split_part(lower(u.email),'@',1)),
       case when lower(u.email) = any (c.admin_emails) then 'admin' else 'rep' end
from auth.users u cross join public.app_config c
where u.email is not null and split_part(lower(u.email), '@', 2) = any (c.allowed_domains)
on conflict (id) do nothing;

-- Reps may change only their own display name; role/active/email are admin-only.
create or replace function public.guard_profile_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    if new.role is distinct from old.role or new.active is distinct from old.active
       or new.email is distinct from old.email or new.id is distinct from old.id
       or new.manager_id is distinct from old.manager_id or new.job_role is distinct from old.job_role then
      raise exception 'Only an admin can change roles or access.';
    end if;
  end if;
  -- nobody can report to themselves, directly or around a loop
  if new.manager_id is not null and (new.manager_id = new.id or exists (
       with recursive up(id, manager_id, depth) as (
         select id, manager_id, 1 from profiles where id = new.manager_id
         union all select p.id, p.manager_id, u.depth + 1 from profiles p join up u on p.id = u.manager_id where u.depth < 20)
       select 1 from up where manager_id = new.id)) then
    raise exception 'That reporting line would loop back to this person.';
  end if;
  -- never leave the CRM without an active admin
  if old.role = 'admin' and (new.role <> 'admin' or not new.active)
     and not exists (select 1 from profiles where role='admin' and active and id <> old.id) then
    raise exception 'There must be at least one active admin.';
  end if;
  return new;
end $$;
drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard before update on public.profiles
  for each row execute function public.guard_profile_update();

-- Only the deal owner or an admin can hand a deal to someone else.
create or replace function public.guard_deal_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.owner_id is distinct from old.owner_id and not public.can_manage_deal(old.id) then
    raise exception 'Only the deal owner or an admin can reassign a deal.';
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists deals_guard on public.deals;
create trigger deals_guard before update on public.deals
  for each row execute function public.guard_deal_update();

-- Log stage changes and ownership changes in the deal's notes.
create or replace function public.log_deal_changes() returns trigger
language plpgsql security definer set search_path = public as $$
declare labels jsonb := '{"lead":"Lead","qualifying":"Qualifying","proposal":"Proposal / Bid","submitted":"Submitted","negotiation":"Negotiation","won":"Won","lost":"Lost","nobid":"No-bid"}';
begin
  if tg_op = 'INSERT' then
    insert into deal_notes (deal_id, author_id, body, system) values (new.id, auth.uid(), 'Deal created', true);
  else
    if new.stage is distinct from old.stage then
      insert into deal_notes (deal_id, author_id, body, system)
      values (new.id, auth.uid(), 'Stage → ' || coalesce(labels->>new.stage, new.stage), true);
    end if;
    if new.owner_id is distinct from old.owner_id then
      insert into deal_notes (deal_id, author_id, body, system)
      values (new.id, auth.uid(), 'Owner → ' || coalesce((select full_name from profiles where id = new.owner_id), 'someone'), true);
    end if;
  end if;
  return new;
end $$;
drop trigger if exists deals_log on public.deals;
create trigger deals_log after insert or update on public.deals
  for each row execute function public.log_deal_changes();

create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = public as $$ begin new.updated_at := now(); return new; end $$;
drop trigger if exists accounts_touch on public.accounts;
create trigger accounts_touch before update on public.accounts for each row execute function public.touch_updated_at();
drop trigger if exists contacts_touch on public.contacts;
create trigger contacts_touch before update on public.contacts for each row execute function public.touch_updated_at();
drop trigger if exists tasks_touch on public.tasks;
create trigger tasks_touch before update on public.tasks for each row execute function public.touch_updated_at();

-- Lost and no-bid deals need a reason; closed deals get a close date.
create or replace function public.require_outcome() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.stage in ('lost','nobid') and coalesce(trim(new.outcome_reason), '') = '' then
    raise exception 'Pick a reason before marking this deal lost or no-bid.';
  end if;
  if new.stage in ('won','lost','nobid') and new.close_date is null then
    new.close_date := current_date;
  end if;
  return new;
end $$;
drop trigger if exists deals_outcome on public.deals;
create trigger deals_outcome before insert or update on public.deals
  for each row execute function public.require_outcome();

-- A customer's track record. Everyone signed in gets counts and loss reasons
-- across ALL deals with the account (no deal names); dollar totals are admin-only.
create or replace function public.account_track_record(a uuid) returns json
language sql stable security definer set search_path = public as $$
  select case when not public.is_active_user() then null else (
    select json_build_object(
      'total',   count(*),
      'open',    count(*) filter (where d.stage not in ('won','lost','nobid')),
      'won',     count(*) filter (where d.stage = 'won'),
      'lost',    count(*) filter (where d.stage = 'lost'),
      'nobid',   count(*) filter (where d.stage = 'nobid'),
      'won_value', case when public.is_admin() then coalesce(sum(d.value) filter (where d.stage = 'won'), 0) end,
      'first_deal', min(d.created_at),
      'last_activity', greatest(max(d.updated_at),
          (select max(n.created_at) from deal_notes n join deals d2 on d2.id = n.deal_id where d2.account_id = a)),
      'loss_reasons', (select json_object_agg(r, c) from (
          select coalesce(outcome_reason, 'Not recorded') r, count(*) c from deals
          where account_id = a and stage = 'lost' group by 1) x))
    from deals d where d.account_id = a) end;
$$;

-- ---------- row-level security --------------------------------------
alter table public.app_config   enable row level security;
alter table public.profiles     enable row level security;
alter table public.accounts     enable row level security;
alter table public.contacts     enable row level security;
alter table public.deals        enable row level security;
alter table public.deal_members enable row level security;
alter table public.deal_notes   enable row level security;
alter table public.tasks        enable row level security;
alter table public.gng_config   enable row level security;
alter table public.targets      enable row level security;

-- clear old versions of our policies so this file can be re-run
do $$ declare r record; begin
  for r in select policyname, tablename from pg_policies where schemaname='public'
    and tablename in ('app_config','profiles','accounts','contacts','deals','deal_members','deal_notes','tasks','gng_config','targets')
  loop execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename); end loop;
end $$;

-- app_config: admins only
create policy app_config_admin on public.app_config for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- profiles: the team can see each other (for owner and sharing pickers)
create policy profiles_read on public.profiles for select to authenticated using (public.is_active_user() or id = auth.uid());
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid() or public.is_admin()) with check (id = auth.uid() or public.is_admin());

-- accounts & contacts: whole team reads and writes; admins or the creator delete
create policy accounts_read   on public.accounts for select to authenticated using (public.is_active_user());
create policy accounts_insert on public.accounts for insert to authenticated with check (public.is_active_user());
create policy accounts_update on public.accounts for update to authenticated using (public.is_active_user()) with check (public.is_active_user());
create policy accounts_delete on public.accounts for delete to authenticated using (public.is_admin() or (public.is_active_user() and created_by = auth.uid()));

create policy contacts_read   on public.contacts for select to authenticated using (public.is_active_user());
create policy contacts_insert on public.contacts for insert to authenticated with check (public.is_active_user());
create policy contacts_update on public.contacts for update to authenticated using (public.is_active_user()) with check (public.is_active_user());
create policy contacts_delete on public.contacts for delete to authenticated using (public.is_admin() or (public.is_active_user() and created_by = auth.uid()));

-- deals: owner, shared-with people, and admins
-- checks the row's own columns (not can_see_deal(id)) so a rep can read back a deal they just created
create policy deals_read   on public.deals for select to authenticated using (
  public.is_admin() or (public.is_active_user() and (owner_id = auth.uid() or public.reports_to_me(owner_id)
    or exists (select 1 from public.deal_members m where m.deal_id = deals.id and (m.user_id = auth.uid() or public.reports_to_me(m.user_id))))));
create policy deals_insert on public.deals for insert to authenticated
  with check (public.is_admin() or (public.is_active_user() and (owner_id = auth.uid() or public.reports_to_me(owner_id))));
create policy deals_update on public.deals for update to authenticated
  using (public.can_see_deal(id))
  with check (public.is_admin() or (public.is_active_user() and (
      owner_id = auth.uid() or public.reports_to_me(owner_id)
      or exists (select 1 from public.deal_members m where m.deal_id = deals.id and (m.user_id = auth.uid() or public.reports_to_me(m.user_id))))));
create policy deals_delete on public.deals for delete to authenticated using (public.can_manage_deal(id));

-- sharing list: visible to anyone on the deal; changed by the owner or an admin
create policy members_read   on public.deal_members for select to authenticated using (public.can_see_deal(deal_id));
create policy members_insert on public.deal_members for insert to authenticated with check (public.can_manage_deal(deal_id));
create policy members_update on public.deal_members for update to authenticated
  using (public.can_manage_deal(deal_id)) with check (public.can_manage_deal(deal_id));
create policy members_delete on public.deal_members for delete to authenticated
  using (public.can_manage_deal(deal_id) or (user_id = auth.uid() and public.is_active_user()));

-- notes: anyone on the deal reads and adds; authors and admins delete
create policy notes_read   on public.deal_notes for select to authenticated using (public.can_see_deal(deal_id));
create policy notes_insert on public.deal_notes for insert to authenticated
  with check (public.can_see_deal(deal_id) and author_id = auth.uid() and not system);
create policy notes_delete on public.deal_notes for delete to authenticated
  using (public.is_admin() or (author_id = auth.uid() and not system));

-- tasks: on a deal → whoever can see the deal; standalone → assignee, creator, admins
create policy tasks_read on public.tasks for select to authenticated using (
  public.is_admin() or (public.is_active_user() and (
    assignee_id = auth.uid() or created_by = auth.uid() or public.reports_to_me(assignee_id) or (deal_id is not null and public.can_see_deal(deal_id)))));
create policy tasks_insert on public.tasks for insert to authenticated with check (
  public.is_active_user() and (deal_id is null or public.can_see_deal(deal_id)));
create policy tasks_update on public.tasks for update to authenticated using (
  public.is_admin() or (public.is_active_user() and (
    assignee_id = auth.uid() or created_by = auth.uid() or public.reports_to_me(assignee_id) or (deal_id is not null and public.can_see_deal(deal_id)))))
  with check (public.is_active_user() and (deal_id is null or public.can_see_deal(deal_id)));
create policy tasks_delete on public.tasks for delete to authenticated using (
  public.is_admin() or (public.is_active_user() and (created_by = auth.uid() or assignee_id = auth.uid())));

-- go/no-go settings: everyone reads, admins change
create policy gng_read  on public.gng_config for select to authenticated using (public.is_active_user());
create policy gng_write on public.gng_config for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- targets: everyone sees the company target and their own; admins see and set all
create policy targets_read on public.targets for select to authenticated using (
  public.is_admin() or (public.is_active_user() and (user_id is null or user_id = auth.uid() or public.reports_to_me(user_id))));
create policy targets_write on public.targets for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---------- table privileges (RLS above decides the rows) -------------
revoke all on all tables in schema public from anon;
grant select, insert, update, delete on
  public.accounts, public.contacts, public.deals, public.deal_members,
  public.deal_notes, public.tasks to authenticated;
grant select, update on public.profiles, public.gng_config to authenticated;
grant select, update on public.app_config to authenticated;
grant select, insert, update, delete on public.targets to authenticated;

-- ---------- function access: nobody signed out calls anything; trigger
-- functions can't be called directly; permission helpers only answer for the caller
revoke execute on function public.is_active_user(), public.is_admin(), public.can_see_deal(uuid), public.can_manage_deal(uuid), public.reports_to_me(uuid),
  public.handle_new_user(), public.guard_profile_update(), public.guard_deal_update(), public.log_deal_changes(), public.touch_updated_at(),
  public.require_outcome(), public.account_track_record(uuid)
  from public, anon;
revoke execute on function public.handle_new_user(), public.guard_profile_update(), public.guard_deal_update(),
  public.log_deal_changes(), public.touch_updated_at(), public.require_outcome() from authenticated;
grant execute on function public.is_active_user(), public.is_admin(), public.can_see_deal(uuid), public.can_manage_deal(uuid), public.reports_to_me(uuid),
  public.account_track_record(uuid) to authenticated;

-- ---------- live updates in the app ----------------------------------
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin execute 'alter publication supabase_realtime add table public.deals, public.deal_members, public.deal_notes, public.tasks, public.accounts, public.contacts';
    exception when duplicate_object then null; end;
  end if;
end $$;
