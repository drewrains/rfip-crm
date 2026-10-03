-- =====================================================================
-- RFIP — SharePoint folder per deal. Run after ops_schema.sql. Safe to re-run.
--
-- When a deal is created, the app asks the "sharepoint" Edge Function to
-- create its folder in the Sales SharePoint site:
--   <year>/<Account> – <Deal name>/Sales/…  and  …/Operations/…
-- The folder's link is saved on the deal and copied to the project when the
-- deal is won and accepted, so sales and operations share one folder.
-- Only the Edge Function (service role) writes these columns.
-- =====================================================================

alter table public.deals    add column if not exists sharepoint_url     text;
alter table public.deals    add column if not exists sharepoint_item_id text;
alter table public.deals    add column if not exists sharepoint_status  text check (sharepoint_status in ('waiting','ready','error'));
alter table public.deals    add column if not exists sharepoint_error   text;
alter table public.projects add column if not exists sharepoint_url     text;

-- the project inherits its deal's folder
create or replace function public.project_sharepoint_from_deal() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.deal_id is not null and new.sharepoint_url is null then
    new.sharepoint_url := (select sharepoint_url from deals where id = new.deal_id);
  end if;
  return new;
end $$;
drop trigger if exists projects_sharepoint on public.projects;
create trigger projects_sharepoint before insert on public.projects
  for each row execute function public.project_sharepoint_from_deal();

-- people can't overwrite the folder link by hand; only the Edge Function sets it
create or replace function public.guard_deal_sharepoint() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('request.jwt.claims', true)::jsonb->>'role', '') <> 'service_role'
     and auth.uid() is not null then
    new.sharepoint_url := old.sharepoint_url; new.sharepoint_item_id := old.sharepoint_item_id;
    new.sharepoint_status := old.sharepoint_status; new.sharepoint_error := old.sharepoint_error;
  end if;
  return new;
end $$;
drop trigger if exists deals_sharepoint_guard on public.deals;
create trigger deals_sharepoint_guard before update of sharepoint_url, sharepoint_item_id, sharepoint_status, sharepoint_error on public.deals
  for each row execute function public.guard_deal_sharepoint();

revoke execute on function public.project_sharepoint_from_deal(), public.guard_deal_sharepoint() from public, anon, authenticated;
