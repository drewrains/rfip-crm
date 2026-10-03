-- =====================================================================
-- RFIP — customer dashboard (one private link per customer account).
-- Run after plan_expenses_customer_schema.sql. Safe to re-run.
--
-- A customer like AutoNation gets one link that shows every project RFIP
-- has for them: progress, schedule and the latest weekly update for each,
-- and a click-through to the same status page the per-project link shows.
-- No money, internal notes or documents. Admins, department leads and the
-- PMs on that customer's projects can turn the link on, off or replace it.
-- =====================================================================

-- ---------- one project's public status (shared by both links) ------------
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
    'as_of', now())
  from projects p where p.id = pid;
$$;

-- the per-project link now uses the same function
create or replace function public.customer_view(k text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare l customer_links;
begin
  if k is null or k !~ '^[0-9a-f]{48}$' then return null; end if;
  select * into l from customer_links where token = k and active;
  if not found then return null; end if;
  update customer_links set views = views + 1, last_viewed_at = now() where project_id = l.project_id;
  return public.project_public(l.project_id);
end $$;

-- ---------- one link per customer account --------------------------------
create table if not exists public.account_links (
  account_id     uuid primary key references public.accounts(id) on delete cascade,
  token          text not null unique default encode(extensions.gen_random_bytes(24), 'hex'),
  active         boolean not null default true,
  created_by     uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at     timestamptz not null default now(),
  last_viewed_at timestamptz,
  views          integer not null default 0
);

-- who may share a customer's dashboard: admins, department leads, and PMs/leads who run one of that customer's projects
create or replace function public.can_share_account(a uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or public.my_ops_role() = 'lead'
      or exists (select 1 from projects where account_id = a and public.ops_can_edit(id));
$$;

alter table public.account_links enable row level security;
drop policy if exists al_read on public.account_links;
create policy al_read on public.account_links for select to authenticated using (public.can_share_account(account_id));
grant select on public.account_links to authenticated;
revoke all on public.account_links from anon;

-- action: 'on' (create or turn back on), 'off', or 'new' (replace the link; the old one stops working)
create or replace function public.account_link(a uuid, action text) returns public.account_links
language plpgsql security definer set search_path = public, extensions as $$
declare l account_links;
begin
  if not public.can_share_account(a) then raise exception 'Only an admin, a department lead or a PM on this customer''s projects can share its dashboard.'; end if;
  if action = 'on' then
    insert into account_links (account_id) values (a)
      on conflict (account_id) do update set active = true returning * into l;
  elsif action = 'off' then
    update account_links set active = false where account_id = a returning * into l;
  elsif action = 'new' then
    insert into account_links (account_id) values (a)
      on conflict (account_id) do update set token = encode(gen_random_bytes(24), 'hex'), active = true,
        created_at = now(), created_by = auth.uid(), views = 0, last_viewed_at = null returning * into l;
  else raise exception 'Unknown action.'; end if;
  return l;
end $$;

-- the customer's dashboard: every project for the account, newest work first
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
        'next_milestone', (select jsonb_build_object('name', m.name, 'planned', m.planned) from milestones m
                           where m.project_id = p.id and m.actual is null order by m.planned nulls last, m.sort limit 1),
        'latest', (select jsonb_build_object('week_start', w.week_start, 'schedule', w.schedule_status, 'done', w.accomplished, 'next', w.next_week)
                   from weekly_updates w where w.project_id = p.id and w.share_with_customer order by w.week_start desc limit 1)) as x
      from projects p where p.account_id = l.account_id) s), '[]'::jsonb),
    'as_of', now());
end $$;

-- one project's full status page, reached from the dashboard
create or replace function public.customer_portal_project(k text, pid uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare l account_links;
begin
  if k is null or k !~ '^[0-9a-f]{48}$' or pid is null then return null; end if;
  select * into l from account_links where token = k and active;
  if not found then return null; end if;
  if not exists (select 1 from projects where id = pid and account_id = l.account_id) then return null; end if;
  return public.project_public(pid);
end $$;

revoke execute on function public.project_public(uuid), public.can_share_account(uuid), public.account_link(uuid, text),
  public.customer_portal(text), public.customer_portal_project(text, uuid) from public, anon;
grant execute on function public.can_share_account(uuid), public.account_link(uuid, text) to authenticated;
grant execute on function public.customer_portal(text), public.customer_portal_project(text, uuid), public.customer_view(text) to anon, authenticated;
