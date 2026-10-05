-- =====================================================================
-- RFIP — beta prep. Run after outlook_schema.sql. Safe to re-run.
--   1. Turning someone off on the Team page also removes their stored Outlook sign-in,
--      so RFIP can no longer send email or invites as them.
--   2. Beta feedback: the "Report a problem" button saves here (and emails Drew).
-- =====================================================================

-- ---------- 1. turned off = Outlook access gone too ----------
create or replace function public.drop_ms_token_when_off() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.active = false and coalesce(old.active, true) = true then
    delete from public.ms_tokens where profile_id = new.id;
  end if;
  return new;
end $$;
revoke execute on function public.drop_ms_token_when_off() from public, anon, authenticated;
drop trigger if exists profiles_drop_ms_token on public.profiles;
create trigger profiles_drop_ms_token after update of active on public.profiles
  for each row execute function public.drop_ms_token_when_off();
-- anyone already turned off
delete from public.ms_tokens t using public.profiles p where p.id = t.profile_id and p.active = false;

-- ---------- 2. beta feedback ----------
create table if not exists public.feedback (
  id         uuid primary key default gen_random_uuid(),
  author_id  uuid references public.profiles(id) on delete set null default auth.uid(),
  kind       text not null default 'problem' check (kind in ('problem','idea','question')),
  message    text not null check (length(trim(message)) > 0),
  page       text,
  browser    text,
  status     text not null default 'new' check (status in ('new','doing','done','wont')),
  admin_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists feedback_created_idx on public.feedback(created_at desc);
alter table public.feedback enable row level security;
drop policy if exists feedback_insert on public.feedback;
drop policy if exists feedback_read on public.feedback;
drop policy if exists feedback_update on public.feedback;
create policy feedback_insert on public.feedback for insert to authenticated with check (public.is_active_user() and author_id = auth.uid());
create policy feedback_read   on public.feedback for select to authenticated using (public.is_admin() or author_id = auth.uid());
create policy feedback_update on public.feedback for update to authenticated using (public.is_admin()) with check (public.is_admin());
grant select, insert, update on public.feedback to authenticated;
revoke all on public.feedback from anon;

select
  exists(select 1 from pg_trigger where tgname = 'profiles_drop_ms_token') as offboarding_ready,
  to_regclass('public.feedback') is not null as feedback_ready;
