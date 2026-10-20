-- =====================================================================
-- RFIP — sell price next to cost on a project's cost breakout. Run after ops_schema.sql. Safe to re-run.
--
-- The project page's "Cost to complete" compares, for labor and each cost line (material,
-- subcontract, equipment, other): what we sell it for, what we budgeted it to cost, what we've
-- spent to date, what's left to spend, and the margin we're heading for.
--   * projects.labor_sell  — what the customer pays for labor
--   * cost_lines.sell      — what the customer pays for that line (material, sub, equipment…)
-- Anything of the contract not split out yet shows as its own line, so the totals always add up.
-- =====================================================================

alter table public.projects add column if not exists labor_sell numeric(14,2);
alter table public.cost_lines add column if not exists sell numeric(14,2);

-- labor is sold by the hour: cost rate (labor_rate) and sell rate; labor_sell = budgeted hours × sell rate
alter table public.projects add column if not exists labor_sell_rate numeric(10,2);

-- travel (hotels, per diem, mileage, flights) as its own cost line type
alter table public.cost_lines drop constraint if exists cost_lines_code_check;
alter table public.cost_lines add constraint cost_lines_code_check check (code in ('material','labor','subcontract','equipment','travel','other'));
