-- =====================================================================
-- RFIP Operations — material purchasing and receiving.
-- Run after ops_schema.sql. Safe to re-run.
--
-- Each material line tracks quantity needed → ordered → received, with
-- the distributor, PO, part number and unit cost. Deliveries are logged as
-- receipts (who, when, how many, packing slip); the line's received
-- quantity and status follow the receipts automatically.
-- PMs, department leads and admins manage the list and orders. Foremen on
-- the job can log deliveries from the field.
-- =====================================================================

alter table public.materials add column if not exists part_no      text;
alter table public.materials add column if not exists manufacturer text;
alter table public.materials add column if not exists uom          text not null default 'ea';
alter table public.materials add column if not exists unit_cost    numeric(12,2);
alter table public.materials add column if not exists distributor  text;
alter table public.materials add column if not exists po_number    text;
alter table public.materials add column if not exists qty_ordered  numeric(12,2) not null default 0;
alter table public.materials add column if not exists ordered_on   date;
alter table public.materials add column if not exists sort         integer not null default 0;

create table if not exists public.material_receipts (
  id           uuid primary key default gen_random_uuid(),
  material_id  uuid not null references public.materials(id) on delete cascade,
  project_id   uuid not null references public.projects(id) on delete cascade,
  qty          numeric(12,2) not null check (qty <> 0),
  received_on  date not null default current_date,
  received_by  uuid references public.profiles(id) on delete set null default auth.uid(),
  packing_slip text,
  note         text,
  created_at   timestamptz not null default now()
);
create index if not exists receipts_material_idx on public.material_receipts(material_id);

-- Keep the line's received quantity and status in step with its receipts and order.
create or replace function public.sync_material_status() returns trigger
language plpgsql security definer set search_path = public as $$
declare mid uuid := coalesce(new.material_id, old.material_id);
begin
  -- the materials_status trigger below re-derives the status from the new total
  update materials m set received = coalesce((select sum(qty) from material_receipts r where r.material_id = m.id), 0)
  where m.id = mid;
  return null;
end $$;
drop trigger if exists receipts_sync on public.material_receipts;
create trigger receipts_sync after insert or update or delete on public.material_receipts
  for each row execute function public.sync_material_status();

create or replace function public.material_status_on_order() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.status <> 'backordered' or new.received >= new.qty then
    new.status := case
      when new.received >= new.qty and new.qty > 0 then 'received'
      when new.received > 0 then 'partial'
      when new.qty_ordered > 0 then 'ordered'
      else 'to_order' end;
  end if;
  return new;
end $$;
drop trigger if exists materials_status on public.materials;
create trigger materials_status before insert or update of qty, qty_ordered, received, status on public.materials
  for each row execute function public.material_status_on_order();

alter table public.material_receipts enable row level security;
do $$ declare r record; begin
  for r in select policyname from pg_policies where schemaname = 'public' and tablename = 'material_receipts' loop
    execute format('drop policy if exists %I on public.material_receipts', r.policyname);
  end loop;
end $$;
create policy rcpt_read   on public.material_receipts for select to authenticated using (public.ops_can_see(project_id));
create policy rcpt_insert on public.material_receipts for insert to authenticated
  with check (public.ops_can_see(project_id) and received_by = auth.uid()
              and exists (select 1 from public.materials m where m.id = material_id and m.project_id = material_receipts.project_id));
create policy rcpt_delete on public.material_receipts for delete to authenticated using (received_by = auth.uid() or public.ops_can_edit(project_id));
grant select, insert, delete on public.material_receipts to authenticated;
revoke all on public.material_receipts from anon;
revoke execute on function public.sync_material_status(), public.material_status_on_order() from public, anon, authenticated;

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin execute 'alter publication supabase_realtime add table public.material_receipts';
    exception when duplicate_object then null; end;
  end if;
end $$;
