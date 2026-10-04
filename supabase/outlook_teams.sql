-- RFIP — keep the Teams join link on each meeting. Safe to re-run.
alter table public.meetings add column if not exists join_url text;
select count(*) filter (where column_name = 'join_url') = 1 as teams_ready
from information_schema.columns where table_schema = 'public' and table_name = 'meetings';
