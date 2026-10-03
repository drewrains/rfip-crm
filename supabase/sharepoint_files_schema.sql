-- =====================================================================
-- RFIP — files live in SharePoint. Run after sharepoint_schema.sql and
-- docs_updates_schema.sql. Safe to re-run.
--
-- Uploads from a deal or project go straight into its SharePoint folder
-- (through the "sharepoint" Edge Function). Project uploads still get a row
-- in public.documents so notes, who uploaded it and closeout links keep
-- working; the row points at the SharePoint file instead of the storage
-- bucket (path = 'sp:<item id>'). Files people add in SharePoint or Teams
-- show up in the app without a row. Older files in the storage bucket keep
-- working as before.
-- =====================================================================

alter table public.documents add column if not exists sp_item_id text;
alter table public.documents add column if not exists sp_url     text;
create unique index if not exists documents_sp_item_idx on public.documents(sp_item_id) where sp_item_id is not null;

-- a project without a deal gets its own folder; one with a deal shares the deal's
alter table public.projects add column if not exists sharepoint_item_id text;
