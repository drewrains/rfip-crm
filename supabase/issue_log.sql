-- =====================================================================
-- RFIP — project issue log.
-- Run after customer_requests.sql (and customer_portal_schema.sql). Safe to re-run.
--
-- One log per project of problems to be solved: the date it was raised,
-- the issue, who owns it (an RFIP person, or a name like "AutoNation IT"
-- or "GC"), the next step and when it's due. Closing an issue stamps the
-- date it closed. Open issues show on the project page, the Issues tab,
-- "Needs attention" (when a next step is overdue) and the weekly update;
-- issues marked "show the customer" appear on the customer's status page
-- and dashboard (closed ones for 30 days).
-- =====================================================================

create table if not exists public.project_issues (
  id                  uuid primary key default gen_random_uuid(),
  ref                 bigint generated always as identity unique,
  project_id          uuid not null references public.projects(id) on delete cascade,
  opened_on           date not null default current_date,
  title               text not null,
  details             text,
  owner_id            uuid references public.profiles(id) on delete set null,
  owner_name          text,               -- someone outside RFIP, e.g. "AutoNation IT", "GC", "Vendor"
  next_step           text,
  next_step_due       date,
  priority            text not null default 'normal' check (priority in ('high','normal','low')),
  status              text not null default 'open' check (status in ('open','closed')),
  closed_on           date,
  resolution          text,
  share_with_customer boolean not null default true,
  request_id          uuid references public.customer_requests(id) on delete set null,
  created_by          uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists project_issues_project on public.project_issues (project_id, status);
create index if not exists project_issues_owner on public.project_issues (owner_id) where status = 'open';

-- closing stamps the date; reopening clears it
create or replace function public.guard_project_issue() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.status = 'closed' and new.closed_on is null then new.closed_on := current_date; end if;
  if new.status = 'open' then new.closed_on := null; end if;
  if tg_op = 'UPDATE' then new.updated_at := now(); new.created_at := old.created_at; new.project_id := old.project_id; end if;
  return new;
end $$;
drop trigger if exists project_issues_guard on public.project_issues;
create trigger project_issues_guard before insert or update on public.project_issues
  for each row execute function public.guard_project_issue();

-- anyone who can see the project sees its issues; the PM, lead, admins and people the project is
-- shared with keep the log; whoever owns an issue can update it
alter table public.project_issues enable row level security;
drop policy if exists pi_read on public.project_issues;
create policy pi_read on public.project_issues for select to authenticated
  using (public.ops_can_see(project_id) or owner_id = auth.uid());
drop policy if exists pi_insert on public.project_issues;
create policy pi_insert on public.project_issues for insert to authenticated with check (public.ops_can_plan(project_id));
drop policy if exists pi_update on public.project_issues;
create policy pi_update on public.project_issues for update to authenticated
  using (public.ops_can_plan(project_id) or owner_id = auth.uid())
  with check (public.ops_can_plan(project_id) or owner_id = auth.uid());
drop policy if exists pi_delete on public.project_issues;
create policy pi_delete on public.project_issues for delete to authenticated using (public.ops_can_edit(project_id));
grant select, insert, update, delete on public.project_issues to authenticated;
revoke all on public.project_issues from anon;

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'project_issues') then
    alter publication supabase_realtime add table public.project_issues;
  end if;
end $$;

-- ---------- customer-facing: shared issues on the status page and dashboard ----------
create or replace function public.project_public(pid uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', p.id, 'number', p.number, 'name', p.name, 'phase', p.phase,
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
    'issues', coalesce((select jsonb_agg(jsonb_build_object('ref', i.ref, 'opened', i.opened_on, 'issue', i.title,
                 'owner', coalesce(i.owner_name, (select full_name from profiles where id = i.owner_id), 'RFIP'),
                 'next_step', i.next_step, 'due', i.next_step_due, 'status', i.status, 'closed', i.closed_on, 'resolution', i.resolution,
                 'priority', i.priority)
               order by i.status = 'closed', i.priority = 'high' desc, i.opened_on)
             from project_issues i where i.project_id = p.id and i.share_with_customer
               and (i.status <> 'closed' or i.closed_on >= current_date - 30)), '[]'::jsonb),
    'as_of', now())
  from projects p where p.id = pid;
$$;

create or replace function public.customer_portal(k text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare l account_links;
begin
  if k is null or k !~ '^[0-9a-f]{48}$' then return null; end if;
  select * into l from account_links where token = k and active;
  if not found then return null; end if;
  update account_links set views = views + 1, last_viewed_at = now() where account_id = l.account_id;
  return jsonb_build_object(
    'customer', (select name from accounts where id = l.account_id),
    'projects', coalesce((select jsonb_agg(x order by (x->>'phase') = 'closed', x->>'end_date' nulls last, x->>'number') from (
      select jsonb_build_object(
        'id', p.id, 'number', p.number, 'name', p.name, 'phase', p.phase,
        'department', (select name from departments where key = p.department),
        'pct_complete', p.pct_complete, 'start_date', p.start_date, 'end_date', p.end_date,
        'pm', (select jsonb_build_object('name', full_name, 'email', email) from profiles where id = p.pm_id),
        'milestones_done', (select count(*) from milestones m where m.project_id = p.id and m.actual is not null),
        'milestones', (select count(*) from milestones m where m.project_id = p.id),
        'open_issues', (select count(*) from project_issues i where i.project_id = p.id and i.share_with_customer and i.status <> 'closed'),
        'next_milestone', (select jsonb_build_object('name', m.name, 'planned', m.planned) from milestones m
                           where m.project_id = p.id and m.actual is null order by m.planned nulls last, m.sort limit 1),
        'latest', (select jsonb_build_object('week_start', w.week_start, 'schedule', w.schedule_status, 'done', w.accomplished, 'next', w.next_week)
                   from weekly_updates w where w.project_id = p.id and w.share_with_customer order by w.week_start desc limit 1)) as x
      from projects p where p.account_id = l.account_id) s), '[]'::jsonb),
    'as_of', now());
end $$;
