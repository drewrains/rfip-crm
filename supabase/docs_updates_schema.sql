-- =====================================================================
-- RFIP Operations — project documents and weekly PM updates.
-- Run after ops_schema.sql. Safe to re-run.
--
-- Documents live in a private storage bucket, one folder per project with
-- the same standard sub-folders on every job. Who can open them:
--   * Contract and PO, Scope and estimate, Pay apps: people who can see the
--     project's money (admins, viewers, the department lead, the PM).
--   * Every other folder: everyone on the operations side who can see the
--     project, including the foreman on it.
-- Uploading: the PM, department lead and admins upload anywhere; foremen
-- upload field photos and daily reports, test results and safety.
-- Deleting: whoever uploaded the file, or the PM, lead or an admin.
--
-- Weekly updates: one per project per week, written by the PM (or lead).
-- =====================================================================

-- ---------- documents ------------------------------------------------
create table if not exists public.documents (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.projects(id) on delete cascade,
  folder           text not null check (folder in ('contract','scope','submittals','drawings','change_orders','pay_apps','field','tests','closeout','safety')),
  name             text not null,
  path             text not null unique,          -- storage path: <project_id>/<folder>/<file>
  size_bytes       bigint,
  mime_type        text,
  note             text,
  closeout_item_id uuid references public.closeout_items(id) on delete set null,
  uploaded_by      uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at       timestamptz not null default now()
);
create index if not exists documents_proj_idx on public.documents(project_id, folder);

create or replace function public.doc_can(p uuid, folder text, action text) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when p is null then false
    when action = 'read' then
      case when folder in ('contract','scope','pay_apps') then public.ops_can_see_money(p) else public.ops_can_see(p) end
    when action = 'write' then
      public.ops_can_edit(p) or (public.my_ops_role() = 'field' and public.ops_can_see(p) and folder in ('field','tests','safety'))
    else false end;
$$;

-- storage paths look like <project uuid>/<folder>/<file>; anything else is refused
create or replace function public.doc_path_project(path text) returns uuid
language sql immutable set search_path = public as $$
  select case when split_part(path, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then split_part(path, '/', 1)::uuid end;
$$;

alter table public.documents enable row level security;
do $$ declare r record; begin
  for r in select policyname from pg_policies where schemaname = 'public' and tablename = 'documents' loop
    execute format('drop policy if exists %I on public.documents', r.policyname);
  end loop;
end $$;
create policy docs_read   on public.documents for select to authenticated using (public.doc_can(project_id, folder, 'read'));
create policy docs_insert on public.documents for insert to authenticated with check (public.doc_can(project_id, folder, 'write') and uploaded_by = auth.uid());
create policy docs_update on public.documents for update to authenticated using (public.ops_can_edit(project_id)) with check (public.ops_can_edit(project_id));
create policy docs_delete on public.documents for delete to authenticated using (uploaded_by = auth.uid() or public.ops_can_edit(project_id));
grant select, insert, update, delete on public.documents to authenticated;
revoke all on public.documents from anon;

-- private bucket, 50 MB per file
insert into storage.buckets (id, name, public, file_size_limit)
values ('project-files', 'project-files', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

do $$ declare r record; begin
  for r in select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'rfip_files_%' loop
    execute format('drop policy if exists %I on storage.objects', r.policyname);
  end loop;
end $$;
create policy rfip_files_read on storage.objects for select to authenticated
  using (bucket_id = 'project-files' and public.doc_can(public.doc_path_project(name), split_part(name, '/', 2), 'read'));
create policy rfip_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'project-files' and public.doc_can(public.doc_path_project(name), split_part(name, '/', 2), 'write'));
create policy rfip_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'project-files' and (owner_id = auth.uid()::text or public.ops_can_edit(public.doc_path_project(name))));

-- ---------- weekly PM updates -------------------------------------------
create table if not exists public.weekly_updates (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects(id) on delete cascade,
  week_start      date not null check (extract(isodow from week_start) = 1),   -- the Monday of the week reported on
  author_id       uuid references public.profiles(id) on delete set null default auth.uid(),
  pct_complete    numeric(5,2) check (pct_complete between 0 and 100),
  schedule_status text not null default 'on_track' check (schedule_status in ('on_track','at_risk','off_track')),
  cost_status     text not null default 'on_track' check (cost_status in ('on_track','at_risk','off_track')),
  safety_status   text not null default 'on_track' check (safety_status in ('on_track','at_risk','off_track')),
  accomplished    text,
  next_week       text,
  needs           text,
  customer_notes  text,
  submitted_at    timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (project_id, week_start)
);
create index if not exists weekly_updates_week_idx on public.weekly_updates(week_start);

alter table public.weekly_updates enable row level security;
do $$ declare r record; begin
  for r in select policyname from pg_policies where schemaname = 'public' and tablename = 'weekly_updates' loop
    execute format('drop policy if exists %I on public.weekly_updates', r.policyname);
  end loop;
end $$;
-- read: ops people on the project, plus sales on the deal it came from
create policy wu_read  on public.weekly_updates for select to authenticated using (public.can_see_project(project_id));
create policy wu_write on public.weekly_updates for all to authenticated using (public.ops_can_edit(project_id)) with check (public.ops_can_edit(project_id));
grant select, insert, update, delete on public.weekly_updates to authenticated;
revoke all on public.weekly_updates from anon;

revoke execute on function public.doc_can(uuid, text, text) from public, anon;
grant execute on function public.doc_can(uuid, text, text) to authenticated;

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin execute 'alter publication supabase_realtime add table public.documents, public.weekly_updates';
    exception when duplicate_object then null; end;
  end if;
end $$;
