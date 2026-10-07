-- RFIP — project plan: people a project is shared with can build and assign the plan.
-- Before: only the PM, the department lead and admins could add or change plan tasks.
-- Now also anyone on the project's "Shared with" list (e.g. Mark on Network jobs).
-- They still can't change the project's details, money or team. Safe to run more than once.

-- who can build the plan: the PM, the department lead, admins, and anyone the project is shared with
create or replace function public.ops_can_plan(p uuid) returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  if public.ops_can_edit(p) then return true; end if;
  if to_regclass('public.project_members') is null then return false; end if;
  return exists (select 1 from project_members where project_id = p and profile_id = auth.uid());
end $$;

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
    if not public.ops_can_plan(old.project_id) and (
         new.title is distinct from old.title or new.assignee_id is distinct from old.assignee_id
      or new.start_date is distinct from old.start_date or new.due_date is distinct from old.due_date
      or new.parent_id is distinct from old.parent_id or new.sort is distinct from old.sort) then
      raise exception 'Only the PM, the department lead, people the project is shared with or an admin can change the plan. You can update the status and notes.';
    end if;
  end if;
  new.completed_at := case when new.status = 'done' then coalesce(case when tg_op = 'UPDATE' then old.completed_at end, now()) end;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists plan_items_guard on public.plan_items;
create trigger plan_items_guard before insert or update on public.plan_items
  for each row execute function public.guard_plan_item();

drop policy if exists plan_insert on public.plan_items;
drop policy if exists plan_update on public.plan_items;
drop policy if exists plan_delete on public.plan_items;
create policy plan_insert on public.plan_items for insert to authenticated with check (public.ops_can_plan(project_id));
create policy plan_update on public.plan_items for update to authenticated
  using (public.ops_can_plan(project_id) or assignee_id = auth.uid())
  with check (public.ops_can_plan(project_id) or assignee_id = auth.uid());
create policy plan_delete on public.plan_items for delete to authenticated using (public.ops_can_plan(project_id));
