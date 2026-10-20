-- =====================================================================
-- RFIP — a note when a task is marked done. Run after plan_predecessors.sql. Safe to re-run.
--
-- Whoever finishes a task can leave a note for the person who gave it to them ("Sent the
-- revised pricing; GC wants it by Friday"). The note goes in the "Task done" email and on the
-- bell notice, and stays on the task. Works for sales tasks and project-plan tasks.
-- =====================================================================

alter table public.tasks add column if not exists done_note text;
alter table public.plan_items add column if not exists done_note text;

create or replace function public.tasks_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare d deals; what text;
begin
  if new.deal_id is not null then select * into d from deals where id = new.deal_id; end if;
  what := new.title || case when d.id is not null then ' · ' || d.name else '' end;
  if new.assignee_id is not null and not coalesce(new.done, false)
     and (tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id) then
    perform notify_people(array[new.assignee_id], 'task_assigned', actor_name() || ' assigned you a task', what
      || case when new.due is not null then ' (due ' || to_char(new.due, 'Mon DD') || ')' else '' end,
      case when d.id is not null then '#deal=' || d.id else '#tasks' end);
  end if;
  if tg_op = 'UPDATE' and new.done and not coalesce(old.done, false) then
    perform notify_people(array[new.created_by, d.owner_id, new.assignee_id], 'task_done', actor_name() || ' completed a task',
      what || coalesce(E'\n“' || nullif(btrim(new.done_note), '') || '”', ''),
      case when d.id is not null then '#deal=' || d.id else '#tasks' end);
  end if;
  return null;
end $$;
revoke execute on function public.tasks_notify() from public, anon, authenticated;

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
    perform notify_people(array[new.created_by, p.pm_id, new.assignee_id], 'task_done', actor_name() || ' completed a task',
      what || coalesce(E'\n“' || nullif(btrim(new.done_note), '') || '”', ''),
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
