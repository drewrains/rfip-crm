-- =====================================================================
-- RFIP Operations — tables and permission rules for the ops side of the app
-- (projects, sales-to-ops handoff, budgets, labor, schedule, change orders,
-- materials, field logs, crew, closeout, billing, safety).
--
-- Run AFTER schema.sql. Safe to re-run.
--
-- Who sees what:
--   * Admins and ops "viewers" (execs, accounting): every project.
--   * Department leads: every project in their department, and its handoffs.
--   * Project managers: the projects they manage.
--   * Field (foremen): projects they're on the crew roster for; they can add
--     daily logs there.
--   * Sales: their own won deals' handoffs (to complete the packet), and a
--     read-only status view of the resulting project (no costs or margin).
-- =====================================================================

-- ---------- who works where ----------------------------------------
alter table public.profiles add column if not exists ops_role     text;
alter table public.profiles add column if not exists department   text;
alter table public.profiles add column if not exists sales_access boolean not null default true;
do $$ begin
  alter table public.profiles add constraint profiles_ops_role_chk check (ops_role is null or ops_role in ('viewer','lead','pm','field'));
exception when duplicate_object then null; end $$;

create table if not exists public.departments (
  key              text primary key,
  name             text not null,
  lead_id          uuid references public.profiles(id) on delete set null,
  techs            integer not null default 0,           -- field techs available
  monthly_capacity numeric(14,2) not null default 0,     -- revenue the crews can deliver per month
  sort             integer not null default 0
);
insert into public.departments (key, name, sort) values
  ('Tower','Tower',1), ('DAS','DAS',2), ('Network','Network',3), ('DataComm','DataComm',4), ('Security','Security',5)
on conflict (key) do nothing;

-- ---------- projects ----------------------------------------------------
create table if not exists public.projects (
  id             uuid primary key default gen_random_uuid(),
  number         text not null unique,
  name           text not null,
  deal_id        uuid unique references public.deals(id) on delete set null,
  account_id     uuid references public.accounts(id) on delete set null,
  department     text not null references public.departments(key),
  pm_id          uuid references public.profiles(id) on delete set null,
  phase          text not null default 'mobilizing' check (phase in ('mobilizing','in_progress','closeout','closed')),
  contract_value numeric(14,2) not null default 0,
  retainage_pct  numeric(5,2) not null default 0,
  labor_rate     numeric(8,2) not null default 68,
  hours_budget   numeric(10,1) not null default 0,
  pct_complete   numeric(5,2) not null default 0 check (pct_complete between 0 and 100),
  start_date     date,
  end_date       date,
  pay_app_day    integer check (pay_app_day between 1 and 31),
  sold_by        uuid references public.profiles(id) on delete set null,
  sold_margin    numeric(5,2),                         -- estimated margin % at handoff
  accepted_at    timestamptz,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists projects_dept_idx on public.projects(department);
create index if not exists projects_pm_idx on public.projects(pm_id);

-- ---------- sales-to-ops handoff ---------------------------------------
create table if not exists public.handoffs (
  id              uuid primary key default gen_random_uuid(),
  deal_id         uuid not null unique references public.deals(id) on delete cascade,
  status          text not null default 'packet' check (status in ('packet','review','kicked_back','accepted','cancelled')),
  department      text references public.departments(key),
  pm_id           uuid references public.profiles(id) on delete set null,
  packet          jsonb not null default '{}'::jsonb,
  submitted_by    uuid references public.profiles(id) on delete set null,
  submitted_at    timestamptz,
  reviewed_by     uuid references public.profiles(id) on delete set null,
  kickback_reason text,
  kickbacks       integer not null default 0,
  accepted_at     timestamptz,
  project_id      uuid references public.projects(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ---------- project detail tables ---------------------------------------
create table if not exists public.cost_lines (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  code       text not null check (code in ('material','subcontract','equipment','other')),
  label      text not null,
  budget     numeric(14,2) not null default 0,
  committed  numeric(14,2),
  actual     numeric(14,2) not null default 0,
  forecast   numeric(14,2),                     -- estimate at completion; blank = budget
  sort       integer not null default 0
);
create index if not exists cost_lines_proj_idx on public.cost_lines(project_id);

-- Weekly labor hours (stands in for Nextep job-coded timecards) and progress.
create table if not exists public.labor_weeks (
  project_id   uuid not null references public.projects(id) on delete cascade,
  week_start   date not null,
  hours        numeric(10,1) not null default 0,
  pct_complete numeric(5,2),
  primary key (project_id, week_start)
);

create table if not exists public.milestones (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name       text not null,
  planned    date,
  actual     date,
  progress   numeric(5,2),
  note       text,
  sort       integer not null default 0
);
create index if not exists milestones_proj_idx on public.milestones(project_id);

create table if not exists public.change_orders (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects(id) on delete cascade,
  number       text not null,
  description  text not null,
  amount       numeric(14,2),
  status       text not null default 'not_priced' check (status in ('not_priced','pending','approved','rejected')),
  submitted_on date,
  decided_on   date,
  note         text,
  created_at   timestamptz not null default now()
);
create index if not exists cos_proj_idx on public.change_orders(project_id);

create table if not exists public.materials (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  item       text not null,
  qty        numeric(12,2) not null default 0,
  received   numeric(12,2) not null default 0,
  status     text not null default 'ordered' check (status in ('to_order','ordered','partial','received','backordered')),
  eta        date,
  note       text,
  created_at timestamptz not null default now()
);
create index if not exists materials_proj_idx on public.materials(project_id);

create table if not exists public.daily_logs (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  log_date   date not null default current_date,
  author_id  uuid references public.profiles(id) on delete set null default auth.uid(),
  crew_count integer,
  hours      numeric(8,1),
  work       text not null,
  issues     text,
  created_at timestamptz not null default now()
);
create index if not exists logs_proj_idx on public.daily_logs(project_id, log_date desc);

-- Techs planned on each project by week (drives the capacity view).
create table if not exists public.crew_plan (
  project_id uuid not null references public.projects(id) on delete cascade,
  week_start date not null,
  techs      integer not null default 0,
  primary key (project_id, week_start)
);

-- This week's named crew on a project. Field techs don't need a login.
create table if not exists public.crew_roster (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name       text not null,
  role       text,
  profile_id uuid references public.profiles(id) on delete set null,
  days       text not null default 'MTWRF',           -- letters of the days scheduled this week
  sort       integer not null default 0
);
create index if not exists roster_proj_idx on public.crew_roster(project_id);

create table if not exists public.closeout_items (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  item       text not null,
  status     text not null default 'todo' check (status in ('todo','in_progress','done')),
  note       text,
  sort       integer not null default 0
);
create index if not exists closeout_proj_idx on public.closeout_items(project_id);

-- Monthly billing: what went out (billed) and what's planned (scheduled).
create table if not exists public.billings (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  month      date not null check (extract(day from month) = 1),
  kind       text not null check (kind in ('billed','scheduled')),
  amount     numeric(14,2) not null default 0,
  invoice_no text,
  note       text,
  created_at timestamptz not null default now(),
  unique (project_id, month, kind)
);
create index if not exists billings_proj_idx on public.billings(project_id);

create table if not exists public.safety_events (
  id          uuid primary key default gen_random_uuid(),
  department  text references public.departments(key),
  project_id  uuid references public.projects(id) on delete set null,
  event_date  date not null default current_date,
  kind        text not null check (kind in ('recordable','first_aid','near_miss')),
  note        text,
  reported_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now()
);

-- ---------- permission helpers -----------------------------------------
create or replace function public.my_ops_role() returns text
language sql stable security definer set search_path = public as $$
  select case when public.is_admin() then 'admin' else (select ops_role from profiles where id = auth.uid() and active) end;
$$;

create or replace function public.my_department() returns text
language sql stable security definer set search_path = public as $$
  select department from profiles where id = auth.uid() and active;
$$;

-- Ops people who can see this project (admins, viewers, the department lead, the PM, crew on it).
create or replace function public.ops_can_see(p uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select case public.my_ops_role()
    when 'admin'  then true
    when 'viewer' then true
    when 'lead'   then exists (select 1 from projects where id = p and (department = public.my_department() or pm_id = auth.uid()))
    when 'pm'     then exists (select 1 from projects where id = p and pm_id = auth.uid())
    when 'field'  then exists (select 1 from crew_roster where project_id = p and profile_id = auth.uid())
    else false end;
$$;

-- Admins, the department lead and the PM change a project.
create or replace function public.ops_can_edit(p uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select case public.my_ops_role()
    when 'admin' then true
    when 'lead'  then exists (select 1 from projects where id = p and (department = public.my_department() or pm_id = auth.uid()))
    when 'pm'    then exists (select 1 from projects where id = p and pm_id = auth.uid())
    else false end;
$$;

-- Anyone on the ops side, or sales people who can see the deal it came from (status only).
create or replace function public.can_see_project(p uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.ops_can_see(p)
      or exists (select 1 from projects where id = p and deal_id is not null and public.can_see_deal(deal_id));
$$;

create or replace function public.can_see_handoff(hid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from handoffs h where h.id = hid and (
      public.my_ops_role() in ('admin','viewer')
   or (public.my_ops_role() = 'lead' and (h.department is null or h.department = public.my_department()))
   or h.pm_id = auth.uid()
   or public.can_see_deal(h.deal_id)));
$$;

-- ---------- won deal → handoff ---------------------------------------
create or replace function public.open_handoff_on_win() returns trigger
language plpgsql security definer set search_path = public as $$
declare dept text;
begin
  if new.stage = 'won' and (tg_op = 'INSERT' or old.stage is distinct from 'won') then
    dept := case
      when 'DAS' = any(new.services) or 'ERRCS' = any(new.services) then 'DAS'
      when 'Tower' = any(new.services) then 'Tower'
      when 'Security' = any(new.services) then 'Security'
      when 'Structured cabling' = any(new.services) or 'Fiber' = any(new.services) then 'DataComm'
      when 'Wi-Fi' = any(new.services) or 'Network' = any(new.services) then 'Network'
      else null end;
    insert into handoffs (deal_id, department, packet)
    values (new.id, dept, jsonb_build_object('contract_value', new.value))
    on conflict (deal_id) do update set status = case when handoffs.status = 'cancelled' then 'packet' else handoffs.status end;
  elsif tg_op = 'UPDATE' and old.stage = 'won' and new.stage <> 'won' then
    update handoffs set status = 'cancelled', updated_at = now() where deal_id = new.id and status <> 'accepted';
  end if;
  return new;
end $$;
drop trigger if exists deals_handoff on public.deals;
create trigger deals_handoff after insert or update of stage on public.deals
  for each row execute function public.open_handoff_on_win();

-- Handoff rules: sales completes the packet and submits it; ops accepts or kicks back.
create or replace function public.guard_handoff_update() returns trigger
language plpgsql security definer set search_path = public as $$
declare r text := public.my_ops_role(); is_ops boolean;
begin
  is_ops := r = 'admin' or (r = 'lead' and (coalesce(new.department, old.department) = public.my_department() or old.department is null)) or old.pm_id = auth.uid();
  if not coalesce(is_ops, false) then
    -- sales may edit the packet and move packet/kicked_back → review only
    if new.status is distinct from old.status and not (old.status in ('packet','kicked_back') and new.status = 'review') then
      raise exception 'Only operations can accept or kick back a handoff.';
    end if;
    if new.pm_id is distinct from old.pm_id or new.project_id is distinct from old.project_id then
      raise exception 'Only operations can assign the PM.';
    end if;
  end if;
  if new.status = 'review' and old.status is distinct from 'review' then
    new.submitted_by := auth.uid(); new.submitted_at := now();
  end if;
  if new.status = 'kicked_back' and old.status is distinct from 'kicked_back' then
    if coalesce(trim(new.kickback_reason), '') = '' then raise exception 'Say what is missing before kicking it back.'; end if;
    new.kickbacks := old.kickbacks + 1; new.reviewed_by := auth.uid();
  end if;
  if new.status = 'accepted' and old.status is distinct from 'accepted' and new.project_id is null then
    raise exception 'Accept a handoff with the Accept button so the project gets created.';
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists handoffs_guard on public.handoffs;
create trigger handoffs_guard before update on public.handoffs
  for each row execute function public.guard_handoff_update();

-- Accept: creates the project with its budget from the packet. Called by ops.
create or replace function public.accept_handoff(hid uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  h handoffs; d deals; pk jsonb; pid uuid; num text; r text := public.my_ops_role();
  cv numeric; mat numeric; subs numeric; eqp numeric; hrs numeric; rate numeric := 68;
begin
  select * into h from handoffs where id = hid for update;
  if h.id is null then raise exception 'Handoff not found.'; end if;
  if not coalesce(r = 'admin' or (r = 'lead' and (h.department = public.my_department() or h.department is null)) or h.pm_id = auth.uid(), false) then
    raise exception 'Only the department lead, the assigned PM or an admin can accept this handoff.';
  end if;
  if h.status = 'accepted' then return h.project_id; end if;
  if h.department is null then raise exception 'Pick the delivering department first.'; end if;
  if h.pm_id is null then raise exception 'Assign a project manager first.'; end if;
  select * into d from deals where id = h.deal_id;
  pk := h.packet;
  cv   := coalesce(nullif(pk->>'contract_value','')::numeric, d.value, 0);
  hrs  := coalesce(nullif(pk->>'labor_hours','')::numeric, 0);
  mat  := coalesce(nullif(pk->>'material','')::numeric, 0);
  subs := coalesce(nullif(pk->>'subcontract','')::numeric, 0);
  eqp  := coalesce(nullif(pk->>'equipment','')::numeric, 0);
  num := to_char(current_date, 'YY') || '-' || lpad((coalesce((select max(split_part(number,'-',2)::int) from projects where number like to_char(current_date,'YY') || '-%'), 100) + 1)::text, 3, '0');
  insert into projects (number, name, deal_id, account_id, department, pm_id, phase, contract_value, retainage_pct, labor_rate, hours_budget,
                        start_date, end_date, pay_app_day, sold_by, sold_margin, accepted_at)
  values (num, d.name, d.id, d.account_id, h.department, h.pm_id, 'mobilizing', cv,
          coalesce(nullif(pk->>'retainage_pct','')::numeric, 0), rate, hrs,
          nullif(pk->>'start_date','')::date, nullif(pk->>'end_date','')::date, coalesce(nullif(pk->>'pay_app_day','')::int, 25),
          d.owner_id, case when cv > 0 then round((cv - hrs*rate - mat - subs - eqp) / cv * 100, 1) end, now())
  returning id into pid;
  insert into cost_lines (project_id, code, label, budget, sort) values
    (pid, 'material', 'Material', mat, 1), (pid, 'subcontract', 'Subcontract', subs, 2), (pid, 'equipment', 'Equipment', eqp, 3);
  insert into closeout_items (project_id, item, sort) values
    (pid,'Test and certification results',1),(pid,'As-built drawings',2),(pid,'Warranty and O&M documents',3),
    (pid,'Customer punch walk and sign-off',4),(pid,'Final lien waivers',5),(pid,'Retainage release request',6);
  -- spread the contract as a starting billing schedule between start and end
  if nullif(pk->>'start_date','') is not null and nullif(pk->>'end_date','') is not null and cv > 0 then
    insert into billings (project_id, month, kind, amount)
    select pid, m::date, 'scheduled', round(cv / count(*) over (), 2)
    from generate_series(date_trunc('month', (pk->>'start_date')::date + 20), date_trunc('month', (pk->>'end_date')::date), interval '1 month') m;
  end if;
  update handoffs set status = 'accepted', accepted_at = now(), reviewed_by = auth.uid(), project_id = pid, updated_at = now() where id = hid;
  return pid;
end $$;

create or replace function public.touch_ops() returns trigger
language plpgsql set search_path = public as $$ begin new.updated_at := now(); return new; end $$;
drop trigger if exists projects_touch on public.projects;
create trigger projects_touch before update on public.projects for each row execute function public.touch_ops();

-- ---------- row-level security -----------------------------------------
do $$ declare t text; r record; begin
  foreach t in array array['departments','projects','handoffs','cost_lines','labor_weeks','milestones','change_orders','materials',
                           'daily_logs','crew_plan','crew_roster','closeout_items','billings','safety_events'] loop
    execute format('alter table public.%I enable row level security', t);
    for r in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy if exists %I on public.%I', r.policyname, t);
    end loop;
  end loop;
end $$;

create policy dept_read  on public.departments for select to authenticated using (public.is_active_user());
create policy dept_write on public.departments for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy proj_read   on public.projects for select to authenticated using (public.can_see_project(id));
create policy proj_update on public.projects for update to authenticated using (public.ops_can_edit(id)) with check (public.ops_can_edit(id));
create policy proj_delete on public.projects for delete to authenticated using (public.is_admin());
-- new projects come from accept_handoff(); admins can also add one directly
create policy proj_insert on public.projects for insert to authenticated with check (public.is_admin());

create policy ho_read   on public.handoffs for select to authenticated using (public.can_see_handoff(id));
create policy ho_update on public.handoffs for update to authenticated using (public.can_see_handoff(id)) with check (public.can_see_handoff(id));
create policy ho_delete on public.handoffs for delete to authenticated using (public.is_admin());

-- detail tables: ops sees, PM/lead/admin edit
do $$ declare t text; begin
  foreach t in array array['cost_lines','labor_weeks','change_orders','materials','crew_plan','billings'] loop
    execute format('create policy %I on public.%I for select to authenticated using (public.ops_can_see(project_id))', t || '_read', t);
    execute format('create policy %I on public.%I for all to authenticated using (public.ops_can_edit(project_id)) with check (public.ops_can_edit(project_id))', t || '_write', t);
  end loop;
  -- schedule, roster and closeout: sales on the deal may read them too
  foreach t in array array['milestones','crew_roster','closeout_items'] loop
    execute format('create policy %I on public.%I for select to authenticated using (public.can_see_project(project_id))', t || '_read', t);
    execute format('create policy %I on public.%I for all to authenticated using (public.ops_can_edit(project_id)) with check (public.ops_can_edit(project_id))', t || '_write', t);
  end loop;
end $$;

-- field logs: anyone who can see the project on the ops side adds; authors and editors change
create policy logs_read   on public.daily_logs for select to authenticated using (public.ops_can_see(project_id));
create policy logs_insert on public.daily_logs for insert to authenticated with check (public.ops_can_see(project_id) and author_id = auth.uid());
create policy logs_update on public.daily_logs for update to authenticated using (author_id = auth.uid() or public.ops_can_edit(project_id)) with check (author_id = auth.uid() or public.ops_can_edit(project_id));
create policy logs_delete on public.daily_logs for delete to authenticated using (author_id = auth.uid() or public.ops_can_edit(project_id));

create policy safety_read   on public.safety_events for select to authenticated using (public.my_ops_role() is not null);
create policy safety_insert on public.safety_events for insert to authenticated with check (public.my_ops_role() is not null);
create policy safety_admin  on public.safety_events for delete to authenticated using (public.is_admin());

-- ---------- privileges ------------------------------------------------
grant select on public.departments to authenticated;
grant insert, update, delete on public.departments to authenticated;
grant select, insert, update, delete on public.projects, public.handoffs, public.cost_lines, public.labor_weeks, public.milestones,
  public.change_orders, public.materials, public.daily_logs, public.crew_plan, public.crew_roster, public.closeout_items,
  public.billings, public.safety_events to authenticated;

revoke execute on function public.my_ops_role(), public.my_department(), public.ops_can_see(uuid), public.ops_can_edit(uuid),
  public.can_see_project(uuid), public.can_see_handoff(uuid), public.accept_handoff(uuid),
  public.open_handoff_on_win(), public.guard_handoff_update(), public.touch_ops() from public, anon;
revoke execute on function public.open_handoff_on_win(), public.guard_handoff_update(), public.touch_ops() from authenticated;
grant execute on function public.my_ops_role(), public.my_department(), public.ops_can_see(uuid), public.ops_can_edit(uuid),
  public.can_see_project(uuid), public.can_see_handoff(uuid), public.accept_handoff(uuid) to authenticated;

-- Only admins change someone's ops role, department or sales access.
create or replace function public.guard_profile_ops() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() and (new.ops_role is distinct from old.ops_role or new.department is distinct from old.department
     or new.sales_access is distinct from old.sales_access) then
    raise exception 'Only an admin can change operations access.';
  end if;
  return new;
end $$;
drop trigger if exists profiles_guard_ops on public.profiles;
create trigger profiles_guard_ops before update on public.profiles for each row execute function public.guard_profile_ops();
revoke execute on function public.guard_profile_ops() from public, anon, authenticated;

-- live updates
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin execute 'alter publication supabase_realtime add table public.projects, public.handoffs, public.change_orders, public.materials, public.daily_logs, public.billings, public.milestones, public.closeout_items';
    exception when duplicate_object then null; end;
  end if;
end $$;

-- Field logins (foremen) see their projects' schedule, materials and logs, but not costs or billing.
create or replace function public.ops_can_see_money(p uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.my_ops_role() is distinct from 'field' and public.ops_can_see(p);
$$;
revoke execute on function public.ops_can_see_money(uuid) from public, anon;
grant execute on function public.ops_can_see_money(uuid) to authenticated;
alter policy cost_lines_read on public.cost_lines using (public.ops_can_see_money(project_id));
alter policy billings_read on public.billings using (public.ops_can_see_money(project_id));
