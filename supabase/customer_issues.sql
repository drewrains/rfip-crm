-- =====================================================================
-- RFIP — customer-wide issues ("all sites"). Run after issue_log.sql. Safe to re-run.
--
-- An issue can belong to one project (as before) or to the customer as a whole, e.g. an
-- AutoNation-wide problem that affects every dealership: badge access, a firmware hold,
-- a change in their IT contact. Customer-wide issues show on the customer's dashboard under
-- Issues next to every site's issues, labelled "All sites".
--   * anyone who can see one of the customer's projects sees its customer-wide issues
--   * anyone who keeps the plan on one of the customer's projects can log and update them
-- The dashboard now gets every shared issue (open, and closed in the last 30 days) in one call.
-- =====================================================================

alter table public.project_issues alter column project_id drop not null;
alter table public.project_issues add column if not exists account_id uuid references public.accounts(id) on delete cascade;
update public.project_issues i set account_id = p.account_id from public.projects p where p.id = i.project_id and i.account_id is distinct from p.account_id;
alter table public.project_issues drop constraint if exists project_issues_scope;
alter table public.project_issues add constraint project_issues_scope check (project_id is not null or account_id is not null);
create index if not exists project_issues_account on public.project_issues (account_id, status);

-- a project's issue always carries the project's customer; neither can be moved later
create or replace function public.guard_project_issue() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.status = 'closed' and new.closed_on is null then new.closed_on := current_date; end if;
  if new.status = 'open' then new.closed_on := null; end if;
  if tg_op = 'UPDATE' then
    new.updated_at := now(); new.created_at := old.created_at; new.project_id := old.project_id; new.account_id := old.account_id;
  elsif new.project_id is not null then
    new.account_id := (select account_id from projects where id = new.project_id);
  end if;
  return new;
end $$;

-- the customer as a whole: seen by anyone who sees one of its projects, kept by anyone who keeps one's plan
create or replace function public.ops_can_see_account(a uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select a is not null and (public.my_ops_role() in ('admin', 'viewer')
    or exists (select 1 from projects where account_id = a and public.ops_can_see(id)));
$$;
create or replace function public.ops_can_plan_account(a uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select a is not null and (public.my_ops_role() = 'admin'
    or exists (select 1 from projects where account_id = a and phase <> 'closed' and public.ops_can_plan(id)));
$$;
revoke execute on function public.ops_can_see_account(uuid), public.ops_can_plan_account(uuid) from public, anon;
grant execute on function public.ops_can_see_account(uuid), public.ops_can_plan_account(uuid) to authenticated;

drop policy if exists pi_read on public.project_issues;
create policy pi_read on public.project_issues for select to authenticated
  using (owner_id = auth.uid()
    or (project_id is not null and public.ops_can_see(project_id))
    or (project_id is null and public.ops_can_see_account(account_id)));
drop policy if exists pi_insert on public.project_issues;
create policy pi_insert on public.project_issues for insert to authenticated
  with check ((project_id is not null and public.ops_can_plan(project_id)) or (project_id is null and public.ops_can_plan_account(account_id)));
drop policy if exists pi_update on public.project_issues;
create policy pi_update on public.project_issues for update to authenticated
  using (owner_id = auth.uid() or (project_id is not null and public.ops_can_plan(project_id)) or (project_id is null and public.ops_can_plan_account(account_id)))
  with check (owner_id = auth.uid() or (project_id is not null and public.ops_can_plan(project_id)) or (project_id is null and public.ops_can_plan_account(account_id)));
drop policy if exists pi_delete on public.project_issues;
create policy pi_delete on public.project_issues for delete to authenticated
  using ((project_id is not null and public.ops_can_edit(project_id)) or (project_id is null and public.ops_can_plan_account(account_id)));

-- ---------- the customer dashboard ----------
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
    -- every shared issue for this customer, site by site and customer-wide, open or closed in the last 30 days
    'issues', coalesce((select jsonb_agg(jsonb_build_object('ref', i.ref, 'opened', i.opened_on, 'issue', i.title,
                 'owner', coalesce(i.owner_name, (select full_name from profiles where id = i.owner_id), 'RFIP'),
                 'next_step', i.next_step, 'due', i.next_step_due, 'status', i.status, 'closed', i.closed_on, 'resolution', i.resolution,
                 'priority', i.priority, 'project_id', i.project_id)
               order by i.status = 'closed', i.priority = 'high' desc, i.opened_on)
             from project_issues i left join projects p on p.id = i.project_id
             where i.account_id = l.account_id and i.share_with_customer and (p.id is null or p.account_id = l.account_id)
               and (i.status <> 'closed' or i.closed_on >= current_date - 30)), '[]'::jsonb),
    'as_of', now());
end $$;
