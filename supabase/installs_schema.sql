-- =====================================================================
-- RFIP Operations — installed quantities drive completion.
-- Run after materials_schema.sql. Safe to re-run.
--
-- Each material line can say how its work is counted in the field: an
-- install unit and quantity (120 boxes of cable = 208 drops; 186 APs = 186
-- APs), the labor hours each one takes, and which milestone it belongs to.
-- The crew logs what they installed (how many, where, when). From that the
-- app works out each milestone's progress and a suggested percent complete
-- for the job: installed labor hours ÷ planned labor hours. Milestones with
-- no material (testing, closeout) carry their own labor hours and the PM's
-- progress. The PM decides whether to use the suggestion.
-- Foremen on the job log installs; the PM, lead and admins set up the lines.
-- =====================================================================

alter table public.materials  add column if not exists install_unit   text;            -- blank = the purchase unit
alter table public.materials  add column if not exists install_qty    numeric(12,2);   -- blank = the quantity needed
alter table public.materials  add column if not exists labor_per_unit numeric(8,3);    -- labor hours per install unit
alter table public.materials  add column if not exists qty_installed  numeric(12,2) not null default 0;
alter table public.materials  add column if not exists milestone_id   uuid references public.milestones(id) on delete set null;
alter table public.milestones add column if not exists labor_hours    numeric(10,1);   -- for milestones with no material tied to them

create table if not exists public.material_installs (
  id           uuid primary key default gen_random_uuid(),
  material_id  uuid not null references public.materials(id) on delete cascade,
  project_id   uuid not null references public.projects(id) on delete cascade,
  qty          numeric(12,2) not null check (qty <> 0),
  installed_on date not null default current_date,
  installed_by uuid references public.profiles(id) on delete set null default auth.uid(),
  area         text,                     -- where: floor, section, IDF, site
  note         text,
  created_at   timestamptz not null default now()
);
create index if not exists installs_material_idx on public.material_installs(material_id);
create index if not exists installs_project_idx on public.material_installs(project_id, installed_on);

create or replace function public.sync_material_installed() returns trigger
language plpgsql security definer set search_path = public as $$
declare mid uuid := coalesce(new.material_id, old.material_id);
begin
  update materials m set qty_installed = coalesce((select sum(qty) from material_installs i where i.material_id = m.id), 0) where m.id = mid;
  return null;
end $$;
drop trigger if exists installs_sync on public.material_installs;
create trigger installs_sync after insert or update or delete on public.material_installs
  for each row execute function public.sync_material_installed();

alter table public.material_installs enable row level security;
do $$ declare r record; begin
  for r in select policyname from pg_policies where schemaname = 'public' and tablename = 'material_installs' loop
    execute format('drop policy if exists %I on public.material_installs', r.policyname);
  end loop;
end $$;
create policy inst_read   on public.material_installs for select to authenticated using (public.ops_can_see(project_id));
create policy inst_insert on public.material_installs for insert to authenticated
  with check (public.ops_can_see(project_id) and installed_by = auth.uid()
              and exists (select 1 from public.materials m where m.id = material_id and m.project_id = material_installs.project_id));
create policy inst_delete on public.material_installs for delete to authenticated using (installed_by = auth.uid() or public.ops_can_edit(project_id));
grant select, insert, delete on public.material_installs to authenticated;
revoke all on public.material_installs from anon;
revoke execute on function public.sync_material_installed() from public, anon, authenticated;

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin execute 'alter publication supabase_realtime add table public.material_installs';
    exception when duplicate_object then null; end;
  end if;
end $$;
