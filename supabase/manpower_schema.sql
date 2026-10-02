-- =====================================================================
-- RFIP Operations — manpower schedule: the field tech roster and who is
-- on which job each day. Run after ops_schema.sql. Safe to re-run.
--
-- Who can change it:
--   * Project managers schedule people onto their own projects and take
--     them off again. A person already on another job that day has to be
--     released by that job's PM first.
--   * Department leads can do the same for their department's projects and
--     record time off (PTO, training) for their department's techs.
--   * Admins can change anything and keep the tech roster.
-- Everyone on the operations side can see the whole board, so PMs can see
-- who's free.
-- =====================================================================

create table if not exists public.techs (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  department  text references public.departments(key),
  trade       text,                                   -- Foreman, Lead tech, Tech, Apprentice, Climber…
  profile_id  uuid references public.profiles(id) on delete set null,   -- their app login, if any
  active      boolean not null default true,
  sort        integer not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists public.assignments (
  id          uuid primary key default gen_random_uuid(),
  tech_id     uuid not null references public.techs(id) on delete cascade,
  work_date   date not null,
  kind        text not null default 'job' check (kind in ('job','pto','training')),
  project_id  uuid references public.projects(id) on delete cascade,
  note        text,
  created_by  uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now(),
  unique (tech_id, work_date),                        -- one place per person per day
  check ((kind = 'job') = (project_id is not null))
);
create index if not exists assignments_date_idx on public.assignments(work_date);
create index if not exists assignments_proj_idx on public.assignments(project_id);

-- Can the signed-in person place or remove this assignment?
create or replace function public.can_schedule(p uuid, t uuid, k text) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when public.my_ops_role() = 'admin' then true
    when k = 'job' then public.ops_can_edit(p)
    else public.my_ops_role() = 'lead' and exists (select 1 from techs where id = t and department = public.my_department())
  end;
$$;

alter table public.techs enable row level security;
alter table public.assignments enable row level security;
do $$ declare r record; begin
  for r in select policyname, tablename from pg_policies where schemaname = 'public' and tablename in ('techs','assignments') loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;
create policy techs_read  on public.techs for select to authenticated using (public.my_ops_role() is not null);
create policy techs_write on public.techs for all to authenticated
  using (public.my_ops_role() = 'admin' or (public.my_ops_role() = 'lead' and department = public.my_department()))
  with check (public.my_ops_role() = 'admin' or (public.my_ops_role() = 'lead' and department = public.my_department()));
create policy asg_read   on public.assignments for select to authenticated using (public.my_ops_role() is not null);
create policy asg_insert on public.assignments for insert to authenticated with check (public.can_schedule(project_id, tech_id, kind));
create policy asg_update on public.assignments for update to authenticated
  using (public.can_schedule(project_id, tech_id, kind)) with check (public.can_schedule(project_id, tech_id, kind));
create policy asg_delete on public.assignments for delete to authenticated using (public.can_schedule(project_id, tech_id, kind));

grant select, insert, update, delete on public.techs, public.assignments to authenticated;
revoke all on public.techs, public.assignments from anon;
revoke execute on function public.can_schedule(uuid, uuid, text) from public, anon;
grant execute on function public.can_schedule(uuid, uuid, text) to authenticated;

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin execute 'alter publication supabase_realtime add table public.assignments, public.techs';
    exception when duplicate_object then null; end;
  end if;
end $$;

-- Job numbers, names and PMs for everyone on the operations side, so the
-- manpower board can label every job (no money, no detail).
create or replace function public.ops_project_directory()
returns table (id uuid, number text, name text, department text, pm_id uuid, phase text, start_date date, end_date date)
language sql stable security definer set search_path = public as $$
  select p.id, p.number, p.name, p.department, p.pm_id, p.phase, p.start_date, p.end_date
  from projects p where public.my_ops_role() is not null and p.phase <> 'closed';
$$;
revoke execute on function public.ops_project_directory() from public, anon;
grant execute on function public.ops_project_directory() to authenticated;
