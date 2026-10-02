-- =====================================================================
-- RFIP Operations — project plan and tasks, expenses, and the customer view.
-- Run after ops_schema.sql, manpower_schema.sql and docs_updates_schema.sql.
-- Safe to re-run.
--
-- Project plan: each project has a plan made of phases, tasks inside them and
--   sub-tasks below those (any depth). Any item can be assigned to a person
--   with dates, and everyone sees what's assigned to them under "My tasks".
--   The PM, department lead and admins build the plan; the person a task is
--   assigned to can update its status and notes.
--
-- Expenses: anyone working a project (foremen included) logs an expense with
--   a receipt photo. The PM approves it, then the CFO (anyone marked as the
--   finance approver) gives final approval. Approved expenses count toward the
--   project's cost. Rejected ones go back to the person who logged them to fix
--   and resubmit.
--
-- Customer view: the PM can turn on a private link per project. Anyone with
--   the link sees a read-only status page — progress, schedule, plan phases and
--   the weekly update's "done" and "next week" — never money, internal notes
--   or documents. The link can be turned off or replaced at any time.
-- =====================================================================

-- ---------- finance approver (the CFO) ---------------------------------------
alter table public.profiles add column if not exists finance_approver boolean not null default false;

create or replace function public.is_finance() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select finance_approver from profiles where id = auth.uid() and active), false);
$$;

create or replace function public.guard_profile_ops() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() and (new.ops_role is distinct from old.ops_role or new.department is distinct from old.department
     or new.sales_access is distinct from old.sales_access or new.finance_approver is distinct from old.finance_approver) then
    raise exception 'Only an admin can change operations access.';
  end if;
  return new;
end $$;

-- ---------- project plan and tasks ---------------------------------------------
create table if not exists public.plan_items (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects(id) on delete cascade,
  parent_id    uuid references public.plan_items(id) on delete cascade,
  title        text not null,
  assignee_id  uuid references public.profiles(id) on delete set null,
  start_date   date,
  due_date     date,
  status       text not null default 'not_started' check (status in ('not_started','in_progress','blocked','done')),
  notes        text,
  sort         integer not null default 0,
  completed_at timestamptz,
  created_by   uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (due_date is null or start_date is null or due_date >= start_date)
);
create index if not exists plan_items_proj_idx on public.plan_items(project_id, sort);
create index if not exists plan_items_assignee_idx on public.plan_items(assignee_id) where status <> 'done';
create index if not exists plan_items_parent_idx on public.plan_items(parent_id);

create or replace function public.guard_plan_item() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.parent_id is not null and not exists (select 1 from plan_items where id = new.parent_id and project_id = new.project_id) then
    raise exception 'A sub-task has to sit under an item on the same project.';
  end if;
  if tg_op = 'UPDATE' then
    if new.project_id is distinct from old.project_id then raise exception 'A plan item can''t move to another project.'; end if;
    if new.parent_id is not null and new.parent_id = new.id then raise exception 'An item can''t sit under itself.'; end if;
    if new.parent_id is distinct from old.parent_id and new.parent_id is not null and exists (
         with recursive up(id, parent_id) as (
           select id, parent_id from plan_items where id = new.parent_id
           union all select p.id, p.parent_id from plan_items p join up on p.id = up.parent_id)
         select 1 from up where id = new.id) then
      raise exception 'An item can''t sit under one of its own sub-tasks.';
    end if;
    -- the person it's assigned to (without edit rights on the project) can only move it along and add notes
    if not public.ops_can_edit(old.project_id) and (
         new.title is distinct from old.title or new.assignee_id is distinct from old.assignee_id
      or new.start_date is distinct from old.start_date or new.due_date is distinct from old.due_date
      or new.parent_id is distinct from old.parent_id or new.sort is distinct from old.sort) then
      raise exception 'Only the PM, the department lead or an admin can change the plan. You can update the status and notes.';
    end if;
  end if;
  new.completed_at := case when new.status = 'done' then coalesce(case when tg_op = 'UPDATE' then old.completed_at end, now()) end;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists plan_items_guard on public.plan_items;
create trigger plan_items_guard before insert or update on public.plan_items
  for each row execute function public.guard_plan_item();

alter table public.plan_items enable row level security;
do $$ declare r record; begin
  for r in select policyname from pg_policies where schemaname = 'public' and tablename = 'plan_items' loop
    execute format('drop policy if exists %I on public.plan_items', r.policyname);
  end loop;
end $$;
create policy plan_read   on public.plan_items for select to authenticated using (public.ops_can_see(project_id) or assignee_id = auth.uid());
create policy plan_insert on public.plan_items for insert to authenticated with check (public.ops_can_edit(project_id));
create policy plan_update on public.plan_items for update to authenticated
  using (public.ops_can_edit(project_id) or assignee_id = auth.uid())
  with check (public.ops_can_edit(project_id) or assignee_id = auth.uid());
create policy plan_delete on public.plan_items for delete to authenticated using (public.ops_can_edit(project_id));
grant select, insert, update, delete on public.plan_items to authenticated;
revoke all on public.plan_items from anon;

-- ---------- expenses -------------------------------------------------------------
create table if not exists public.expenses (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects(id) on delete cascade,
  spent_on      date not null default current_date,
  category      text not null check (category in ('materials','equipment','tools','fuel','lodging','meals','travel','permits','shipping','other')),
  vendor        text,
  description   text,
  amount        numeric(12,2) not null check (amount > 0),
  paid_with     text not null default 'company_card' check (paid_with in ('company_card','reimburse','invoice')),
  receipt_path  text,
  status        text not null default 'submitted' check (status in ('submitted','pm_approved','approved','rejected')),
  submitted_by  uuid references public.profiles(id) on delete set null default auth.uid(),
  submitted_at  timestamptz not null default now(),
  pm_by         uuid references public.profiles(id) on delete set null,
  pm_at         timestamptz,
  cfo_by        uuid references public.profiles(id) on delete set null,
  cfo_at        timestamptz,
  rejected_by   uuid references public.profiles(id) on delete set null,
  reject_reason text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists expenses_proj_idx on public.expenses(project_id, spent_on);
create index if not exists expenses_status_idx on public.expenses(status) where status in ('submitted','pm_approved');

-- Approvals only happen through expense_decide(). Everything else is the person
-- who logged it fixing their own expense before it's approved; any edit sends it
-- back to the PM.
create or replace function public.guard_expense() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('rfip.expense_decision', true), '') = 'on' then
    new.updated_at := now(); return new;
  end if;
  if tg_op = 'INSERT' then
    new.status := 'submitted'; new.submitted_by := auth.uid(); new.submitted_at := now();
    new.pm_by := null; new.pm_at := null; new.cfo_by := null; new.cfo_at := null; new.rejected_by := null; new.reject_reason := null;
    return new;
  end if;
  if old.submitted_by is distinct from auth.uid() or old.status not in ('submitted','rejected') then
    raise exception 'Only the person who logged this expense can change it, and only before it''s approved.';
  end if;
  if new.project_id is distinct from old.project_id then raise exception 'An expense can''t move to another project.'; end if;
  new.submitted_by := old.submitted_by; new.status := 'submitted'; new.submitted_at := now();
  new.pm_by := null; new.pm_at := null; new.cfo_by := null; new.cfo_at := null; new.rejected_by := null; new.reject_reason := null;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists expenses_guard on public.expenses;
create trigger expenses_guard before insert or update on public.expenses
  for each row execute function public.guard_expense();

-- decision: 'approve' or 'reject'. The PM (or lead/admin on the project) approves
-- step one; the finance approver gives final approval. Either can reject with a reason.
create or replace function public.expense_decide(eid uuid, decision text, reason text default null)
returns public.expenses
language plpgsql security definer set search_path = public as $$
declare e expenses;
begin
  select * into e from expenses where id = eid for update;
  if not found then raise exception 'That expense isn''t available.'; end if;
  perform set_config('rfip.expense_decision', 'on', true);
  if decision = 'approve' then
    if e.status = 'submitted' and public.ops_can_edit(e.project_id) then
      update expenses set status = 'pm_approved', pm_by = auth.uid(), pm_at = now() where id = eid returning * into e;
    elsif e.status = 'pm_approved' and public.is_finance() then
      update expenses set status = 'approved', cfo_by = auth.uid(), cfo_at = now() where id = eid returning * into e;
    elsif e.status = 'pm_approved' then
      raise exception 'The PM has approved this. Final approval comes from the CFO.';
    else
      raise exception 'You can''t approve this expense.';
    end if;
  elsif decision = 'reject' then
    if coalesce(trim(reason), '') = '' then raise exception 'Say why it''s being sent back.'; end if;
    if (e.status = 'submitted' and (public.ops_can_edit(e.project_id) or public.is_finance()))
       or (e.status = 'pm_approved' and public.is_finance()) then
      update expenses set status = 'rejected', rejected_by = auth.uid(), reject_reason = trim(reason),
                          pm_by = null, pm_at = null where id = eid returning * into e;
    else
      raise exception 'You can''t send this expense back.';
    end if;
  else
    raise exception 'Unknown decision.';
  end if;
  perform set_config('rfip.expense_decision', '', true);
  return e;
end $$;

alter table public.expenses enable row level security;
do $$ declare r record; begin
  for r in select policyname from pg_policies where schemaname = 'public' and tablename = 'expenses' loop
    execute format('drop policy if exists %I on public.expenses', r.policyname);
  end loop;
end $$;
create policy exp_read   on public.expenses for select to authenticated
  using (submitted_by = auth.uid() or public.ops_can_see_money(project_id) or public.is_finance());
create policy exp_insert on public.expenses for insert to authenticated with check (public.ops_can_see(project_id));
create policy exp_update on public.expenses for update to authenticated using (submitted_by = auth.uid()) with check (submitted_by = auth.uid());
create policy exp_delete on public.expenses for delete to authenticated
  using ((submitted_by = auth.uid() and status in ('submitted','rejected')) or public.my_ops_role() = 'admin');
grant select, insert, update, delete on public.expenses to authenticated;
revoke all on public.expenses from anon;

-- receipts live in the project's "expenses" folder: anyone on the job can upload;
-- people who see the project's money, the CFO and whoever uploaded it can open them
create or replace function public.doc_can(p uuid, folder text, action text) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when p is null then false
    when action = 'read' then
      case when folder in ('contract','scope','pay_apps') then public.ops_can_see_money(p)
           when folder = 'expenses' then public.ops_can_see_money(p) or public.is_finance()
           else public.ops_can_see(p) end
    when action = 'write' then
      public.ops_can_edit(p)
      or (folder = 'expenses' and public.ops_can_see(p))
      or (public.my_ops_role() = 'field' and public.ops_can_see(p) and folder in ('field','tests','safety'))
    else false end;
$$;
alter policy rfip_files_read on storage.objects
  using (bucket_id = 'project-files' and (owner_id = auth.uid()::text
         or public.doc_can(public.doc_path_project(name), split_part(name, '/', 2), 'read')));

-- ---------- customer view ------------------------------------------------------------
alter table public.weekly_updates add column if not exists share_with_customer boolean not null default true;

create table if not exists public.customer_links (
  project_id     uuid primary key references public.projects(id) on delete cascade,
  token          text not null unique default encode(extensions.gen_random_bytes(24), 'hex'),
  active         boolean not null default true,
  created_by     uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at     timestamptz not null default now(),
  last_viewed_at timestamptz,
  views          integer not null default 0
);
alter table public.customer_links enable row level security;
do $$ declare r record; begin
  for r in select policyname from pg_policies where schemaname = 'public' and tablename = 'customer_links' loop
    execute format('drop policy if exists %I on public.customer_links', r.policyname);
  end loop;
end $$;
create policy cl_read on public.customer_links for select to authenticated using (public.ops_can_edit(project_id) or public.my_ops_role() = 'viewer');
grant select on public.customer_links to authenticated;
revoke all on public.customer_links from anon;

-- action: 'on' (create or turn back on), 'off', or 'new' (replace the link; the old one stops working)
create or replace function public.customer_link(p uuid, action text) returns public.customer_links
language plpgsql security definer set search_path = public, extensions as $$
declare l customer_links;
begin
  if not public.ops_can_edit(p) then raise exception 'Only the PM, the department lead or an admin can share this project.'; end if;
  if action = 'on' then
    insert into customer_links (project_id) values (p)
      on conflict (project_id) do update set active = true returning * into l;
  elsif action = 'off' then
    update customer_links set active = false where project_id = p returning * into l;
  elsif action = 'new' then
    insert into customer_links (project_id) values (p)
      on conflict (project_id) do update set token = encode(gen_random_bytes(24), 'hex'), active = true,
        created_at = now(), created_by = auth.uid(), views = 0, last_viewed_at = null returning * into l;
  else raise exception 'Unknown action.'; end if;
  return l;
end $$;

-- The customer's page. Read-only; no money, no internal notes, no documents.
create or replace function public.customer_view(k text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare l customer_links; p projects;
begin
  if k is null or k !~ '^[0-9a-f]{48}$' then return null; end if;
  select * into l from customer_links where token = k and active;
  if not found then return null; end if;
  update customer_links set views = views + 1, last_viewed_at = now() where project_id = l.project_id;
  select * into p from projects where id = l.project_id;
  return jsonb_build_object(
    'number', p.number, 'name', p.name, 'phase', p.phase,
    'customer', (select name from accounts where id = p.account_id),
    'department', (select name from departments where key = p.department),
    'pct_complete', p.pct_complete,
    'start_date', p.start_date, 'end_date', p.end_date,
    'pm', (select jsonb_build_object('name', full_name, 'email', email) from profiles where id = p.pm_id),
    'milestones', coalesce((select jsonb_agg(jsonb_build_object('name', m.name, 'planned', m.planned, 'actual', m.actual, 'progress', m.progress)
                            order by m.planned nulls last, m.sort) from milestones m where m.project_id = p.id), '[]'::jsonb),
    'plan', coalesce((
      with recursive tree(root, id, status) as (
        select t.id, t.id, t.status from plan_items t where t.project_id = p.id and t.parent_id is null
        union all select tree.root, c.id, c.status from plan_items c join tree on c.parent_id = tree.id)
      select jsonb_agg(jsonb_build_object('title', t.title, 'start', t.start_date, 'due', t.due_date, 'status', t.status,
               'items', (select count(*) - 1 from tree where root = t.id),
               'done', (select count(*) from tree where root = t.id and id <> t.id and status = 'done'))
             order by t.sort, t.start_date nulls last)
      from plan_items t where t.project_id = p.id and t.parent_id is null), '[]'::jsonb),
    'updates', coalesce((select jsonb_agg(u order by u->>'week_start' desc) from (
        select jsonb_build_object('week_start', w.week_start, 'schedule', w.schedule_status, 'pct', w.pct_complete,
                                  'done', w.accomplished, 'next', w.next_week) as u
        from weekly_updates w where w.project_id = p.id and w.share_with_customer
        order by w.week_start desc limit 6) x), '[]'::jsonb),
    'as_of', now());
end $$;

revoke execute on function public.is_finance(), public.expense_decide(uuid, text, text), public.customer_link(uuid, text),
  public.customer_view(text), public.guard_plan_item(), public.guard_expense() from public, anon;
revoke execute on function public.guard_plan_item(), public.guard_expense() from authenticated;
grant execute on function public.is_finance(), public.expense_decide(uuid, text, text), public.customer_link(uuid, text) to authenticated;
grant execute on function public.customer_view(text) to anon, authenticated;

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin execute 'alter publication supabase_realtime add table public.plan_items';
    exception when duplicate_object then null; end;
    begin execute 'alter publication supabase_realtime add table public.expenses';
    exception when duplicate_object then null; end;
  end if;
end $$;
