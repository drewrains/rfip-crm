-- =====================================================================
-- RFIP — "Vendor Quotes" folder (Sales/08 Vendor Quotes) on every deal and project. Safe to re-run.
-- The SharePoint function makes the folder the first time anyone opens a deal's or project's
-- files; this lets project documents be filed there. Vendor pricing is treated like the
-- estimate: people who can see the project's money can read it, the project's editors can add to it.
-- =====================================================================
alter table public.documents drop constraint if exists documents_folder_check;
alter table public.documents add constraint documents_folder_check check (folder = any (array['contract','scope','vendor_quotes','submittals',
  'drawings','change_orders','pay_apps','field','tests','closeout','safety']));

create or replace function public.doc_can(p uuid, folder text, action text) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when p is null then false
    when action = 'read' then
      case when folder in ('contract','scope','vendor_quotes','pay_apps') then public.ops_can_see_money(p)
           when folder = 'expenses' then public.ops_can_see_money(p) or public.is_finance()
           else public.ops_can_see(p) end
    when action = 'write' then
      public.ops_can_edit(p)
      or (folder = 'expenses' and public.ops_can_see(p))
      or (public.my_ops_role() = 'field' and public.ops_can_see(p) and folder in ('field','tests','safety'))
    else false end;
$$;
