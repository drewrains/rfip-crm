-- =====================================================================
-- RFIP — Outlook email and calendar. Run after schema.sql and ops_schema.sql.
-- Safe to re-run.
--
-- Invites and alert emails go out from the person doing the work, through
-- their own Microsoft sign-in (delegated Graph permissions Mail.Send,
-- Calendars.ReadWrite, offline_access). The "outlook" Edge Function keeps a
-- refresh token per person so it can send for them; only the Edge Function
-- (service role) can read or write those tokens.
-- =====================================================================

-- ---------- per-person Microsoft token (Edge Function only) -------------
create table if not exists public.ms_tokens (
  profile_id    uuid primary key references public.profiles(id) on delete cascade,
  refresh_token text not null,
  scopes        text,
  updated_at    timestamptz not null default now()
);
alter table public.ms_tokens enable row level security;
-- no policies: signed-in people can't read or write this table at all
revoke all on public.ms_tokens from anon, authenticated;

-- ---------- meetings on a deal or project --------------------------------
create table if not exists public.meetings (
  id           uuid primary key default gen_random_uuid(),
  deal_id      uuid references public.deals(id) on delete cascade,
  project_id   uuid references public.projects(id) on delete cascade,
  kind         text not null default 'meeting' check (kind in ('site_walk','pre_bid','bid_due','kickoff','handoff','field','meeting')),
  subject      text not null,
  starts_at    timestamptz not null,
  ends_at      timestamptz not null,
  all_day      boolean not null default false,
  location     text,
  notes        text,
  online       boolean not null default false,
  attendees    jsonb not null default '[]'::jsonb,      -- [{email, name}]
  organizer_id uuid references public.profiles(id) on delete set null default auth.uid(),
  ms_event_id  text,
  web_link     text,
  status       text not null default 'scheduled' check (status in ('scheduled','cancelled')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (deal_id is not null or project_id is not null),
  check (ends_at >= starts_at)
);
create index if not exists meetings_deal_idx on public.meetings(deal_id, starts_at);
create index if not exists meetings_project_idx on public.meetings(project_id, starts_at);

-- who can see a meeting: anyone who can see its deal or its project
create or replace function public.can_see_meeting(d uuid, p uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select (d is not null and public.can_see_deal(d)) or (p is not null and (public.ops_can_see(p) or public.can_see_project(p)));
$$;

alter table public.meetings enable row level security;
drop policy if exists meetings_read on public.meetings;
create policy meetings_read on public.meetings for select to authenticated using (public.can_see_meeting(deal_id, project_id));
grant select on public.meetings to authenticated;
revoke all on public.meetings from anon;
-- meetings are written by the Edge Function (it creates the Outlook event first), never directly from the browser

revoke execute on function public.can_see_meeting(uuid, uuid) from public, anon;
grant execute on function public.can_see_meeting(uuid, uuid) to authenticated;
