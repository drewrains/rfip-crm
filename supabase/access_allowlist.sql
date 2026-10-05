-- =====================================================================
-- RFIP — only people an admin has set up can sign in. Safe to re-run.
-- A new sign-in is allowed only when the email has a row in profile_presets
-- (added by an admin); anyone else in the Microsoft tenant is turned away.
-- Presets can also switch the sales side off (sales_access).
-- =====================================================================
alter table public.profile_presets add column if not exists sales_access boolean not null default true;

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
  if pre.email is null and not (em = any (cfg.admin_emails)) then
    raise exception 'Not set up in RFIP yet. Ask an admin to add you.';
  end if;
  insert into profiles (id, email, full_name, role, ops_role, department, sales_access)
  values (
    new.id, em,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', pre.full_name, split_part(em,'@',1)),
    case when em = any (cfg.admin_emails) then 'admin' else coalesce(pre.role, 'rep') end,
    pre.ops_role, pre.department, coalesce(pre.sales_access, true))
  on conflict (id) do nothing;
  delete from profile_presets where email = em;
  return new;
end $$;

update public.profile_presets set sales_access = false where email = 'mtran@rfip.com';
