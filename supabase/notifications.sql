-- =====================================================================
-- RFIP — in-app notifications (the bell). Run after rfp_tasks.sql and the ops files. Safe to re-run.
--
-- The database writes a notification whenever:
--   * a sales task or a project-plan task is assigned to someone (on create or reassignment)
--   * a task is completed: the person who created it and the deal's account manager / the
--     project's PM hear about it (never the person who did it)
-- Each person only ever sees their own. Emails for new assignments still go out as before.
-- =====================================================================

create table if not exists public.notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  kind        text not null,               -- task_assigned, task_done
  title       text not null,
  body        text,
  link        text,                        -- #deal=<id> or #project=<id>
  actor_id    uuid references public.profiles(id) on delete set null,
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);

alter table public.notifications enable row level security;
drop policy if exists notif_read on public.notifications;
create policy notif_read on public.notifications for select to authenticated using (user_id = auth.uid());
drop policy if exists notif_update on public.notifications;
create policy notif_update on public.notifications for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists notif_delete on public.notifications;
create policy notif_delete on public.notifications for delete to authenticated using (user_id = auth.uid());
revoke all on public.notifications from anon, authenticated;
grant select, delete on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;   -- marking read is the only change the app makes

-- one notification per person, skipping the person who did it and anyone inactive
create or replace function public.notify_people(people uuid[], k text, t text, b text, l text) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into notifications (user_id, kind, title, body, link, actor_id)
  select distinct p.id, k, left(t, 300), left(b, 1000), l, auth.uid()
  from unnest(people) as u(id) join profiles p on p.id = u.id
  where p.active and p.id is distinct from auth.uid();
end $$;
revoke execute on function public.notify_people(uuid[], text, text, text, text) from public, anon, authenticated;

create or replace function public.actor_name() returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select coalesce(nullif(full_name, ''), email) from profiles where id = auth.uid()), 'Someone');
$$;
revoke execute on function public.actor_name() from public, anon, authenticated;

-- sales tasks
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
    perform notify_people(array[new.created_by, d.owner_id, new.assignee_id], 'task_done', actor_name() || ' completed a task', what,
      case when d.id is not null then '#deal=' || d.id else '#tasks' end);
  end if;
  return null;
end $$;
drop trigger if exists tasks_notify on public.tasks;
create trigger tasks_notify after insert or update of assignee_id, done on public.tasks
  for each row execute function public.tasks_notify();

-- project plan tasks
create or replace function public.plan_items_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare p projects; what text;
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
  end if;
  return null;
end $$;
drop trigger if exists plan_items_notify on public.plan_items;
create trigger plan_items_notify after insert or update of assignee_id, status on public.plan_items
  for each row execute function public.plan_items_notify();

revoke execute on function public.tasks_notify(), public.plan_items_notify() from public, anon, authenticated;

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'notifications') then
    alter publication supabase_realtime add table public.notifications;
  end if;
end $$;
