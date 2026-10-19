-- =====================================================================
-- RFIP — "Sees all projects" for a department lead or PM. Run after programs.sql. Safe to re-run.
--
-- A lead normally sees their own department's projects (plus ones they PM or are shared on).
-- Some leads have crews working on other departments' jobs (David's DataComm techs on Network
-- projects), so an admin can tick "Sees all projects" for them on the Team page:
--   * they see every project, its plan, schedule, crew, issues and numbers, like a viewer
--   * they still only edit their own department's projects (and ones they PM or are shared on)
-- =====================================================================

alter table public.profiles add column if not exists ops_sees_all boolean not null default false;

create or replace function public.ops_sees_all() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select ops_sees_all from profiles where id = auth.uid() and active), false);
$$;
revoke execute on function public.ops_sees_all() from public, anon;
grant execute on function public.ops_sees_all() to authenticated;

create or replace function public.ops_can_see_one(p uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select case public.my_ops_role()
    when 'admin'  then true
    when 'viewer' then true
    when 'lead'   then public.ops_sees_all()
                    or exists (select 1 from projects where id = p and (department = public.my_department() or pm_id = auth.uid()))
                    or exists (select 1 from project_members where project_id = p and profile_id = auth.uid())
    when 'pm'     then public.ops_sees_all()
                    or exists (select 1 from projects where id = p and pm_id = auth.uid())
                    or exists (select 1 from project_members where project_id = p and profile_id = auth.uid())
    when 'field'  then exists (select 1 from crew_roster where project_id = p and profile_id = auth.uid())
    else false end;
$$;

-- only an admin can turn it on
create or replace function public.guard_profile_ops() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_admin() and (new.ops_role is distinct from old.ops_role or new.department is distinct from old.department
     or new.sales_access is distinct from old.sales_access or new.finance_approver is distinct from old.finance_approver
     or new.deal_assigner is distinct from old.deal_assigner or new.ops_sees_all is distinct from old.ops_sees_all) then
    raise exception 'Only an admin can change operations access.';
  end if;
  return new;
end $$;

-- David Ayers (DataComm lead): his techs work on Network jobs
update public.profiles set ops_sees_all = true where lower(email) = 'dayers@rfip.com';
