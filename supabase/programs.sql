-- =====================================================================
-- RFIP — programs: a parent job with a phase job per customer PO.
-- Run after the other ops files (needs project_members). Safe to re-run.
--
-- A big job that comes in as several POs (Phase 1, Phase 2…) stays one
-- program: the parent (26-150) and a phase job for each PO (26-150-01,
-- 26-150-02…). Each phase job keeps its own PO, budget, hours, billing and
-- margin; the parent's page shows everything from every phase combined.
--   * whoever can see the parent sees all of its phases
--   * the parent's PM (and its lead/admins) can edit every phase
--   * a phase's PM also sees the parent, but not the other phases
-- =====================================================================

alter table public.projects add column if not exists parent_id uuid references public.projects(id) on delete set null;
alter table public.projects add column if not exists po_number text;
create index if not exists projects_parent_idx on public.projects(parent_id) where parent_id is not null;

-- one level only: a phase can't have phases, and a parent can't be someone's phase
create or replace function public.guard_project_parent() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.parent_id is not distinct from (case when tg_op = 'UPDATE' then old.parent_id end) then return new; end if;
  if new.parent_id is null then return new; end if;
  if new.parent_id = new.id then raise exception 'A job can''t be its own program.'; end if;
  if exists (select 1 from projects where id = new.parent_id and parent_id is not null) then
    raise exception 'That job is itself a phase. Pick the program''s parent job.'; end if;
  if tg_op = 'UPDATE' and exists (select 1 from projects where parent_id = new.id) then
    raise exception 'This job already has phases, so it can''t be a phase of another job.'; end if;
  return new;
end $$;
drop trigger if exists projects_parent_guard on public.projects;
create trigger projects_parent_guard before insert or update of parent_id on public.projects
  for each row execute function public.guard_project_parent();

-- the original per-job rules, unchanged
create or replace function public.ops_can_see_one(p uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select case public.my_ops_role()
    when 'admin'  then true
    when 'viewer' then true
    when 'lead'   then exists (select 1 from projects where id = p and (department = public.my_department() or pm_id = auth.uid()))
                    or exists (select 1 from project_members where project_id = p and profile_id = auth.uid())
    when 'pm'     then exists (select 1 from projects where id = p and pm_id = auth.uid())
                    or exists (select 1 from project_members where project_id = p and profile_id = auth.uid())
    when 'field'  then exists (select 1 from crew_roster where project_id = p and profile_id = auth.uid())
    else false end;
$$;
create or replace function public.ops_can_edit_one(p uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select case public.my_ops_role()
    when 'admin' then true
    when 'lead'  then exists (select 1 from projects where id = p and (department = public.my_department() or pm_id = auth.uid()))
    when 'pm'    then exists (select 1 from projects where id = p and pm_id = auth.uid())
    else false end;
$$;
-- with programs: the parent's people reach every phase; a phase's people also see the parent
create or replace function public.ops_can_see(p uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.ops_can_see_one(p)
      or public.ops_can_see_one((select parent_id from projects where id = p))
      or exists (select 1 from projects c where c.parent_id = p and public.ops_can_see_one(c.id));
$$;
create or replace function public.ops_can_edit(p uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.ops_can_edit_one(p) or public.ops_can_edit_one((select parent_id from projects where id = p));
$$;
revoke execute on function public.ops_can_see_one(uuid), public.ops_can_edit_one(uuid) from public, anon;
grant execute on function public.ops_can_see_one(uuid), public.ops_can_edit_one(uuid) to authenticated;

-- the directory every ops user reads (manpower, timeline) now carries the program link
drop function if exists public.ops_project_directory();
create function public.ops_project_directory()
returns table (id uuid, number text, name text, department text, pm_id uuid, phase text, start_date date, end_date date, parent_id uuid)
language sql stable security definer set search_path = public as $$
  select p.id, p.number, p.name, p.department, p.pm_id, p.phase, p.start_date, p.end_date, p.parent_id
  from projects p where public.my_ops_role() is not null and p.phase <> 'closed';
$$;
revoke execute on function public.ops_project_directory() from public, anon;
grant execute on function public.ops_project_directory() to authenticated;

-- add a phase job under a parent: 26-150 → 26-150-01, 26-150-02 …
create or replace function public.add_phase_job(parent uuid, phase_name text, po text, contract numeric, hours numeric, pm uuid default null)
returns public.projects
language plpgsql security definer set search_path = public as $$
declare par projects; n int; rec projects;
begin
  select * into par from projects where id = parent;
  if not found then raise exception 'That job isn''t available.'; end if;
  if not public.ops_can_edit(parent) then raise exception 'Only the program''s PM, its department lead or an admin can add a phase.'; end if;
  if par.parent_id is not null then raise exception 'Add phases to the program''s parent job.'; end if;
  if coalesce(trim(phase_name), '') = '' then raise exception 'Name the phase.'; end if;
  n := (select count(*) from projects where parent_id = parent) + 1;
  while exists (select 1 from projects where number = par.number || '-' || lpad(n::text, 2, '0')) loop n := n + 1; end loop;
  insert into projects (number, name, deal_id, account_id, department, pm_id, phase, contract_value, retainage_pct, labor_rate,
                        hours_budget, pct_complete, start_date, end_date, sold_by, sold_margin, parent_id, po_number, sharepoint_url, pay_app_day)
  values (par.number || '-' || lpad(n::text, 2, '0'), trim(phase_name), null, par.account_id, par.department, coalesce(pm, par.pm_id), 'mobilizing',
          coalesce(contract, 0), par.retainage_pct, par.labor_rate, coalesce(hours, 0), 0, null, null, par.sold_by, par.sold_margin,
          parent, nullif(trim(po), ''), par.sharepoint_url, par.pay_app_day)
  returning * into rec;
  return rec;
end $$;
revoke execute on function public.add_phase_job(uuid, text, text, numeric, numeric, uuid) from public, anon;
grant execute on function public.add_phase_job(uuid, text, text, numeric, numeric, uuid) to authenticated;
