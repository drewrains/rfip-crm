-- =====================================================================
-- RFIP — team access. Run after ops_schema.sql. Safe to re-run.
--
-- 1. PMs see every project across departments (to help each other and
--    borrow crews), but still change only the projects they're PM on.
-- 2. Roles can be set up before someone's first sign-in: put their email
--    in profile_presets and the first Microsoft sign-in gives them that
--    access. Admins manage the list; the preset is used once.
-- =====================================================================

-- ---------- PMs see all projects ---------------------------------------
create or replace function public.ops_can_see(p uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select case public.my_ops_role()
    when 'admin'  then true
    when 'viewer' then true
    when 'pm'     then true
    when 'lead'   then exists (select 1 from projects where id = p and (department = public.my_department() or pm_id = auth.uid()))
    when 'field'  then exists (select 1 from crew_roster where project_id = p and profile_id = auth.uid())
    else false end;
$$;

-- ---------- access set up ahead of the first sign-in --------------------
create table if not exists public.profile_presets (
  email      text primary key check (email = lower(email)),
  full_name  text,
  role       text not null default 'rep' check (role in ('admin','rep')),
  ops_role   text check (ops_role is null or ops_role in ('viewer','lead','pm','field')),
  department text,
  created_at timestamptz not null default now()
);
alter table public.profile_presets enable row level security;
drop policy if exists presets_admin on public.profile_presets;
create policy presets_admin on public.profile_presets for all to authenticated using (public.is_admin()) with check (public.is_admin());
grant select, insert, update, delete on public.profile_presets to authenticated;
revoke all on public.profile_presets from anon;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  cfg app_config;
  pre profile_presets;
  em  text := lower(coalesce(new.email, ''));
  dom text := split_part(em, '@', 2);
begin
  select * into cfg from app_config where id;
  if em = '' or not (dom = any (cfg.allowed_domains)) then
    raise exception 'Sign-in is limited to RFIP accounts.';
  end if;
  select * into pre from profile_presets where email = em;
  insert into profiles (id, email, full_name, role, ops_role, department)
  values (
    new.id, em,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', pre.full_name, split_part(em,'@',1)),
    case when em = any (cfg.admin_emails) then 'admin' else coalesce(pre.role, 'rep') end,
    pre.ops_role, pre.department)
  on conflict (id) do nothing;
  delete from profile_presets where email = em;
  return new;
end $$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
