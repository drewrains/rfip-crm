-- =====================================================================
-- RFIP — RFP checklists and task import on the sales side. Run after schema.sql. Safe to re-run.
--
--   * Each deal gets the RFP's key dates (released, questions due, pre-bid / site walk) next to
--     Bid due, plus an addenda log (number, date, what changed, acknowledged).
--   * "Start RFP checklist" on a deal turns a checklist into ordinary tasks, each due a set number
--     of days before or after one of those dates and assigned by deal-team role (account manager,
--     sales engineer, estimator). When a date moves, the open checklist tasks move with it.
--   * Checklists live in rfp_templates. Everyone can use them; admins edit them.
--   * Tasks can also be imported from Excel (Settings > Import, or a deal's RFP tab).
-- =====================================================================

alter table public.deals add column if not exists rfp_released date;
alter table public.deals add column if not exists questions_due date;
alter table public.deals add column if not exists prebid_on date;
alter table public.deals add column if not exists addenda jsonb not null default '[]'::jsonb;

-- checklist tasks remember which date they hang off and by how much, so they can follow it
alter table public.tasks add column if not exists anchor text;
alter table public.tasks add column if not exists offset_days int;
alter table public.tasks add column if not exists sort int;
alter table public.tasks add column if not exists rfp_role text;
alter table public.tasks drop constraint if exists tasks_anchor_check;
alter table public.tasks add constraint tasks_anchor_check
  check (anchor is null or anchor in ('bid_due','questions_due','prebid_on','rfp_released'));
create index if not exists tasks_deal_idx on public.tasks(deal_id) where deal_id is not null;

create table if not exists public.rfp_templates (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  steps       jsonb not null default '[]'::jsonb,   -- [{title, role, anchor, days}]
  is_default  boolean not null default false,
  updated_by  uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.rfp_templates enable row level security;
drop policy if exists rfpt_read on public.rfp_templates;
create policy rfpt_read on public.rfp_templates for select to authenticated using (public.is_active_user());
drop policy if exists rfpt_write on public.rfp_templates;
create policy rfpt_write on public.rfp_templates for all to authenticated using (public.is_admin()) with check (public.is_admin());
grant select, insert, update, delete on public.rfp_templates to authenticated;
revoke all on public.rfp_templates from anon;

insert into public.rfp_templates (name, is_default, steps) values
('Standard RFP', true, '[
  {"title":"Go/no-go decision","role":"owner","anchor":"bid_due","days":-21},
  {"title":"Read the RFP and build the compliance matrix","role":"sales_engineer","anchor":"bid_due","days":-18},
  {"title":"Attend the site walk / pre-bid","role":"sales_engineer","anchor":"prebid_on","days":0},
  {"title":"Submit questions","role":"owner","anchor":"questions_due","days":0},
  {"title":"Takeoff and bill of materials","role":"estimator","anchor":"bid_due","days":-10},
  {"title":"Vendor and sub quotes in","role":"estimator","anchor":"bid_due","days":-8},
  {"title":"Technical narrative / scope write-up","role":"sales_engineer","anchor":"bid_due","days":-7},
  {"title":"Pricing review and margin sign-off","role":"owner","anchor":"bid_due","days":-4},
  {"title":"Forms, bonds, insurance, W-9 and certifications","role":"owner","anchor":"bid_due","days":-3},
  {"title":"All addenda acknowledged","role":"owner","anchor":"bid_due","days":-2},
  {"title":"Final review of the full package","role":"owner","anchor":"bid_due","days":-2},
  {"title":"Submit the bid and save the confirmation","role":"owner","anchor":"bid_due","days":0}
]'::jsonb),
('GC bid (quick turn)', false, '[
  {"title":"Go/no-go decision","role":"owner","anchor":"bid_due","days":-10},
  {"title":"Review drawings and specs","role":"sales_engineer","anchor":"bid_due","days":-8},
  {"title":"Submit RFIs / questions","role":"sales_engineer","anchor":"questions_due","days":0},
  {"title":"Takeoff and bill of materials","role":"estimator","anchor":"bid_due","days":-5},
  {"title":"Vendor quotes in","role":"estimator","anchor":"bid_due","days":-3},
  {"title":"Inclusions / exclusions and price sign-off","role":"owner","anchor":"bid_due","days":-1},
  {"title":"Submit the bid","role":"owner","anchor":"bid_due","days":0}
]'::jsonb)
on conflict (name) do nothing;

-- live updates for the templates list
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'rfp_templates') then
    alter publication supabase_realtime add table public.rfp_templates;
  end if;
end $$;
