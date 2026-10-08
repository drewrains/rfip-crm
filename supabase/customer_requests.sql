-- =====================================================================
-- RFIP — customer requests (submitted from the customer dashboard).
-- Run after customer_portal_schema.sql. Safe to re-run.
--
-- A customer like AutoNation opens the dashboard link RFIP already gave
-- them and reports a problem on a current project, asks for a change, or
-- sends new work (a new site, a service call, a survey/quote) instead of
-- emailing it. Problems and changes on a project go straight to its PM. Each request lands in Operations → Requests with
-- a number (R-1001), the department leads (and the PM of a related
-- project) get an email, and the customer sees its status on the
-- dashboard: Received → Under review → Quote sent → Scheduled → Complete.
-- The customer only ever sees the status and the "message to customer";
-- internal notes, who it's assigned to and money stay inside RFIP.
-- =====================================================================

create table if not exists public.customer_requests (
  id              uuid primary key default gen_random_uuid(),
  ref             bigint generated always as identity (start with 1001) unique,
  account_id      uuid not null references public.accounts(id) on delete cascade,
  requester_name  text not null,
  requester_email text not null,
  requester_phone text,
  title           text not null,
  details         text,
  kind            text not null default 'new_work',
  department      text,                 -- null = customer wasn't sure
  site            text,                 -- site / store name or number
  address         text,
  needed_by       date,
  urgent          boolean not null default false,
  project_id      uuid references public.projects(id) on delete set null,  -- related or resulting project
  deal_id         uuid references public.deals(id) on delete set null,     -- resulting deal / quote
  status          text not null default 'new' check (status in ('new','reviewing','quoted','scheduled','done','declined')),
  assigned_to     uuid references public.profiles(id) on delete set null,
  customer_note   text,                 -- shown to the customer on the dashboard
  internal_note   text,
  source          text not null default 'portal' check (source in ('portal','internal')),
  notified_at     timestamptz,
  created_by      uuid references public.profiles(id) on delete set null,  -- set when logged by RFIP staff
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
-- issue = problem on a current project, change = change/addition to one, rfi = request for information
alter table public.customer_requests drop constraint if exists customer_requests_kind_check;
alter table public.customer_requests add constraint customer_requests_kind_check
  check (kind in ('issue','change','rfi','new_work','service','survey','other'));
create index if not exists customer_requests_account on public.customer_requests (account_id, created_at desc);
create index if not exists customer_requests_status on public.customer_requests (status);

-- who works the inbox: admins, ops leads, PMs and viewers see it; the person it's assigned to always does
create or replace function public.can_see_requests() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.my_ops_role() in ('admin','lead','pm','viewer'), false);
$$;
create or replace function public.can_work_requests() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.my_ops_role() in ('admin','lead','pm'), false);
$$;

alter table public.customer_requests enable row level security;
drop policy if exists cr_read on public.customer_requests;
create policy cr_read on public.customer_requests for select to authenticated
  using (public.can_see_requests() or assigned_to = auth.uid());
drop policy if exists cr_insert on public.customer_requests;
create policy cr_insert on public.customer_requests for insert to authenticated
  with check (public.can_work_requests() and source = 'internal');
drop policy if exists cr_update on public.customer_requests;
create policy cr_update on public.customer_requests for update to authenticated
  using (public.can_work_requests() or assigned_to = auth.uid())
  with check (public.can_work_requests() or assigned_to = auth.uid());
drop policy if exists cr_delete on public.customer_requests;
create policy cr_delete on public.customer_requests for delete to authenticated using (public.is_admin());
grant select, insert, update, delete on public.customer_requests to authenticated;
revoke all on public.customer_requests from anon;

-- keep what the customer sent as they sent it; stamp updated_at
create or replace function public.guard_customer_request() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null then new.created_by := auth.uid(); new.source := 'internal'; end if;
    return new;
  end if;
  if auth.uid() is not null and new.source = 'portal' and (
       new.account_id is distinct from old.account_id or new.requester_name is distinct from old.requester_name
    or new.requester_email is distinct from old.requester_email or new.requester_phone is distinct from old.requester_phone
    or new.details is distinct from old.details or new.created_at is distinct from old.created_at or new.source is distinct from old.source) then
    raise exception 'What the customer sent can''t be changed. Add an internal note instead.';
  end if;
  if auth.uid() is not null and new.notified_at is distinct from old.notified_at then new.notified_at := old.notified_at; end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists customer_requests_guard on public.customer_requests;
create trigger customer_requests_guard before insert or update on public.customer_requests
  for each row execute function public.guard_customer_request();

-- ---------- the customer side (anonymous, by dashboard link) --------------
create or replace function public.customer_request_submit(k text, r jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare l account_links; v_title text; v_name text; v_email text; v_kind text; v_dept text; v_pid uuid; v_need date; v_pm uuid; rec customer_requests;
begin
  if k is null or k !~ '^[0-9a-f]{48}$' then raise exception 'This link isn''t valid.'; end if;
  select * into l from account_links where token = k and active;
  if not found then raise exception 'This link is no longer active.'; end if;
  if (select count(*) from customer_requests where account_id = l.account_id and source = 'portal' and created_at > now() - interval '1 day') >= 25 then
    raise exception 'Too many requests today from this link. Please call RFIP at 405-286-0928.';
  end if;
  v_title := left(btrim(coalesce(r->>'title', '')), 200);
  v_name  := left(btrim(coalesce(r->>'requester_name', '')), 120);
  v_email := lower(left(btrim(coalesce(r->>'requester_email', '')), 200));
  if v_title = '' then raise exception 'Tell us briefly what you need.'; end if;
  if v_name = '' then raise exception 'Please add your name.'; end if;
  if v_email !~ '^[^\s@<>()",;]+@[^\s@<>()",;]+\.[a-z]{2,}$' then raise exception 'Please add a valid email so we can reach you.'; end if;
  v_kind := coalesce(nullif(r->>'kind', ''), 'new_work');
  if v_kind not in ('issue','change','rfi','new_work','service','survey','other') then v_kind := 'other'; end if;
  v_dept := nullif(r->>'department', '');
  if v_dept is not null and not exists (select 1 from departments where key = v_dept) then v_dept := null; end if;
  begin v_pid := nullif(r->>'project_id', '')::uuid; exception when others then v_pid := null; end;
  if v_pid is not null and not exists (select 1 from projects where id = v_pid and account_id = l.account_id) then v_pid := null; end if;
  if v_kind in ('issue','change') and v_pid is null then raise exception 'Pick the project this is about.'; end if;
  -- a problem, change or RFI on a project belongs to that project's PM and department
  if v_pid is not null then
    select pm_id, coalesce(v_dept, department) into v_pm, v_dept from projects where id = v_pid;
    if v_kind not in ('issue','change','rfi') then v_pm := null; end if;
  end if;
  begin v_need := nullif(r->>'needed_by', '')::date; exception when others then v_need := null; end;
  if v_need is not null and (v_need < current_date - 1 or v_need > current_date + 1000) then v_need := null; end if;
  insert into customer_requests (account_id, requester_name, requester_email, requester_phone, title, details, kind, department,
                                 site, address, needed_by, urgent, project_id, assigned_to, source)
  values (l.account_id, v_name, v_email, nullif(left(btrim(coalesce(r->>'requester_phone', '')), 40), ''), v_title,
          nullif(left(btrim(coalesce(r->>'details', '')), 5000), ''), v_kind, v_dept,
          nullif(left(btrim(coalesce(r->>'site', '')), 200), ''), nullif(left(btrim(coalesce(r->>'address', '')), 300), ''),
          v_need, coalesce((r->>'urgent')::boolean, false), v_pid, v_pm, 'portal')
  returning * into rec;
  return jsonb_build_object('id', rec.id, 'ref', rec.ref);
end $$;

-- the customer's own requests, status only
create or replace function public.customer_requests_list(k text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare l account_links;
begin
  if k is null or k !~ '^[0-9a-f]{48}$' then return null; end if;
  select * into l from account_links where token = k and active;
  if not found then return null; end if;
  return coalesce((select jsonb_agg(x order by (x->>'created_at') desc) from (
    select jsonb_build_object('ref', c.ref, 'title', c.title, 'kind', c.kind, 'site', c.site, 'status', c.status,
      'urgent', c.urgent, 'needed_by', c.needed_by, 'requester_name', c.requester_name, 'created_at', c.created_at,
      'updated_at', c.updated_at, 'customer_note', c.customer_note,
      'project', (select jsonb_build_object('id', p.id, 'number', p.number, 'name', p.name) from projects p where p.id = c.project_id and p.account_id = l.account_id)) as x
    from customer_requests c where c.account_id = l.account_id
      and (c.status not in ('done','declined') or c.updated_at > now() - interval '90 days')
    order by c.created_at desc limit 100) s), '[]'::jsonb);
end $$;

revoke execute on function public.customer_request_submit(text, jsonb), public.customer_requests_list(text),
  public.can_see_requests(), public.can_work_requests() from public, anon;
grant execute on function public.customer_request_submit(text, jsonb), public.customer_requests_list(text) to anon, authenticated;
grant execute on function public.can_see_requests(), public.can_work_requests() to authenticated;

-- live updates for the inbox
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'customer_requests') then
    alter publication supabase_realtime add table public.customer_requests;
  end if;
end $$;
