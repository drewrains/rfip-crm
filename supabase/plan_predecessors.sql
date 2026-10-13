-- =====================================================================
-- RFIP — predecessors on project-plan tasks. Run after notifications.sql. Safe to re-run.
--
-- A task can wait on one or more other tasks in the same project plan ("starts after"),
-- plus an optional lag in days. The app moves a task later when something it waits on
-- finishes later (it never pulls work earlier on its own). When the last task it waits on
-- is done, whoever it's assigned to gets a "ready to start" notification.
-- =====================================================================

alter table public.plan_items add column if not exists predecessors uuid[] not null default '{}';
alter table public.plan_items add column if not exists lag_days int not null default 0;
create index if not exists plan_items_preds_idx on public.plan_items using gin (predecessors);

-- same project only, never itself, never a loop (A waits on B waits on A)
create or replace function public.guard_plan_predecessors() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(array_length(new.predecessors, 1), 0) = 0 then return new; end if;
  new.predecessors := array(select distinct x from unnest(new.predecessors) x where x is not null);
  if new.id = any(new.predecessors) then raise exception 'A task can''t wait on itself.'; end if;
  if exists (select 1 from unnest(new.predecessors) x
             where not exists (select 1 from plan_items q where q.id = x and q.project_id = new.project_id)) then
    raise exception 'A task can only wait on tasks in the same project plan.';
  end if;
  if exists (
    with recursive up(id) as (
      select unnest(new.predecessors)
      union
      select unnest(q.predecessors) from plan_items q join up on q.id = up.id where q.id <> new.id
    ) select 1 from up where id = new.id) then
    raise exception 'That would make a loop: those tasks already wait on this one.';
  end if;
  return new;
end $$;
revoke execute on function public.guard_plan_predecessors() from public, anon, authenticated;
drop trigger if exists plan_items_preds_guard on public.plan_items;
create trigger plan_items_preds_guard before insert or update of predecessors, project_id on public.plan_items
  for each row execute function public.guard_plan_predecessors();

-- a deleted task stops holding anything up
create or replace function public.plan_items_drop_pred() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update plan_items set predecessors = array_remove(predecessors, old.id) where old.id = any(predecessors);
  return old;
end $$;
revoke execute on function public.plan_items_drop_pred() from public, anon, authenticated;
drop trigger if exists plan_items_drop_pred on public.plan_items;
create trigger plan_items_drop_pred after delete on public.plan_items for each row execute function public.plan_items_drop_pred();

-- notifications: as before, plus "ready to start" when the last task something waits on is done
create or replace function public.plan_items_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare p projects; what text; s plan_items;
begin
  select * into p from projects where id = new.project_id;
  what := new.title || ' · ' || coalesce(p.number || ' ' || p.name, 'a project');
  if new.assignee_id is not null and new.status <> 'done'
     and (tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id) then
    perform notify_people(array[new.assignee_id], 'task_assigned', actor_name() || ' assigned you a task', what
      || case when new.due_date is not null then ' (due ' || to_char(new.due_date, 'Mon DD') || ')' else '' end,
      '#project=' || new.project_id);
  end if;
  if tg_op = 'UPDATE' and new.status = 'done' and old.status is distinct from 'done' then
    perform notify_people(array[new.created_by, p.pm_id, new.assignee_id], 'task_done', actor_name() || ' completed a task', what,
      '#project=' || new.project_id);
    for s in select * from plan_items x where new.id = any(x.predecessors) and x.status <> 'done' and x.assignee_id is not null
               and not exists (select 1 from plan_items q where q.id = any(x.predecessors) and q.id <> new.id and q.status <> 'done') loop
      perform notify_people(array[s.assignee_id], 'task_ready', 'Ready to start: ' || s.title,
        new.title || ' is done' || coalesce(' · ' || p.number || ' ' || p.name, ''), '#project=' || new.project_id);
    end loop;
  end if;
  return null;
end $$;
revoke execute on function public.plan_items_notify() from public, anon, authenticated;
