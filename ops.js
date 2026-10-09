/* RFIP Operations — the delivery side of the app: projects, the sales-to-ops
   handoff, budgets and labor, schedule, change orders, materials, field logs,
   crews, closeout, billing and safety. Plugs into app.js, which calls
   RFIP_OPS_INIT with its shared helpers. The database's row-level security
   decides what each person sees; these screens only arrange it. */
window.RFIP_OPS_INIT = core => {
"use strict";
const {h, sb, S, money, fmtDate, fmtDateTime, daysUntil, todayStr, run, toast, friendly, openDrawer, closeDrawer, fld, deleteButton,
  render, go, person, personName, activePeople, isAdmin, byId, acctName, emptyState, plural, nullify, spState, spLoad, spUpload, spDelete, notify, meetingsBox, readSheet: readBook, normDate} = core;
const tell = (...a) => { if (notify) notify(...a); };

// ---------------------------------------------------------------- data
const TABLES = {projects:"projects", handoffs:"handoffs", depts:"departments", costs:"cost_lines", labor:"labor_weeks", ms:"milestones",
  cos:"change_orders", mats:"materials", logs:"daily_logs", plan:"crew_plan", roster:"crew_roster", closeout:"closeout_items",
  bills:"billings", safety:"safety_events", techs:"techs", asg:"assignments", docs:"documents", wu:"weekly_updates", rcpts:"material_receipts",
  items:"plan_items", exps:"expenses", clinks:"customer_links", insts:"material_installs", members:"project_members", reqs:"customer_requests", issues:"project_issues"};
// added later than the rest; if a database hasn't been given these yet, the rest of operations still works
const OPTIONAL = new Set(["items", "exps", "clinks", "insts", "members", "reqs", "issues"]);
const KEY_OF = Object.fromEntries(Object.entries(TABLES).map(([k, t]) => [t, k]));
const O = {missing:false, detail:null, q:"", dept:"", pm:"", phase:"active", hand:true, mpMode:"week", mpDate:null, mpDept:""};
try { const m = localStorage.getItem("rfipops.mpMode"); if (m) O.mpMode = m; } catch (e) {}
for (const k of Object.keys(TABLES)) O[k] = [];
O.dir = []; O.docFolder = ""; O.wuWeek = null; O.off = new Set(); O.taskWho = "me"; O.reqView = "open"; O.reqDept = ""; O.issView = "open"; O.issDept = ""; O.sum = {by:"pm", id:""}; O.tl = {mode:"projects", span:6, start:null, dept:"", pm:"", open:new Set(), group:"dept", cal:null, show:{bars:true, ms:true, tasks:true, issues:true}};
try { const t = JSON.parse(localStorage.getItem("rfipops.tl") || "null"); if (t) Object.assign(O.tl, {mode:t.mode || "projects", span:t.span || 6, group:t.group || "dept", show:t.show || O.tl.show}); } catch (e) {}
try { const d = localStorage.getItem("rfipops.detail"); if (d) O.detail = d; } catch (e) {}

async function fetchTable(key) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const {data, error} = await sb.from(TABLES[key]).select("*").range(from, from + 999);
    if (error) { if (OPTIONAL.has(key)) O.off.add(key); else if (error.code === "42P01" || /does not exist|schema cache/i.test(error.message || "")) O.missing = true; return out; }
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}
async function reload(key) { O[key] = await fetchTable(key); CALC.clear(); }
async function load() {
  await reload("depts");
  if (O.missing) return;
  await Promise.all(Object.keys(TABLES).filter(k => k !== "depts").map(reload).concat([loadDir(), loadExpProj()]));
}
async function loadExpProj() {
  const {data, error} = await sb.rpc("expense_projects");
  O.expProj = error ? null : (data || []);
}
async function loadDir() {
  const {data, error} = await sb.rpc("ops_project_directory");
  O.dir = error ? [] : (data || []).sort((a, b) => a.number.localeCompare(b.number));
}
const waiting = new Set(); let timer = null;
function changed(table) {
  const key = KEY_OF[table]; if (!key) return;
  waiting.add(key); clearTimeout(timer);
  timer = setTimeout(async () => { const keys = [...waiting]; waiting.clear(); await Promise.all(keys.map(reload).concat(keys.includes("projects") ? [loadDir()] : [])); render(); }, 300);
}

// ---------------------------------------------------------------- who can do what
const role = () => !S.me ? null : S.me.role === "admin" ? "admin" : (S.me.ops_role || null);
const seesAll = () => ["admin", "viewer"].includes(role());
const canEdit = p => { const r = role(); return r === "admin" || p.pm_id === S.me.id || (r === "lead" && p.department === S.me.department); };
// the project plan can also be built by anyone the project is shared with
const canPlan = p => canEdit(p) || (O.members || []).some(m => m.project_id === p.id && m.profile_id === S.me.id);
const isOpsFor = ho => { const r = role(); return r === "admin" || ho.pm_id === S.me.id || (r === "lead" && (!ho.department || ho.department === S.me.department)); };
const deptKeys = () => O.depts.slice().sort((a, b) => a.sort - b.sort).map(d => d.key);
const dept = k => O.depts.find(d => d.key === k) || {};

// ---------------------------------------------------------------- helpers
const TODAY = todayStr();
const sum = (a, f) => a.reduce((x, y) => x + (Number(f(y)) || 0), 0);
const pct = (v, d = 0) => v == null || !isFinite(v) ? "—" : (v * 100).toFixed(d) + "%";
const compact = v => { const n = Number(v) || 0; if (!n) return "—"; const a = Math.abs(n);
  return (n < 0 ? "−" : "") + (a >= 1e6 ? "$" + (a / 1e6).toFixed(a >= 1e7 ? 1 : 2) + "M" : a >= 1e3 ? "$" + Math.round(a / 1e3) + "K" : "$" + Math.round(a)); };
const num = v => (Number(v) || 0).toLocaleString("en-US", {maximumFractionDigits: 1});
const addDays = (s, n) => { const [y, m, d] = s.split("-").map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return t.toISOString().slice(0, 10); };
const monthStart = s => s.slice(0, 7) + "-01";
const addMonths = (s, n) => { const [y, m] = s.split("-").map(Number); const t = new Date(Date.UTC(y, m - 1 + n, 1)); return t.toISOString().slice(0, 10); };
const monthLabel = s => { const [y, m] = s.split("-").map(Number); return new Date(y, m - 1, 1).toLocaleDateString("en-US", {month:"short"}) + " ’" + String(y).slice(2); };
const nextMonday = () => { const [y, m, d] = TODAY.split("-").map(Number); const t = new Date(Date.UTC(y, m - 1, d)); const dow = t.getUTCDay(); return addDays(TODAY, dow === 1 ? 0 : (8 - dow) % 7); };
const PHASES = [["mobilizing","Mobilizing","acc"],["in_progress","In progress",""],["closeout","Closeout","go"],["closed","Closed",""]];
const phaseName = p => (PHASES.find(x => x[0] === p) || PHASES[1])[1];
const chip = (cls, text, title) => h("span", {class:"chip" + (cls ? " " + cls : ""), title:title || null}, text);
const phaseChip = p => { const x = PHASES.find(y => y[0] === p) || PHASES[1]; return chip(x[2], x[1]); };
function tile(label, value, note, cls) {
  return h("div", {class:"o-tile" + (cls ? " " + cls : "")}, h("div", {class:"k"}, label), h("div", {class:"v"}, value), note ? h("div", {class:"s"}, note) : null);
}
function panel(title, sub, ...body) {
  return h("section", {class:"o-panel"}, h("header", null, h("h3", null, title), sub ? h("span", {class:"muted"}, sub) : null), ...body);
}
const svgNS = "http://www.w3.org/2000/svg";
function svg(tag, attrs, ...kids) {
  const n = document.createElementNS(svgNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) n.setAttribute(k, v);
  for (const k of kids.flat()) if (k != null) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return n;
}
async function saveRow(table, row, id) {
  const q = id ? sb.from(table).update(row).eq("id", id).select().single() : sb.from(table).insert(row).select().single();
  const res = await run(q, id ? "Saved" : "Added");
  if (res) { await reload(KEY_OF[table]); render(); }
  return res;
}

// ---------------------------------------------------------------- installed work
// Each material line is counted in the field in its install unit (208 drops, 186 APs) and
// carries labor hours per unit. Installed labor hours ÷ planned labor hours = a suggested
// percent complete. Milestones with no material carry their own hours and the PM's progress.
const instQty = m => Number(m.install_qty ?? m.qty) || 0;
const instUnit = m => m.install_unit || m.uom || "ea";
const instDone = m => Math.min(Number(m.qty_installed) || 0, instQty(m));
function installCalc(mats, ms) {
  const lpu = m => Number(m.labor_per_unit) || 0;
  const lines = mats.filter(m => lpu(m) > 0);
  let plan = sum(lines, m => instQty(m) * lpu(m)), earned = sum(lines, m => instDone(m) * lpu(m));
  const tied = new Set(mats.filter(m => m.milestone_id).map(m => m.milestone_id));
  const msOnly = ms.filter(x => Number(x.labor_hours) > 0 && !tied.has(x.id));
  for (const x of msOnly) { const hrs = Number(x.labor_hours); plan += hrs; earned += hrs * (x.actual ? 1 : Math.min(100, Number(x.progress) || 0) / 100); }
  const byMs = new Map();
  for (const x of ms) {
    const ls = mats.filter(m => m.milestone_id === x.id); if (!ls.length) continue;
    const hl = ls.filter(m => lpu(m) > 0);
    const pl = hl.length ? sum(hl, m => instQty(m) * lpu(m)) : sum(ls, instQty), ea = hl.length ? sum(hl, m => instDone(m) * lpu(m)) : sum(ls, instDone);
    byMs.set(x.id, {lines:ls, pct: pl ? ea / pl : 0, plan:pl, earned:ea, hours:hl.length > 0});
  }
  return {plan, earned, pct: plan > 0 ? earned / plan : null, lines, byMs, msOnly};
}
const instSummary = ls => ls.map(m => (ls.length > 1 || !m.install_unit ? m.item.replace(/\s*\(.*?\)\s*$/, "") + " " : "") + num(Number(m.qty_installed) || 0) + "/" + num(instQty(m)) + (m.install_unit ? " " + m.install_unit : "")).join(" · ");

// ---------------------------------------------------------------- project math
const CALC = new Map();
function calc(p) {
  if (CALC.has(p.id)) return CALC.get(p.id);
  const cos = O.cos.filter(c => c.project_id === p.id);
  const coAppr = sum(cos.filter(c => c.status === "approved"), c => c.amount);
  const coPend = sum(cos.filter(c => c.status === "pending"), c => c.amount);
  const unpriced = cos.filter(c => c.status === "not_priced").length;
  const total = (Number(p.contract_value) || 0) + coAppr;
  const done = (Number(p.pct_complete) || 0) / 100;
  const lw = O.labor.filter(l => l.project_id === p.id).sort((a, b) => a.week_start.localeCompare(b.week_start));
  const hu = sum(lw, l => l.hours), hb = Number(p.hours_budget) || 0, rate = Number(p.labor_rate) || 68;
  const projH = done > .05 ? hu / done : Math.max(hb, hu);
  const cl = O.costs.filter(c => c.project_id === p.id).sort((a, b) => a.sort - b.sort);
  const nlBud = sum(cl, c => c.budget), nlFc = sum(cl, c => c.forecast ?? c.budget), nlAct = sum(cl, c => c.actual);
  const ex = O.exps.filter(e => e.project_id === p.id);
  const expAppr = sum(ex.filter(e => e.status === "approved"), e => e.amount), expPend = sum(ex.filter(e => ["submitted", "pm_approved"].includes(e.status)), e => e.amount);
  const budCost = hb * rate + nlBud, fcCost = projH * rate + nlFc + expAppr;
  const bills = O.bills.filter(b => b.project_id === p.id);
  const billed = sum(bills.filter(b => b.kind === "billed"), b => b.amount);
  const earned = total * done;
  const ms = O.ms.filter(m => m.project_id === p.id).sort((a, b) => (a.planned || "").localeCompare(b.planned || "") || a.sort - b.sort);
  const late = ms.filter(m => !m.actual && m.planned && daysUntil(m.planned) < -5);
  const mats = O.mats.filter(m => m.project_id === p.id);
  const inst = installCalc(mats, ms);
  const closeout = O.closeout.filter(c => c.project_id === p.id).sort((a, b) => a.sort - b.sort);
  const roster = scheduleRoster(p.id);
  const staffed = new Set(O.asg.filter(a => a.project_id === p.id && a.work_date >= TODAY && a.work_date <= addDays(TODAY, 14)).map(a => a.tech_id)).size;
  const r = {
    cos, coAppr, coPend, unpriced, total, done, ex, expAppr, expPend, lw, hu, hb, rate, projH, cl, nlBud, nlFc, nlAct, budCost, fcCost,
    estM: total ? (total - budCost) / total : 0, fcM: total ? (total - fcCost) / total : 0, fade: fcCost - budCost,
    bills, billed, earned, ready: Math.max(0, earned - billed), backlog: Math.max(0, total - earned), left: Math.max(0, total - billed),
    retH: billed * (Number(p.retainage_pct) || 0) / 100,
    earnH: done * hb, burn: hb ? hu / hb : 0, prod: hu > 0 && done > .05 ? (done * hb) / hu : null,
    ms, late, lateDays: late.length ? Math.max(...late.map(m => -daysUntil(m.planned))) : 0,
    mats, inst, matOpen: mats.filter(m => m.status !== "received"), backordered: mats.filter(m => m.status === "backordered"),
    closeout, docsOpen: closeout.filter(c => c.status !== "done"), roster, staffed: O.techs.length ? staffed : roster.length,
    elapsed: p.start_date && p.end_date ? Math.min(1, Math.max(0, -daysUntil(p.start_date) / Math.max(1, daysUntil(p.end_date) - daysUntil(p.start_date)))) : null,
  };
  CALC.set(p.id, r);
  return r;
}
const active = () => O.projects.filter(p => p.phase !== "closed");
const openHandoffs = () => O.handoffs.filter(x => !["accepted", "cancelled"].includes(x.status));
const handoffDeal = ho => byId(S.deals, ho.deal_id) || {};
const handoffName = ho => handoffDeal(ho).name || "Won deal";
const handoffValue = ho => Number((ho.packet || {}).contract_value) || Number(handoffDeal(ho).value) || 0;

function alertsFor(list) {
  const out = [];
  for (const p of list) {
    const c = calc(p), where = p.number + " · " + p.name + " · " + personName(p.pm_id);
    if (p.phase === "in_progress" && c.burn >= .8 && c.done < .8) out.push({sev:"crit", tag:"Labor", what:`Labor ${pct(c.burn)} used at ${pct(c.done)} complete`, where, p});
    else if (p.phase === "in_progress" && c.done > .05 && c.burn > c.done + .1) out.push({sev:"warn", tag:"Labor", what:`Labor running ahead of progress (${pct(c.burn)} used, ${pct(c.done)} complete)`, where, p});
    if (c.fcM < c.estM - .05 && c.total) out.push({sev:"crit", tag:"Margin", what:`Margin forecast ${pct(c.fcM)} vs ${pct(c.estM)} budgeted · about ${compact(c.fade)} at risk`, where, p});
    if (c.lateDays) out.push({sev: c.lateDays > 7 ? "crit" : "warn", tag:"Schedule", what:`${c.late[0].name} is ${c.lateDays} days late`, where, p});
    if (p.phase === "mobilizing" && p.start_date && daysUntil(p.start_date) <= 14) {
      const gaps = [];
      if (!c.staffed) gaps.push("no crew scheduled");
      if (c.matOpen.length) gaps.push(plural(c.matOpen.length, "material line") + " not received");
      if (gaps.length) out.push({sev: c.staffed ? "warn" : "crit", tag:"Mobilize", what:`Starts ${fmtDate(p.start_date)} with ${gaps.join(" and ")}`, where, p});
    }
    for (const m of c.backordered) out.push({sev:"warn", tag:"Material", what:`${m.item} backordered${m.eta ? " to " + fmtDate(m.eta) : ""}`, where, p});
    if (c.coPend) out.push({sev:"warn", tag:"Change order", what:`${compact(c.coPend)} in change orders waiting on the customer`, where, p});
    if (c.unpriced) out.push({sev:"warn", tag:"Change order", what:`${plural(c.unpriced, "change order")} logged but not priced`, where, p});
    const lateItems = O.items.filter(i => i.project_id === p.id && isLate(i));
    if (lateItems.length) out.push({sev: lateItems.length > 3 ? "crit" : "warn", tag:"Plan", what:`${plural(lateItems.length, "plan task")} overdue` + (lateItems.length === 1 ? `: ${lateItems[0].title}` : ""), where, p});
    const lateIss = O.issues.filter(i => i.project_id === p.id && issLate(i)), hiIss = O.issues.filter(i => i.project_id === p.id && issOpen(i) && i.priority === "high" && !issLate(i));
    if (lateIss.length) out.push({sev: lateIss.some(i => i.priority === "high") ? "crit" : "warn", tag:"Issue",
      what: lateIss.length === 1 ? `Issue next step overdue (${issOwner(lateIss[0])}): ${lateIss[0].title}` : `${plural(lateIss.length, "issue")} with an overdue next step`, where, p});
    if (hiIss.length) out.push({sev:"warn", tag:"Issue", what:`${plural(hiIss.length, "high-priority issue")} open` + (hiIss.length === 1 ? `: ${hiIss[0].title}` : ""), where, p});
    if (O.wu.length && updateState(p).missing) out.push({sev:"warn", tag:"Update", what:"Weekly update missing for the week of " + fmtDate(reportWeek()), where, p});
    if (p.phase === "closeout" && (c.docsOpen.length || c.ready > 1000)) {
      const bits = []; if (c.docsOpen.length) bits.push(plural(c.docsOpen.length, "closeout item") + " open"); if (c.ready > 1000) bits.push(compact(c.ready) + " not billed");
      out.push({sev:"warn", tag:"Closeout", what:`Work complete, ${bits.join(", ")}`, where, p});
    }
  }
  return out.sort((a, b) => (a.sev === b.sev ? 0 : a.sev === "crit" ? -1 : 1));
}
function alertList(list, limit) {
  const al = alertsFor(list);
  if (!al.length) return h("div", {class:"empty"}, "Nothing needs attention right now.");
  return h("ul", {class:"o-alerts"}, al.slice(0, limit || 99).map(a => h("li", {onclick:() => openProject(a.p.id), tabindex:"0", onkeydown: e => { if (e.key === "Enter") openProject(a.p.id); }},
    h("span", {class:"stripe " + a.sev}), h("div", null, h("div", {class:"what"}, a.what), h("div", {class:"where"}, a.where)), h("span", {class:"tag"}, a.tag))));
}

// ---------------------------------------------------------------- capacity
function weeksAhead(n) { const w0 = nextMonday(); return Array.from({length:n}, (_, i) => addDays(w0, i * 7)); }
function handoffTechs(ho, wk) {
  const pk = ho.packet || {}; const hrs = Number(pk.labor_hours); if (!hrs || !pk.start_date || !pk.end_date) return 0;
  if (wk < addDays(pk.start_date, -6) || wk > pk.end_date) return 0;
  const weeks = Math.max(1, Math.ceil((daysUntil(pk.end_date) - daysUntil(pk.start_date)) / 7));
  return hrs / 40 / weeks;
}
function crewLoad(deptKey, weeks) {
  const projs = O.projects.filter(p => !deptKey || p.department === deptKey).map(p => p.id);
  return weeks.map(wk => ({wk, booked: sum(O.plan.filter(x => x.week_start === wk && projs.includes(x.project_id)), x => x.techs),
    need: sum(openHandoffs().filter(x => !deptKey || x.department === deptKey), x => handoffTechs(x, wk))}));
}
function daysSafe(deptKey) {
  const ev = O.safety.filter(e => e.kind === "recordable" && (!deptKey || e.department === deptKey)).map(e => e.event_date).sort();
  return ev.length ? -daysUntil(ev[ev.length - 1]) : null;
}

// ---------------------------------------------------------------- strip
function strip(el) {
  el.hidden = ["ops-overview", "ops-manpower", "ops-expenses", "ops-timeline", "ops-summary"].includes(S.view);
  if (el.hidden) return;
  if (!role() || (S.view === "handoffs" && S.section !== "ops")) {
    const mine = O.handoffs.filter(x => x.status !== "cancelled");
    el.replaceChildren(
      core.metric("Waiting on sales", String(mine.filter(x => ["packet", "kicked_back"].includes(x.status)).length), "packet to finish or fix"),
      core.metric("Kicked back", String(mine.filter(x => x.status === "kicked_back").length), "ops needs more information", mine.some(x => x.status === "kicked_back")),
      core.metric("In ops review", String(mine.filter(x => x.status === "review").length), "submitted, waiting on a PM"),
      core.metric("Accepted", String(mine.filter(x => x.status === "accepted").length), "now projects"));
    return;
  }
  const ps = active(), cs = ps.map(calc);
  const tot = sum(cs, c => c.total);
  const act = ps.filter(p => p.phase === "in_progress").map(calc).filter(c => c.prod != null);
  const prod = sum(act, c => c.hu) ? sum(act, c => c.earnH) / sum(act, c => c.hu) : null;
  const safeAll = O.depts.map(d => daysSafe(d.key)).filter(v => v != null);
  const showMoney = role() !== "field";
  el.replaceChildren(...[
    core.metric("Backlog", showMoney ? compact(sum(cs, c => c.backlog)) : String(ps.length), showMoney ? plural(ps.length, "active project") : "active projects"),
    showMoney ? core.metric("Ready to bill", compact(sum(cs, c => c.ready)), "earned, not invoiced") : null,
    showMoney ? core.metric("Margin forecast", tot ? pct(sum(cs, c => c.total * c.fcM) / tot) : "—", tot ? "budget " + pct(sum(cs, c => c.total * c.estM) / tot) : "", tot && sum(cs, c => c.total * c.fcM) / tot < sum(cs, c => c.total * c.estM) / tot - .02) : null,
    core.metric("Labor productivity", prod == null ? "—" : prod.toFixed(2), "earned ÷ worked hours", prod != null && prod < .9),
    role() === "field" ? null : core.metric("Handoffs waiting", String(openHandoffs().length), compact(sum(openHandoffs(), handoffValue)) + " won, not started", openHandoffs().some(x => x.status === "kicked_back")),
    core.metric("Days safe", safeAll.length ? String(Math.min(...safeAll)) : "—", "since last recordable")].filter(Boolean));
}

// ---------------------------------------------------------------- overview
function viewOverview() {
  const wrap = h("div", {class:"o-stack"});
  const ps = active(); const cs = ps.map(calc);
  if (!O.projects.length && !O.handoffs.length) { wrap.append(h("div", {class:"panel"}, emptyState("No projects yet", "Projects appear here when a won deal's handoff is accepted."))); return wrap; }
  const byPh = ph => ps.filter(p => p.phase === ph);
  const ho = openHandoffs();
  const stage = (label, n, amt, note, flag, onclick) => h("button", {class:"o-stage", onclick}, h("span", {class:"k"}, label),
    h("span", {class:"row"}, h("b", null, n), h("small", null, amt)), h("span", {class:"s"}, note), flag ? h("span", {class:"flag"}, flag) : null);
  const mob = byPh("mobilizing"), inp = byPh("in_progress"), clo = byPh("closeout");
  const mobNoCrew = mob.filter(p => !calc(p).staffed).length;
  wrap.append(h("div", {class:"o-flow"},
    stage("Waiting on handoff", String(ho.length), compact(sum(ho, handoffValue)), "Won, not yet accepted",
      ho.filter(x => x.status === "kicked_back").length ? h("span", {class:"bad-t"}, plural(ho.filter(x => x.status === "kicked_back").length, "kicked back")) : null, () => go("ops-handoffs")),
    stage("Mobilizing", String(mob.length), compact(sum(mob.map(calc), c => c.total)), "Starting soon", mobNoCrew ? h("span", {class:"bad-t"}, mobNoCrew + " with no crew") : null, () => { O.phase = "mobilizing"; go("ops-projects"); }),
    stage("In progress", String(inp.length), compact(sum(inp.map(calc), c => c.backlog)) + " left", "Crews on site",
      inp.filter(p => calc(p).lateDays).length ? h("span", {class:"warn-t"}, inp.filter(p => calc(p).lateDays).length + " behind schedule") : null, () => { O.phase = "in_progress"; go("ops-projects"); }),
    stage("Closeout", String(clo.length), compact(sum(clo.map(calc), c => c.ready)) + " unbilled", "Paperwork and final billing",
      sum(clo.map(calc), c => c.docsOpen.length) ? h("span", {class:"warn-t"}, plural(sum(clo.map(calc), c => c.docsOpen.length), "item") + " open") : null, () => { O.phase = "closeout"; go("ops-projects"); }),
    stage("Ready to bill", compact(sum(cs, c => c.ready)), "", "Earned, not invoiced · " + compact(sum(cs, c => c.retH)) + " retainage held", null, () => go("ops-billing"))));

  // headline measures
  const tot = sum(cs, c => c.total), estM = tot ? sum(cs, c => c.total * c.estM) / tot : 0, fcM = tot ? sum(cs, c => c.total * c.fcM) / tot : 0;
  const capMo = sum(O.depts.filter(d => seesAll() || role() !== "lead" || d.key === S.me.department), d => d.monthly_capacity);
  const backlog = sum(cs, c => c.backlog), hoV = sum(ho, handoffValue);
  const act = ps.filter(p => p.phase === "in_progress").map(calc).filter(c => c.prod != null);
  const prod = sum(act, c => c.hu) ? sum(act, c => c.earnH) / sum(act, c => c.hu) : null;
  const behind = ps.filter(p => calc(p).lateDays).length;
  const safe = O.depts.map(d => [d.key, daysSafe(d.key)]).filter(x => x[1] != null).sort((a, b) => a[1] - b[1]);
  const near = O.safety.filter(e => e.kind === "near_miss" && daysUntil(e.event_date) >= -30).length;
  wrap.append(h("div", {class:"o-tiles"},
    tile("Backlog", compact(backlog), capMo ? (backlog / capMo).toFixed(1) + " months of work · " + ((backlog + hoV) / capMo).toFixed(1) + " with handoffs" : ""),
    tile("Margin forecast", pct(fcM), (fcM < estM - .005 ? "Down from " : "Budget ") + pct(estM) + (fcM < estM - .005 ? " · about " + compact(sum(cs, c => Math.max(0, c.fade))) + " at risk" : ""), fcM < estM - .02 ? "bad" : ""),
    tile("Labor productivity", prod == null ? "—" : prod.toFixed(2), "Earned hours per hour worked · target 1.00", prod != null && prod < .95 ? "bad" : ""),
    tile("Behind schedule", behind + " of " + ps.length, "Projects with a milestone 5+ days late", behind ? "warn" : ""),
    tile("Safety", safe.length ? safe[0][1] + " days" : "—", safe.length ? "Since last recordable (" + safe[0][0] + ") · " + near + (near === 1 ? " near-miss" : " near-misses") + " in 30 days" : "")));

  // capacity + risks
  const weeks = weeksAhead(8);
  const myDepts = role() === "lead" ? [S.me.department] : deptKeys();
  const load = weeks.map((wk, i) => ({wk, booked: sum(myDepts.map(k => crewLoad(k, weeks)[i].booked), x => x), need: sum(myDepts.map(k => crewLoad(k, weeks)[i].need), x => x)}));
  const avail = sum(O.depts.filter(d => myDepts.includes(d.key)), d => d.techs);
  const over = load.filter(x => x.booked > avail), low = load.filter(x => x.booked < avail * .6);
  wrap.append(h("div", {class:"o-two"},
    panel("Crew capacity, next 8 weeks", "Techs booked against " + avail + " available",
      h("div", {class:"o-pad"}, capacityChart(load, avail),
        h("div", {class:"o-keys"}, h("span", null, h("i", {class:"sw acc"}), "Booked on projects"), h("span", null, h("i", {class:"sw acc soft"}), "Needed once waiting handoffs start"), h("span", null, h("i", {class:"sw line"}), "Available")),
        h("p", {class:"o-sum"}, over.length ? "Over capacity the weeks of " + over.map(x => fmtDate(x.wk)).join(", ") + ". " : "Within capacity for the next 8 weeks. ",
          low.length ? "By " + fmtDate(low[low.length - 1].wk) + " only " + low[low.length - 1].booked + " of " + avail + " techs are booked, so waiting handoffs need to start on time." : ""))),
    panel("Needs attention", plural(alertsFor(ps).length, "item"), alertList(ps, 7))));

  // departments
  const rows = deptKeys().filter(k => myDepts.includes(k)).map(k => {
    const dp = ps.filter(p => p.department === k), dc = dp.map(calc), t = sum(dc, c => c.total), d = dept(k);
    const actD = dp.filter(p => p.phase === "in_progress").map(calc).filter(c => c.prod != null);
    const pr = sum(actD, c => c.hu) ? sum(actD, c => c.earnH) / sum(actD, c => c.hu) : null;
    const cl = crewLoad(k, weeks.slice(0, 4)), ld = d.techs ? sum(cl, x => x.booked) / (d.techs * 4) : 0, peak = d.techs ? Math.max(...cl.map(x => x.booked)) / d.techs : 0;
    const bl = sum(dc, c => c.backlog), months = d.monthly_capacity ? (bl + sum(ho.filter(x => x.department === k), handoffValue)) / d.monthly_capacity : null;
    const em = t ? sum(dc, c => c.total * c.estM) / t : 0, fm = t ? sum(dc, c => c.total * c.fcM) / t : 0;
    const late = dp.filter(p => calc(p).lateDays).length;
    let st = ["go", "On track"];
    if (fm < em - .05) st = ["bad", "Margin slipping"]; else if (peak > 1) st = ["bad", "Over capacity"]; else if (late) st = ["warn", "Behind schedule"]; else if (months != null && months < 2) st = ["warn", "Thin backlog"];
    return {k, d, dp, bl, months, em, fm, pr, ld, peak, late, st};
  });
  wrap.append(panel("Departments", "Delivery health by department", h("div", {class:"tbl-wrap flat"}, h("table", null,
    h("thead", null, h("tr", null, h("th", null, "Department"), ["Active", "Backlog", "Months of work", "Margin budget → fcst", "Labor productivity", "Behind"].map(t => h("th", {class:"num"}, t)), h("th", null, "Crew, next 4 weeks"), h("th", {class:"num"}, "Days safe"), h("th", null, "Status"))),
    h("tbody", null, rows.map(r => h("tr", {class:"click", onclick:() => { O.dept = r.k; go("ops-projects"); }},
      h("td", null, h("b", null, r.k), h("div", {class:"muted small"}, r.d.lead_id ? personName(r.d.lead_id) : "")),
      h("td", {class:"num"}, String(r.dp.filter(p => p.phase !== "closeout").length)), h("td", {class:"num"}, compact(r.bl)),
      h("td", {class:"num" + (r.months != null && r.months < 2 ? " warn-t" : "")}, r.months == null ? "—" : r.months.toFixed(1)),
      h("td", {class:"num"}, pct(r.em), " → ", h("span", {class: r.fm < r.em - .02 ? "bad-t" : ""}, pct(r.fm))),
      h("td", {class:"num" + (r.pr != null && r.pr < .9 ? " bad-t" : "")}, r.pr == null ? "—" : r.pr.toFixed(2)),
      h("td", {class:"num" + (r.late ? " warn-t" : "")}, r.late ? String(r.late) : "—"),
      h("td", null, h("span", {class:"minibar inline"}, h("i", {class: r.peak > 1 ? "bad" : r.ld >= .9 ? "warn" : "go", style:"width:" + Math.min(100, r.ld * 100) + "%"})), " ", pct(r.ld), r.peak > 1 ? h("span", {class:"muted small"}, " peak " + pct(r.peak)) : null),
      h("td", {class:"num"}, daysSafe(r.k) == null ? "—" : String(daysSafe(r.k))),
      h("td", null, chip(r.st[0], r.st[1])))))))));

  // starts and closeouts
  const starts = [
    ...O.projects.filter(p => p.phase === "mobilizing").map(p => ({name:p.name, sub:p.number + " · " + p.department, date:p.start_date, p,
      crew: calc(p).staffed ? ["go-t", calc(p).staffed + " scheduled"] : ["bad-t", "None scheduled"],
      mat: calc(p).matOpen.length ? [calc(p).matOpen.length > 2 ? "bad-t" : "warn-t", plural(calc(p).matOpen.length, "line") + " open"] : ["go-t", "All received"],
      ready: !calc(p).staffed ? ["bad", "Not ready"] : calc(p).matOpen.length ? ["warn", "At risk"] : ["go", "Ready"]})),
    ...ho.filter(x => (x.packet || {}).start_date && daysUntil(x.packet.start_date) <= 45).map(x => ({name:handoffName(x), sub:"Handoff · " + (x.department || "No department"), date:x.packet.start_date, ho:x,
      crew:["muted", x.pm_id ? "PM: " + personName(x.pm_id) : "No PM yet"], mat:["muted", "—"],
      ready: x.status === "kicked_back" ? ["bad", "Kicked back"] : x.status === "review" ? ["acc", "In ops review"] : ["warn", "Packet open"]}))]
    .sort((a, b) => (a.date || "9").localeCompare(b.date || "9"));
  const closeouts = O.projects.filter(p => p.phase === "closeout" || (p.phase === "in_progress" && p.end_date && daysUntil(p.end_date) <= 60))
    .sort((a, b) => (a.end_date || "").localeCompare(b.end_date || ""));
  wrap.append(h("div", {class:"o-two even"},
    panel("Starting soon", "Is each job ready to mobilize?", starts.length ? h("div", {class:"tbl-wrap flat"}, h("table", null,
      h("thead", null, h("tr", null, ["Job", "Start", "Crew", "Material", "Ready"].map(t => h("th", null, t)))),
      h("tbody", null, starts.map(s => h("tr", {class:"click", onclick:() => s.p ? openProject(s.p.id) : openHandoff(s.ho.id)},
        h("td", null, h("b", null, s.name), h("div", {class:"muted small"}, s.sub)), h("td", {class:"mono"}, fmtDate(s.date)),
        h("td", {class:s.crew[0]}, s.crew[1]), h("td", {class:s.mat[0]}, s.mat[1]), h("td", null, chip(s.ready[0], s.ready[1])))))))
      : h("div", {class:"empty"}, "No starts in the next few weeks.")),
    panel("Closeouts", compact(sum(closeouts.map(calc), c => c.retH)) + " retainage waiting", closeouts.length ? h("div", {class:"tbl-wrap flat"}, h("table", null,
      h("thead", null, h("tr", null, h("th", null, "Job"), h("th", {class:"num"}, "Items open"), h("th", {class:"num"}, "Unbilled"), h("th", {class:"num"}, "Retainage"), h("th", null, "Status"))),
      h("tbody", null, closeouts.map(p => { const c = calc(p); return h("tr", {class:"click", onclick:() => openProject(p.id)},
        h("td", null, h("b", null, p.name), h("div", {class:"muted small"}, p.number + " · " + (p.phase === "closeout" ? "work complete" : "due " + fmtDate(p.end_date)))),
        h("td", {class:"num"}, String(c.docsOpen.length)), h("td", {class:"num"}, c.ready > 1000 ? compact(c.ready) : "—"), h("td", {class:"num"}, compact(c.retH)),
        h("td", null, p.phase !== "closeout" ? chip("", "Upcoming") : c.docsOpen.length > 1 ? chip("bad", "Items holding invoice") : c.docsOpen.length ? chip("warn", "Final items due") : chip("go", "Ready to close"))); }))))
      : h("div", {class:"empty"}, "No closeouts coming up."))));
  return wrap;
}
function capacityChart(load, avail) {
  const W = 640, H = 220, L = 34, R = 10, T = 18, B = 26;
  const yMax = Math.max(10, Math.ceil(Math.max(avail * 1.25, ...load.map(x => x.booked + x.need)) / 10) * 10);
  const bw = (W - L - R) / load.length, ys = v => T + (1 - v / yMax) * (H - T - B);
  const g = [];
  const step = yMax / 5;
  for (let v = 0; v <= yMax + .1; v += step) g.push(svg("line", {x1:L, x2:W - R, y1:ys(v), y2:ys(v), class:"grid"}), svg("text", {x:L - 6, y:ys(v) + 4, "text-anchor":"end"}, Math.round(v)));
  load.forEach((x, i) => {
    const bx = L + i * bw + bw * .2, w = bw * .6, b = x.booked, n = Math.round(x.need * 10) / 10;
    if (b) g.push(svg("rect", {x:bx, y:ys(b), width:w, height:ys(0) - ys(b), rx:3, class: b > avail ? "bar bad" : "bar"}, svg("title", null, fmtDate(x.wk) + ": " + b + " booked")));
    if (n >= .5) g.push(svg("rect", {x:bx, y:ys(b + n), width:w, height:ys(b) - ys(b + n), rx:3, class:"bar soft"}, svg("title", null, fmtDate(x.wk) + ": about " + Math.round(n) + " more once handoffs start")));
    g.push(svg("text", {x:bx + w / 2, y:ys(b + n) - 5, "text-anchor":"middle", class:"lbl"}, Math.round(b + n)));
    g.push(svg("text", {x:bx + w / 2, y:H - 8, "text-anchor":"middle"}, fmtDate(x.wk)));
  });
  g.push(svg("line", {x1:L, x2:W - R, y1:ys(avail), y2:ys(avail), class:"target"}));
  return svg("svg", {viewBox:`0 0 ${W} ${H}`, class:"o-chart", role:"img", "aria-label":"Techs booked by week against " + avail + " available"}, g);
}

// ---------------------------------------------------------------- sharing a project with other PMs
// A PM sees only their own projects. The project's PM (or the lead or an admin) can add another
// PM or lead here so they can see it too; changes stay with the project's PM.
function sharedRow(p, edit) {
  const mine = O.members.filter(m => m.project_id === p.id);
  const pick = activePeople().filter(x => (x.ops_role === "pm" || x.ops_role === "lead") && x.id !== p.pm_id && !mine.some(m => m.profile_id === x.id))
    .sort((a, b) => (a.full_name || a.email).localeCompare(b.full_name || b.email));
  if (!mine.length && !edit) return "";
  const sel = h("select", {"aria-label":"Add someone to this project"}, h("option", {value:""}, "Add a PM…"),
    pick.map(x => h("option", {value:x.id}, (x.full_name || x.email) + (x.department ? " · " + x.department : ""))));
  return h("div", {class:"o-crm"}, h("span", {class:"k"}, "Shared with"),
    mine.length ? mine.map(m => h("span", {class:"chip-x"}, h("b", null, personName(m.profile_id)),
      edit ? h("button", {class:"linkish", "aria-label":"Remove " + personName(m.profile_id), onclick: async () => {
        if (await run(sb.from("project_members").delete().eq("id", m.id), "Removed")) { await reload("members"); render(); } }}, "×") : null))
      : h("span", {class:"muted"}, "Only the PM and department lead see this job. People you share it with can see it and build the project plan."),
    edit && pick.length ? h("span", null, sel, " ", h("button", {class:"btn small", onclick: async () => {
      if (!sel.value) { toast("Pick someone first."); return; }
      if (await run(sb.from("project_members").insert({project_id:p.id, profile_id:sel.value}), "Shared")) { await reload("members"); render(); } }}, "Add")) : null);
}

// ---------------------------------------------------------------- projects list
function viewProjects() {
  const wrap = h("div", {class:"o-stack"});
  const pms = [...new Set(O.projects.map(p => p.pm_id).filter(Boolean))];
  wrap.append(h("div", {class:"toolbar"}, h("h2", null, "Projects"),
    h("input", {type:"search", id:"q-ops", placeholder:"Search projects, customers, #", value:O.q, "aria-label":"Search projects", oninput: e => { O.q = e.target.value; render(); }}),
    deptKeys().length > 1 && role() !== "pm" && role() !== "field" ? h("select", {"aria-label":"Department", id:"o-dept", onchange: e => { O.dept = e.target.value; render(); }},
      h("option", {value:""}, "All departments"), deptKeys().map(k => h("option", {value:k, selected:O.dept === k}, k))) : null,
    pms.length > 1 ? h("select", {"aria-label":"Project manager", id:"o-pm", onchange: e => { O.pm = e.target.value; render(); }},
      h("option", {value:""}, "All PMs"), pms.map(id => h("option", {value:id, selected:O.pm === id}, personName(id)))) : null,
    h("select", {"aria-label":"Phase", id:"o-phase", onchange: e => { O.phase = e.target.value; render(); }},
      [["active", "Active"], ["all", "All phases"], ...PHASES.map(x => [x[0], x[1]])].map(([v, t]) => h("option", {value:v, selected:O.phase === v}, t)))));
  const q = O.q.trim().toLowerCase();
  const list = O.projects.filter(p => (!O.dept || p.department === O.dept) && (!O.pm || p.pm_id === O.pm)
    && (O.phase === "all" ? true : O.phase === "active" ? p.phase !== "closed" : p.phase === O.phase)
    && (!q || [p.name, p.number, acctName(p.account_id), personName(p.pm_id)].join(" ").toLowerCase().includes(q)))
    .sort((a, b) => (calc(a).fcM - calc(a).estM) - (calc(b).fcM - calc(b).estM) || a.number.localeCompare(b.number));
  if (!O.projects.length) { wrap.append(h("div", {class:"panel"}, emptyState("No projects yet", role() === "field" ? "Projects show here once you're on a crew roster." : "Projects appear when a won deal's handoff is accepted."))); return wrap; }
  const money = role() !== "field";
  if (role() !== "field") wrap.append(panel("Needs attention", plural(alertsFor(list).length, "item"), alertList(list, 8)));
  wrap.append(h("div", {class:"tbl-wrap"}, h("table", null,
    h("thead", null, h("tr", null, h("th", null, "Project"), h("th", null, "Dept"), h("th", null, "PM"), h("th", null, "Phase"),
      money ? h("th", {class:"num"}, "Contract") : null, h("th", {class:"num"}, "Complete"), h("th", null, "Labor hours used"),
      money ? h("th", {class:"num"}, "Margin budget → fcst") : null, money ? h("th", {class:"num"}, "Ready to bill") : null, h("th", null, "Weekly update"), h("th", null, "Flags"))),
    h("tbody", null, list.length ? list.map(p => { const c = calc(p); const bc = c.burn >= .8 && c.done < .8 ? "bad" : c.burn > c.done + .1 ? "warn" : "";
      return h("tr", {class:"click", tabindex:"0", onclick:() => openProject(p.id), onkeydown: e => { if (e.key === "Enter") openProject(p.id); }},
        h("td", null, h("b", null, p.name), h("div", {class:"muted small"}, p.number + " · " + (acctName(p.account_id) || "") + (p.parent_id ? " · phase of " + (proj(p.parent_id).number || "program") : isProgram(p) ? " · program, " + plural(kidsOf(p.id).length, "phase") : ""))),
        h("td", null, p.department), h("td", null, personName(p.pm_id)), h("td", null, phaseChip(p.phase)),
        money ? h("td", {class:"num"}, compact(c.total), c.coAppr ? h("div", {class:"muted small"}, "incl. " + compact(c.coAppr) + " CO") : null) : null,
        h("td", {class:"num"}, pct(c.done)),
        h("td", null, h("div", {class:"burn"}, h("div", {class:"track"}, h("i", {class:bc, style:"width:" + Math.min(100, c.burn * 100) + "%"}), h("b", {style:"left:calc(" + Math.min(100, c.done * 100) + "% - 1px)", title:"Percent complete"})),
          h("small", {class:"mono"}, num(c.hu) + " / " + num(c.hb) + " hrs"))),
        money ? h("td", {class:"num"}, pct(c.estM), " → ", h("span", {class: c.fcM < c.estM - .02 ? "bad-t" : ""}, pct(c.fcM))) : null,
        money ? h("td", {class:"num"}, c.ready > 1000 ? compact(c.ready) : "—") : null,
        h("td", null, (st => st.u ? h("span", {class:"chips"}, stChip(worstOf(st.u))) : chip(st.cls, st.text))(updateState(p))),
        h("td", null, h("span", {class:"chips"}, c.lateDays ? chip("warn", c.lateDays + "d late") : null, c.backordered.length ? chip("warn", "Backorder") : null,
          c.coPend ? chip("acc", "CO pending") : null, p.phase === "mobilizing" && !c.staffed ? chip("bad", "No crew") : null)));
    }) : h("tr", null, h("td", {colspan:"10", class:"empty"}, "No projects match these filters."))))));
  return wrap;
}

// ---------------------------------------------------------------- project page
function openProject(id) { O.detail = id; try { localStorage.setItem("rfipops.detail", id); } catch (e) {} core.closeDrawer(); go("ops-project"); }
function viewProject() {
  const p = byId(O.projects, O.detail);
  const wrap = h("div", {class:"o-stack"});
  const back = h("button", {class:"linkish back", onclick:() => go(S.section === "ops" ? "ops-projects" : "handoffs")}, "← All projects");
  if (!p) { wrap.append(back, h("div", {class:"panel"}, emptyState("That project isn't available to you", "Pick one from the projects list."))); return wrap; }
  const c = calc(p), edit = canEdit(p), opsView = !!role(), money = opsView && role() !== "field";
  const deal = byId(S.deals, p.deal_id), ho = O.handoffs.find(x => x.project_id === p.id);
  const lead = dept(p.department).lead_id;
  wrap.append(back);
  wrap.append(h("div", {class:"o-head"},
    h("div", null, h("div", {class:"eyebrow"}, "Job " + p.number + " · " + p.department),
      h("h2", null, p.name),
      h("div", {class:"meta"}, h("span", null, "Customer ", h("b", null, acctName(p.account_id) || "—")), h("span", null, "PM ", h("b", null, personName(p.pm_id))),
        lead ? h("span", null, "Dept lead ", h("b", null, personName(lead))) : null,
        h("span", null, fmtDate(p.start_date) + " → ", h("b", null, fmtDate(p.end_date))), phaseChip(p.phase))),
    h("div", {class:"o-head-r"}, p.end_date && p.phase !== "closed" ? h("div", {class:"muted"}, daysUntil(p.end_date) >= 0 ? h("b", {class:"mono"}, String(daysUntil(p.end_date))) : null, daysUntil(p.end_date) >= 0 ? " days to completion" : "Past planned completion") : null,
      edit ? h("button", {class:"btn primary", onclick:() => openProgress(p)}, "Update progress") : null)));
  const par = p.parent_id ? (byId(O.projects, p.parent_id) || proj(p.parent_id)) : null;
  if (p.parent_id || p.po_number) wrap.append(h("div", {class:"o-crm prog-link"},
    par ? [h("span", {class:"k"}, "Program"), h("span", null, "Phase of ", byId(O.projects, p.parent_id) ? h("button", {class:"linkish", onclick:() => openProject(p.parent_id)}, (par.number || "") + " · " + (par.name || "")) : h("b", null, (par.number || "") + " · " + (par.name || "")))] : null,
    p.po_number ? h("span", null, "Customer PO ", h("b", {class:"mono"}, p.po_number)) : null));
  if (featureOn("members")) wrap.append(sharedRow(p, edit));
  wrap.append(h("div", {class:"o-crm"}, h("span", {class:"k"}, "From the CRM"),
    h("span", null, "Sold by ", h("b", null, personName(p.sold_by || (deal && deal.owner_id)))),
    deal && deal.close_date ? h("span", null, "Won ", h("b", null, fmtDate(deal.close_date)), " at ", h("b", {class:"mono"}, compact(deal.value))) : null,
    p.sold_margin != null && money ? h("span", null, "Margin at handoff ", h("b", {class:"mono"}, Number(p.sold_margin).toFixed(0) + "%")) : null,
    ho && ho.accepted_at ? h("span", null, "Accepted ", h("b", null, fmtDate(ho.accepted_at.slice(0, 10))), ho.kickbacks ? " after " + plural(ho.kickbacks, "kick-back") : "") : null,
    deal ? h("button", {class:"linkish", onclick:() => core.openDeal(deal.id)}, "Open deal") : null,
    ho ? h("button", {class:"linkish", onclick:() => openHandoff(ho.id)}, "Handoff packet") : null,
    p.sharepoint_url ? h("a", {class:"linkish", href:p.sharepoint_url, target:"_blank", rel:"noopener"}, "SharePoint folder") : null));

  const prog = opsView && isProgram(p);
  if (!prog) wrap.append(h("div", {class:"o-tiles"},
    money ? tile("Contract", compact(c.total), compact(p.contract_value) + " original" + (c.coAppr ? " + " + compact(c.coAppr) + " approved COs" : "")) : null,
    tile("Complete vs schedule", pct(c.done), c.elapsed == null ? "" : pct(c.elapsed) + " of schedule elapsed", c.elapsed != null && c.done < c.elapsed - .1 ? "warn" : ""),
    c.inst.pct != null ? tile("Installed work", pct(c.inst.pct), "Suggested % complete · PM has " + pct(c.done), Math.abs(c.inst.pct - c.done) >= .05 ? "warn" : "") : null,
    tile("Labor hours used", pct(c.burn), num(c.hu) + " of " + num(c.hb) + " budgeted", c.burn >= .8 && c.done < .8 ? "bad" : ""),
    money ? tile("Margin forecast", pct(c.fcM), (c.fcM < c.estM - .005 ? "Down from " : "Budget ") + pct(c.estM), c.fcM < c.estM - .02 ? "bad" : "") : null,
    money ? tile("Ready to bill", compact(c.ready), "Billed " + compact(c.billed) + " · " + compact(c.retH) + " retainage held") : null));

  if (!prog && (opsView && role() !== "field" || O.wu.some(u => u.project_id === p.id))) wrap.append(updatePanel(p, c, edit));
  if (prog) wrap.append(...programPanels(p));
  if (opsView && featureOn("issues") && !prog) wrap.append(issuePanel(p));
  if (opsView && featureOn("items") && !prog) wrap.append(planPanel(p, canPlan(p)));
  if (role() === "field") wrap.append(logPanel(p));
  if (opsView) {
    const over = Math.round(c.projH - c.hb);
    wrap.append(h("div", {class:"o-two"},
      panel("Labor hours: plan, actual, earned", "Cumulative by week", h("div", {class:"o-pad"}, laborChart(p, c),
        h("div", {class:"o-keys"}, h("span", null, h("i", {class:"sw line dash"}), "Budget plan"), h("span", null, h("i", {class:"sw acc"}), "Actual hours"), h("span", null, h("i", {class:"sw go"}), "Earned hours"), h("span", null, h("i", {class:"sw bad dot"}), "Forecast at current rate")),
        c.done > .05 ? h("p", {class:"o-sum" + (over > 0 ? " bad-box" : "")}, over > 0
          ? `At the current rate this job finishes at about ${num(Math.round(c.projH))} hours, ${num(over)} over budget` + (money ? ` (${compact(over * c.rate)}).` : ".")
          : `At the current rate this job finishes at about ${num(Math.round(c.projH))} hours, ${num(-over)} under budget.`) : null,
        edit ? h("div", {class:"o-actions"}, h("button", {class:"btn small", onclick:() => openHours(p)}, "Enter weekly hours")) : null)),
      milestonesPanel(p, c, edit)));
  } else wrap.append(milestonesPanel(p, c, false));

  if (money) wrap.append(costPanel(p, c, edit));
  if (opsView) wrap.append(matPanel(p, c, edit));
  wrap.append(h("div", {class:"o-two even"}, opsView && role() !== "field" ? logPanel(p) : null, h("div", {class:"o-stack"}, opsView ? coPanel(p, c, edit, money) : null, rosterPanel(p, c, edit), closeoutPanel(p, c, edit))));
  if (opsView && featureOn("exps") && !prog) wrap.append(expensePanel(p));
  if (opsView) wrap.append(docsPanel(p));
  if (opsView && role() !== "field" && meetingsBox) wrap.append(panel("Meetings", "Outlook invites sent from the person who schedules them",
    h("div", {class:"o-pad"}, meetingsBox({project_id:p.id}, {subject:p.number + " " + p.name, account_id:p.account_id,
      people:[p.pm_id, ...O.roster.filter(r => r.project_id === p.id).map(r => r.profile_id)].filter(Boolean),
      kinds:["kickoff", "field", "meeting", "handoff"]}))));
  if (featureOn("clinks") && (edit || role() === "viewer")) wrap.append(customerPanel(p, edit));
  if (money) wrap.append(projectBilling(p, c, edit));
  return wrap;
}
function laborChart(p, c) {
  const W = 640, H = 250, L = 46, R = 78, T = 14, B = 28;
  const start = p.start_date ? addDays(p.start_date, -((new Date(p.start_date + "T12:00:00").getDay() + 6) % 7)) : (c.lw[0] || {}).week_start;
  if (!start) return h("div", {class:"empty"}, "No hours recorded yet.");
  const weeksTotal = Math.max(c.lw.length, p.end_date ? Math.ceil((daysUntil(p.end_date) - daysUntil(start)) / 7) + 1 : c.lw.length, 2);
  const widx = wk => Math.round((daysUntil(wk) - daysUntil(start)) / 7) + 1;
  let cum = 0; const actual = c.lw.map(l => { cum += Number(l.hours) || 0; return [widx(l.week_start), cum]; });
  const earned = c.lw.filter(l => l.pct_complete != null).map(l => [widx(l.week_start), Number(l.pct_complete) / 100 * c.hb]);
  const plan = Array.from({length:weeksTotal + 1}, (_, i) => { const x = i / weeksTotal; return [i, c.hb * (3 * x * x - 2 * x * x * x)]; });
  const yMax = Math.max(c.hb, c.projH, cum) * 1.12 || 10;
  const xs = i => L + i / weeksTotal * (W - L - R), ys = v => T + (1 - v / yMax) * (H - T - B);
  const path = pts => "M" + xs(0) + "," + ys(0) + " " + pts.map(([i, v]) => "L" + xs(i).toFixed(1) + "," + ys(v).toFixed(1)).join(" ");
  const g = [];
  const step = yMax > 8000 ? 2000 : yMax > 3000 ? 1000 : yMax > 800 ? 250 : 100;
  for (let v = 0; v <= yMax; v += step) g.push(svg("line", {x1:L, x2:W - R, y1:ys(v), y2:ys(v), class:"grid"}), svg("text", {x:L - 6, y:ys(v) + 4, "text-anchor":"end"}, v >= 1000 ? v / 1000 + "k" : v));
  for (let i = 1; i <= weeksTotal; i += Math.max(1, Math.round(weeksTotal / 6))) g.push(svg("text", {x:xs(i), y:H - 8, "text-anchor":"middle"}, "wk " + i));
  const now = Math.min(weeksTotal, (daysUntil(TODAY) - daysUntil(start)) / 7 + 1);
  g.push(svg("line", {x1:xs(now), x2:xs(now), y1:T, y2:H - B, class:"today"}), svg("text", {x:xs(now) + 4, y:T + 10}, "today"));
  g.push(svg("path", {d:path(plan.slice(1)), class:"ln plan"}));
  if (earned.length) g.push(svg("path", {d:path(earned), class:"ln earned"}));
  if (actual.length) {
    g.push(svg("path", {d:path(actual), class:"ln actual"}));
    const [li, lv] = actual[actual.length - 1];
    if (c.done > .05 && p.phase !== "closeout") {
      g.push(svg("path", {d:`M${xs(li)},${ys(lv)} L${xs(weeksTotal)},${ys(c.projH)}`, class:"ln fcst"}));
      g.push(svg("circle", {cx:xs(weeksTotal), cy:ys(c.projH), r:4, class:"pt bad"}), svg("text", {x:xs(weeksTotal) + 7, y:ys(c.projH) + 4, class:"bad-t"}, num(Math.round(c.projH))));
    }
    g.push(svg("circle", {cx:xs(li), cy:ys(lv), r:4, class:"pt acc"}));
  }
  g.push(svg("text", {x:xs(weeksTotal) + 7, y:ys(c.hb) + 4}, num(c.hb) + " bud"));
  return svg("svg", {viewBox:`0 0 ${W} ${H}`, class:"o-chart", role:"img", "aria-label":`Cumulative labor hours: ${num(c.hu)} worked, ${num(Math.round(c.earnH))} earned, against a ${num(c.hb)} hour budget`}, g);
}
function milestonesPanel(p, c, edit) {
  const done = c.ms.filter(m => m.actual).length;
  return panel("Schedule", plural(done, "milestone") + " of " + c.ms.length + " done",
    c.ms.length ? h("ul", {class:"o-ms"}, c.ms.map(m => {
      const ip = c.inst.byMs.get(m.id), prog = ip ? Math.round(ip.pct * 100) : Number(m.progress) || 0;
      const late = m.actual ? daysUntil(m.actual) - daysUntil(m.planned) : (m.planned && daysUntil(m.planned) < 0 ? -daysUntil(m.planned) : 0);
      const st = m.actual ? (late > 0 ? "late" : "done") : (prog ? "now" : late > 5 ? "overdue" : "");
      return h("li", {class: edit ? "click" : null, onclick: edit ? () => openMilestone(p, m) : null},
        h("span", {class:"dot " + st}),
        h("div", null, h("div", {class:"t"}, m.name), m.note ? h("small", null, m.note) : null,
          !m.actual && late > 5 ? h("small", {class:"bad-t"}, late + " days past plan") : null,
          prog && !m.actual ? h("div", {class:"prog"}, h("i", {style:"width:" + Math.min(100, prog) + "%"})) : null,
          ip && !m.actual ? h("small", {class:"inst-note"}, prog + "% installed · " + instSummary(ip.lines)) : null),
        h("div", {class:"d"}, fmtDate(m.actual || m.planned), h("small", null, m.actual ? (late > 0 ? "plan " + fmtDate(m.planned) : "done") : "planned")));
    })) : h("div", {class:"empty"}, "No milestones yet."),
    edit ? h("div", {class:"o-actions"}, h("button", {class:"btn small", onclick:() => openMilestone(p)}, "+ Milestone")) : null);
}
function costPanel(p, c, edit) {
  const laborBud = Math.round(c.hb * c.rate), laborAct = Math.round(c.hu * c.rate), laborFc = Math.round(c.projH * c.rate);
  const money = v => core.money(Math.round(Number(v) || 0));
  const row = (label, bud, com, act, fc, onclick) => h("tr", {class: onclick ? "click" : null, onclick},
    h("td", null, label), h("td", {class:"num"}, money(bud)), h("td", {class:"num"}, com == null ? "—" : money(com)), h("td", {class:"num"}, money(act)), h("td", {class:"num"}, money(fc)),
    h("td", {class:"num " + (bud - fc < -1000 ? "bad-t" : bud - fc > 1000 ? "go-t" : "")}, (bud - fc < 0 ? "−" : "") + money(Math.abs(bud - fc))));
  return panel("Cost to complete", "Budget is the estimate accepted at handoff plus approved change orders", h("div", {class:"tbl-wrap flat"}, h("table", null,
    h("thead", null, h("tr", null, h("th", null, "Cost code"), ["Budget", "Committed", "Actual to date", "Forecast at completion", "Variance"].map(t => h("th", {class:"num"}, t)))),
    h("tbody", null, row("Labor (" + num(c.hb) + " hrs at $" + c.rate + ")", laborBud, null, laborAct, laborFc),
      c.cl.map(l => row(l.label, Number(l.budget), l.committed == null ? null : Number(l.committed), Number(l.actual), Number(l.forecast ?? l.budget), edit ? () => openCost(p, l) : null)),
      c.ex.length ? row("Field expenses (approved" + (c.expPend ? "; " + compact(c.expPend) + " waiting on approval" : "") + ")", 0, null, c.expAppr, c.expAppr) : null),
    h("tfoot", null, h("tr", null, h("td", null, h("b", null, "Total cost")), h("td", {class:"num"}, money(c.budCost)), h("td"), h("td", {class:"num"}, money(laborAct + c.nlAct + c.expAppr)), h("td", {class:"num"}, money(c.fcCost)),
      h("td", {class:"num " + (c.budCost - c.fcCost < -1000 ? "bad-t" : "")}, (c.budCost - c.fcCost < 0 ? "−" : "") + money(Math.abs(c.budCost - c.fcCost)))),
      h("tr", null, h("td", null, h("b", null, "Margin")), h("td", {class:"num"}, pct(c.estM)), h("td"), h("td"), h("td", {class:"num " + (c.fcM < c.estM - .02 ? "bad-t" : "")}, pct(c.fcM)), h("td"))))),
    edit ? h("div", {class:"o-actions"}, h("button", {class:"btn small", onclick:() => openCost(p)}, "+ Cost line")) : null);
}
const CO_ST = [["not_priced", "Not priced", "bad"], ["pending", "Waiting on customer", "warn"], ["approved", "Approved", "go"], ["rejected", "Rejected", ""]];
function coPanel(p, c, edit, showMoney) {
  return panel("Change orders", showMoney ? compact(c.coAppr) + " approved · " + compact(c.coPend) + " pending" : plural(c.cos.length, "change order"),
    c.cos.length ? h("div", {class:"tbl-wrap flat"}, h("table", null,
      h("thead", null, h("tr", null, h("th", null, "CO"), h("th", null, "Description"), showMoney ? h("th", {class:"num"}, "Amount") : null, h("th", null, "Status"))),
      h("tbody", null, c.cos.slice().sort((a, b) => a.number.localeCompare(b.number)).map(x => { const st = CO_ST.find(s => s[0] === x.status) || CO_ST[0];
        return h("tr", {class: edit ? "click" : null, onclick: edit ? () => openCO(p, x) : null}, h("td", {class:"mono"}, x.number),
          h("td", {class:"wrap"}, x.description, x.note ? h("div", {class:"muted small"}, x.note) : null),
          showMoney ? h("td", {class:"num"}, x.amount == null ? "—" : money(x.amount)) : null, h("td", null, chip(st[2], st[1]))); }))))
      : h("div", {class:"empty"}, "No change orders."),
    edit || role() === "field" ? h("div", {class:"o-actions"}, h("button", {class:"btn small", onclick:() => openCO(p)}, "+ Change order")) : null);
}
const MAT_ST = [["to_order", "To order", "warn"], ["ordered", "On order", ""], ["partial", "Partly received", "acc"], ["received", "Received", "go"], ["backordered", "Backordered", "bad"]];
const DISTIS = ["Graybar", "Anixter (Wesco)", "CDW", "ADI Global", "Accu-Tech", "Communications Supply Corp", "Power & Telephone Supply", "Border States", "Kirby Risk", "Direct from manufacturer"];
const MAT_ORDER = {backordered:0, to_order:1, partial:2, ordered:3, received:4};
const qtyFmt = (v, uom) => num(v) + (uom && uom !== "ea" ? " " + uom : "");
const matCost = m => (Number(m.unit_cost) || 0) * (Number(m.qty) || 0);
function matPanel(p, c, edit) {
  const showMoney = role() !== "field", instOn = featureOn("insts");
  const mats = c.mats.slice().sort((a, b) => (MAT_ORDER[a.status] ?? 9) - (MAT_ORDER[b.status] ?? 9) || (a.sort || 0) - (b.sort || 0) || a.item.localeCompare(b.item));
  O.matSel = O.matSel || new Set();
  for (const id of [...O.matSel]) if (!mats.some(m => m.id === id)) O.matSel.delete(id);
  const total = sum(mats, matCost), ordered = sum(mats.filter(m => Number(m.qty_ordered) > 0), m => (Number(m.unit_cost) || 0) * Number(m.qty_ordered));
  const toOrder = mats.filter(m => Number(m.qty_ordered) < Number(m.qty)).length;
  const sel = edit ? m => h("td", {class:"cb", onclick: e => e.stopPropagation()}, h("input", {type:"checkbox", "aria-label":"Select " + m.item, checked:O.matSel.has(m.id),
    onchange: e => { e.target.checked ? O.matSel.add(m.id) : O.matSel.delete(m.id); render(); }})) : () => null;
  const sub = plural(mats.length, "line") + " · " + toOrder + " to order · " + plural(c.matOpen.length, "line") + " not fully received" + (showMoney && total ? " · " + compact(ordered) + " ordered of " + compact(total) : "")
    + (instOn && c.inst.lines.length ? " · " + pct(c.inst.pct) + " of planned labor installed" : "");
  return panel("Materials", sub,
    mats.length ? h("div", {class:"tbl-wrap flat"}, h("table", {class:"mat-tbl"},
      h("thead", null, h("tr", null, edit ? h("th", {class:"cb"}, h("input", {type:"checkbox", "aria-label":"Select all", checked: mats.length > 0 && mats.every(m => O.matSel.has(m.id)),
          onchange: e => { mats.forEach(m => e.target.checked ? O.matSel.add(m.id) : O.matSel.delete(m.id)); render(); }})) : null,
        h("th", null, "Item"), h("th", null, "Distributor · PO"), h("th", {class:"num"}, "Needed"), h("th", {class:"num"}, "Ordered"), h("th", null, "Received"), instOn ? h("th", null, "Installed") : null, h("th", null, "Status"), h("th"))),
      h("tbody", null, mats.map(m => { const st = MAT_ST.find(s => s[0] === m.status) || MAT_ST[1];
        const q = Number(m.qty) || 0, o = Number(m.qty_ordered) || 0, r = Number(m.received) || 0;
        return h("tr", {class: edit ? "click" : null, onclick: edit ? () => openMat(p, m) : null}, sel(m),
          h("td", {class:"wrap"}, h("b", {class:"mat-item"}, m.item), h("div", {class:"muted small"}, [m.part_no, m.manufacturer, showMoney && m.unit_cost ? money(m.unit_cost) + "/" + (m.uom || "ea") : null,
            instOn && Number(m.labor_per_unit) ? Number(m.labor_per_unit).toLocaleString("en-US", {maximumFractionDigits:3}) + " hrs/" + instUnit(m).replace(/s$/, "") : null, instOn && m.milestone_id ? (byId(O.ms, m.milestone_id) || {}).name : null].filter(Boolean).join(" · "))),
          h("td", null, m.distributor || h("span", {class:"muted"}, "—"), m.po_number ? h("div", {class:"muted small mono"}, m.po_number + (m.ordered_on ? " · " + fmtDate(m.ordered_on) : "")) : null),
          h("td", {class:"num"}, qtyFmt(q, m.uom)),
          h("td", {class:"num" + (o < q ? " warn-t" : "")}, o ? num(o) : "—"),
          h("td", null, h("div", {class:"mat-recv"}, h("span", {class:"mono"}, num(r) + " / " + num(q)), h("span", {class:"minibar inline"}, h("i", {class: r >= q ? "go" : r > 0 ? "" : "warn", style:"width:" + (q ? Math.min(100, r / q * 100) : 0) + "%"})))),
          instOn ? h("td", null, h("div", {class:"mat-recv"}, h("span", {class:"mono"}, num(Number(m.qty_installed) || 0) + " / " + num(instQty(m)) + (instUnit(m) !== (m.uom || "ea") ? " " + instUnit(m) : "")),
            h("span", {class:"minibar inline"}, h("i", {class: instDone(m) >= instQty(m) ? "go" : "", style:"width:" + (instQty(m) ? Math.min(100, instDone(m) / instQty(m) * 100) : 0) + "%"})))) : null,
          h("td", null, chip(st[2], st[1]), m.eta && r < q ? h("div", {class:"muted small"}, "ETA " + fmtDate(m.eta)) : null),
          h("td", {class:"nowrap", onclick: e => e.stopPropagation()}, o > r || (o === 0 && r < q && m.status === "backordered") ? h("button", {class:"btn small", onclick:() => openReceive(p, m)}, "Receive") : null,
            instOn && r > 0 && instDone(m) < instQty(m) ? h("button", {class:"btn small", onclick:() => openInstalls(p, m.id)}, "Install") : null)); }))))
      : h("div", {class:"empty"}, "No materials yet. Import the material list or add lines."),
    h("datalist", {id:"distis"}, DISTIS.map(d => h("option", {value:d}))),
    edit || role() === "field" ? h("div", {class:"o-actions"},
      instOn && mats.length ? h("button", {class:"btn small" + (edit ? "" : " primary"), onclick:() => openInstalls(p)}, "Log installs") : null,
      edit && O.matSel.size ? h("button", {class:"btn primary small", onclick:() => openOrder(p, [...O.matSel])}, "Order selected (" + O.matSel.size + ")") : null,
      edit ? h("button", {class:"btn small", onclick:() => openImport(p)}, "Import list") : null,
      edit ? h("button", {class:"btn small", onclick:() => openMat(p)}, "+ Line") : null) : null);
}
function logPanel(p) {
  const logs = O.logs.filter(l => l.project_id === p.id).sort((a, b) => b.log_date.localeCompare(a.log_date) || b.created_at.localeCompare(a.created_at));
  const draft = {log_date:TODAY, crew_count:null, hours:null, work:"", issues:""};
  const form = h("div", {class:"o-logform"}, h("div", {class:"form"},
    fld(draft, "log_date", "Date", "date"), fld(draft, "crew_count", "Crew on site", "number"), fld(draft, "hours", "Hours worked", "number"),
    fld(draft, "work", "Work completed", "textarea", {full:true, placeholder:"What got done today, where"}),
    fld(draft, "issues", "Issues or delays (optional)", "textarea", {full:true, placeholder:"Access, material, customer requests, safety"})),
    h("div", {class:"o-actions"}, h("button", {class:"btn primary", onclick: async e => {
      if (!(draft.work || "").trim()) { toast("Describe the work completed."); return; }
      const btn = e.currentTarget; btn.disabled = true;
      await saveRow("daily_logs", {project_id:p.id, log_date:draft.log_date || TODAY, crew_count:nullify(draft.crew_count), hours:nullify(draft.hours), work:draft.work.trim(), issues:nullify((draft.issues || "").trim()), author_id:S.me.id});
    }}, "Add to log")));
  return panel("Daily field log", "From the foreman in the field",
    h("details", {class:"o-add", open: role() === "field" ? true : null}, h("summary", null, "+ Today's log"), form),
    logs.length ? h("ul", {class:"o-log"}, logs.slice(0, 12).map(l => h("li", null,
      h("div", {class:"row1"}, h("b", null, fmtDate(l.log_date)), h("span", {class:"muted mono"}, [l.crew_count != null ? l.crew_count + " on site" : null, l.hours != null ? num(l.hours) + " hrs" : null].filter(Boolean).join(" · "))),
      h("div", null, l.work), l.issues ? h("div", {class:"issue"}, l.issues) : null, h("div", {class:"muted small"}, personName(l.author_id))))) : h("div", {class:"empty"}, "No log entries yet."));
}
function rosterPanel(p, c, edit) {
  const D = ["M", "T", "W", "R", "F"];
  const fromSchedule = O.techs.length > 0;
  const open = r => fromSchedule ? openAssign({techId:r.tech_id, projectId:p.id, date:weekDates(mondayOf(TODAY))[Math.max(0, "MTWRF".indexOf(r.days[0] || "M"))]}) : openRoster(p, r);
  return panel("Crew this week", people(c.roster.length) + (fromSchedule ? " · from the manpower schedule" : ""),
    c.roster.length ? h("div", {class:"o-crew"}, h("span"), D.map(d => h("span", {class:"hd"}, d === "R" ? "T" : d)),
      c.roster.flatMap(r => [h("button", {class: edit ? "linkish who" : "who", onclick: edit ? () => open(r) : null, disabled: !edit}, r.name, h("small", null, r.role || "")),
        ...D.map(d => h("span", {class: (r.days || "").includes(d) ? "on" : "off", title:(r.days || "").includes(d) ? "On this job" : "Off this job"}))])) : h("div", {class:"empty"}, p.phase === "mobilizing" ? "No crew assigned yet." : "No crew listed."),
    edit || fromSchedule ? h("div", {class:"o-actions"}, fromSchedule ? h("button", {class:"btn small", onclick:() => { O.mpMode = "week"; O.mpDate = mondayOf(TODAY); O.mpDept = p.department; go("ops-manpower"); }}, "Open manpower board") : null,
      edit ? h("button", {class:"btn small", onclick:() => fromSchedule ? openAssign({projectId:p.id, date:TODAY}) : openRoster(p)}, "+ Crew member") : null) : null);
}
const CL_ST = [["todo", "Not started", ""], ["in_progress", "In progress", "acc"], ["done", "Done", "go"]];
function closeoutPanel(p, c, edit) {
  return panel("Closeout", c.closeout.filter(x => x.status === "done").length + " of " + c.closeout.length + " done",
    c.closeout.length ? h("ul", {class:"o-check"}, c.closeout.map(x => { const st = CL_ST.find(s => s[0] === x.status) || CL_ST[0];
      return h("li", null, h("button", {class:"box " + x.status, disabled:!edit, "aria-label":"Change status of " + x.item, title: edit ? "Click to change status" : null, onclick: async () => {
          const next = x.status === "todo" ? "in_progress" : x.status === "in_progress" ? "done" : "todo";
          await saveRow("closeout_items", {status:next}, x.id); }}),
        h("div", null, x.item, x.note ? h("small", null, x.note) : null), chip(st[2], st[1])); })) : h("div", {class:"empty"}, "No closeout items."));
}
function projectBilling(p, c, edit) {
  const months = [...new Set(c.bills.map(b => b.month))].sort();
  return panel("Billing", "Billed " + compact(c.billed) + " of " + compact(c.total) + " · pay apps due the " + (p.pay_app_day || "—") + (p.pay_app_day ? ordinal(p.pay_app_day) : ""),
    months.length ? h("div", {class:"tbl-wrap flat"}, h("table", null,
      h("thead", null, h("tr", null, h("th", null, "Month"), h("th", {class:"num"}, "Billed"), h("th", null, "Invoice"), h("th", {class:"num"}, "Scheduled"))),
      h("tbody", null, months.map(m => { const b = c.bills.find(x => x.month === m && x.kind === "billed"), s = c.bills.find(x => x.month === m && x.kind === "scheduled");
        return h("tr", {class: edit ? "click" : null, onclick: edit ? () => openBill(p, m) : null}, h("td", null, monthLabel(m)), h("td", {class:"num"}, b ? money(b.amount) : "—"),
          h("td", {class:"mono"}, b && b.invoice_no || "—"), h("td", {class:"num sch"}, s ? money(s.amount) : "—")); }))))
      : h("div", {class:"empty"}, "No billing yet."),
    edit ? h("div", {class:"o-actions"}, h("button", {class:"btn small", onclick:() => openBill(p, monthStart(TODAY))}, "Record or schedule billing")) : null);
}
const people = n => n + (n === 1 ? " person" : " people");
const ordinal = n => (n % 100 >= 11 && n % 100 <= 13) ? "th" : ({1:"st", 2:"nd", 3:"rd"}[n % 10] || "th");

// ---------------------------------------------------------------- project edit drawers
function drawerForm(title, draft, fields, onSave, onDelete) {
  const foot = [];
  if (onDelete) foot.push(deleteButton(async () => { if (await onDelete()) closeDrawer(); }));
  foot.push(h("button", {class:"btn" + (onDelete ? "" : " spacer"), onclick:() => closeDrawer()}, "Cancel"));
  foot.push(h("button", {class:"btn primary", onclick: async e => { const btn = e.currentTarget; btn.disabled = true; const ok = await onSave(); btn.disabled = false; if (ok) closeDrawer(); }}, "Save"));
  openDrawer({title, body:h("div", {class:"form"}, fields), foot});
}
const del = (table, id) => async () => { const ok = await run(sb.from(table).delete().eq("id", id), "Deleted"); if (ok) { await reload(KEY_OF[table]); render(); } return ok; };
function suggestBox(p, d) {
  const c = calc(p); if (c.inst.pct == null) return null;
  const v = Math.round(c.inst.pct * 1000) / 10;
  return h("div", {class:"inst-suggest", style:"grid-column:1/-1"},
    h("div", null, h("b", null, "Installed work suggests " + v + "%"),
      h("div", {class:"muted small"}, num(Math.round(c.inst.earned)) + " of " + num(Math.round(c.inst.plan)) + " planned labor hours installed" + (c.hb && Math.abs(c.inst.plan - c.hb) > c.hb * .1 ? " (the install plan covers " + pct(c.inst.plan / c.hb) + " of the " + num(c.hb) + "-hour budget)" : ""))),
    h("button", {type:"button", class:"btn small", onclick:() => { d.pct_complete = v; const el = document.getElementById("f-pct_complete"); if (el) el.value = v; }}, "Use " + v + "%"));
}
function openProgress(p) {
  const d = {pct_complete:Number(p.pct_complete), phase:p.phase, start_date:p.start_date, end_date:p.end_date, pm_id:p.pm_id, notes:p.notes || "", po_number:p.po_number || "", parent_id:p.parent_id || null};
  const canProg = ["admin", "lead"].includes(role()) && !isProgram(p) && "parent_id" in p;
  const parents = O.projects.filter(x => x.id !== p.id && !x.parent_id && x.phase !== "closed" && canEdit(x)).sort((a, b) => a.number.localeCompare(b.number)).map(x => [x.id, x.number + " · " + x.name]);
  const pms = activePeople().filter(x => x.ops_role === "pm" || x.ops_role === "lead" || x.id === p.pm_id).map(x => [x.id, x.full_name || x.email]);
  drawerForm("Update " + p.number, d, [
    suggestBox(p, d),
    fld(d, "pct_complete", "Percent complete (0–100)", "number"),
    fld(d, "phase", "Phase", "select", {options:PHASES.map(x => [x[0], x[1]]), blank:false}),
    fld(d, "start_date", "Start", "date"), fld(d, "end_date", "Substantial completion", "date"),
    fld(d, "pm_id", "Project manager", "select", {options:pms, blank:false, readonly: role() === "pm"}),
    "po_number" in p ? fld(d, "po_number", "Customer PO number", "text") : null,
    canProg ? fld(d, "parent_id", "Phase of program (parent job)", "select", {options:parents, blank:"Not part of a program"}) : null,
    fld(d, "notes", "Notes", "textarea", {full:true}),
    h("p", {class:"muted small", style:"grid-column:1/-1;margin:0"}, "Percent complete drives earned hours, earned revenue and the margin forecast. Update it at least weekly.")].filter(Boolean),
    () => { const v = Number(d.pct_complete); if (!(v >= 0 && v <= 100)) { toast("Percent complete must be between 0 and 100."); return false; }
      const row = {pct_complete:v, phase:d.phase, start_date:nullify(d.start_date), end_date:nullify(d.end_date), pm_id:d.pm_id, notes:nullify(d.notes)};
      if ("po_number" in p) row.po_number = nullify((d.po_number || "").trim());
      if (canProg) row.parent_id = nullify(d.parent_id);
      return saveRow("projects", row, p.id); });
}
function openHours(p) {
  const wk = addDays(nextMonday(), -7);
  const cur = O.labor.find(l => l.project_id === p.id && l.week_start === wk);
  const d = {week_start:wk, hours:cur ? Number(cur.hours) : null, pct_complete:cur && cur.pct_complete != null ? Number(cur.pct_complete) : Number(p.pct_complete)};
  drawerForm("Weekly hours · " + p.number, d, [
    fld(d, "week_start", "Week starting (Monday)", "date"), fld(d, "hours", "Hours worked that week", "number"),
    fld(d, "pct_complete", "Percent complete at week end", "number"),
    h("p", {class:"muted small", style:"grid-column:1/-1;margin:0"}, "Once Nextep job-costed payroll is connected, these hours come straight from timecards coded to job " + p.number + ".")],
    async () => {
      const row = {project_id:p.id, week_start:d.week_start, hours:Number(d.hours) || 0, pct_complete:nullify(d.pct_complete)};
      const ok = await run(sb.from("labor_weeks").upsert(row, {onConflict:"project_id,week_start"}), "Hours saved");
      if (ok && d.pct_complete != null && Number(d.pct_complete) > Number(p.pct_complete)) await run(sb.from("projects").update({pct_complete:Number(d.pct_complete)}).eq("id", p.id));
      if (ok) { await Promise.all([reload("labor"), reload("projects")]); render(); }
      return ok;
    });
}
function openMilestone(p, m) {
  const d = m ? {...m, labor_hours:m.labor_hours == null ? null : Number(m.labor_hours)} : {name:"", planned:null, actual:null, progress:null, note:"", labor_hours:null, sort:(calc(p).ms.length + 1)};
  const ip = m ? calc(p).inst.byMs.get(m.id) : null;
  drawerForm(m ? "Milestone" : "New milestone", d, [
    fld(d, "name", "Milestone", "text", {full:true}), fld(d, "planned", "Planned date", "date"), fld(d, "actual", "Done on (blank = not done)", "date"),
    ip ? h("p", {class:"muted small", style:"grid-column:1/-1;margin:0"}, "Progress comes from installed material: " + instSummary(ip.lines) + " (" + Math.round(ip.pct * 100) + "%).")
       : fld(d, "progress", "Progress % (while in progress)", "number"),
    featureOn("insts") && !ip ? fld(d, "labor_hours", "Labor hours (for work with no material, e.g. testing)", "number") : null,
    fld(d, "note", "Note", "text", {full:true})].filter(Boolean),
    () => { if (!(d.name || "").trim()) { toast("Name the milestone."); return false; }
      const row = {project_id:p.id, name:d.name.trim(), planned:nullify(d.planned), actual:nullify(d.actual), progress:nullify(d.progress), note:nullify(d.note), sort:d.sort || 0};
      if (featureOn("insts") && !ip) row.labor_hours = nullify(d.labor_hours);
      return saveRow("milestones", row, m && m.id); },
    m ? del("milestones", m.id) : null);
}
function openCost(p, l) {
  const d = l ? {...l} : {code:"other", label:"", budget:0, committed:null, actual:0, forecast:null, sort:9};
  drawerForm(l ? l.label : "New cost line", d, [
    fld(d, "label", "Cost code", "text", {full:true}), fld(d, "code", "Type", "select", {options:[["material","Material"],["subcontract","Subcontract"],["equipment","Equipment"],["other","Other"]], blank:false}),
    fld(d, "budget", "Budget", "number"), fld(d, "committed", "Committed (POs and subcontracts)", "number"), fld(d, "actual", "Actual to date", "number"),
    fld(d, "forecast", "Forecast at completion (blank = budget)", "number")],
    () => { if (!(d.label || "").trim()) { toast("Name the cost line."); return false; }
      return saveRow("cost_lines", {project_id:p.id, code:d.code, label:d.label.trim(), budget:Number(d.budget) || 0, committed:nullify(d.committed), actual:Number(d.actual) || 0, forecast:nullify(d.forecast), sort:d.sort || 9}, l && l.id); },
    l ? del("cost_lines", l.id) : null);
}
function openCO(p, x) {
  const n = calc(p).cos.length + 1;
  const d = x ? {...x} : {number:"CO-" + String(n).padStart(2, "0"), description:"", amount:null, status:"not_priced", submitted_on:null, decided_on:null, note:""};
  const canPrice = canEdit(p);
  drawerForm(x ? x.number : "New change order", d, [
    fld(d, "number", "CO #", "text"), fld(d, "status", "Status", "select", {options:CO_ST.map(s => [s[0], s[1]]), blank:false, readonly:!canPrice}),
    fld(d, "description", "What changed", "text", {full:true}),
    fld(d, "amount", "Amount (USD)", "number", {readonly:!canPrice}), fld(d, "submitted_on", "Sent to customer", "date", {readonly:!canPrice}), fld(d, "decided_on", "Approved or rejected on", "date", {readonly:!canPrice}),
    fld(d, "note", "Note", "text", {full:true}),
    h("p", {class:"muted small", style:"grid-column:1/-1;margin:0"}, "Approved change orders add to the contract value, the budget margin and the account's revenue in the CRM.")],
    () => { if (!(d.description || "").trim()) { toast("Describe the change."); return false; }
      return saveRow("change_orders", {project_id:p.id, number:d.number, description:d.description.trim(), amount:nullify(d.amount), status:d.status, submitted_on:nullify(d.submitted_on), decided_on:nullify(d.decided_on), note:nullify(d.note)}, x && x.id); },
    x && canPrice ? del("change_orders", x.id) : null);
}
function distiInput(d, key, label) {
  const inp = h("input", {id:"f-" + key, list:"distis", autocomplete:"off", oninput: e => { d[key] = e.target.value; }}); inp.value = d[key] || "";
  return h("div", {class:"field"}, h("label", {for:"f-" + key}, label), inp, h("datalist", {id:"distis"}, DISTIS.map(x => h("option", {value:x}))));
}
function openMat(p, m) {
  const showMoney = role() !== "field";
  const instOn = featureOn("insts");
  const d = m ? {...m, qty:Number(m.qty), qty_ordered:Number(m.qty_ordered), unit_cost:m.unit_cost == null ? null : Number(m.unit_cost), backordered:m.status === "backordered",
                 install_qty:m.install_qty == null ? null : Number(m.install_qty), labor_per_unit:m.labor_per_unit == null ? null : Number(m.labor_per_unit)}
              : {item:"", part_no:"", manufacturer:"", qty:1, uom:"ea", unit_cost:null, distributor:"", po_number:"", qty_ordered:0, ordered_on:null, eta:null, note:"", backordered:false,
                 install_unit:"", install_qty:null, labor_per_unit:null, milestone_id:null};
  const installs = m && instOn ? O.insts.filter(x => x.material_id === m.id).sort((a, b) => b.installed_on.localeCompare(a.installed_on) || (b.created_at || "").localeCompare(a.created_at || "")) : [];
  const msOpts = O.ms.filter(x => x.project_id === p.id).sort((a, b) => (a.planned || "").localeCompare(b.planned || "") || a.sort - b.sort).map(x => [x.id, x.name]);
  const receipts = m ? O.rcpts.filter(r => r.material_id === m.id).sort((a, b) => b.received_on.localeCompare(a.received_on)) : [];
  const body = h("div", null,
    h("div", {class:"section-h"}, "Item"),
    h("div", {class:"form"}, fld(d, "item", "Description", "text", {full:true}), fld(d, "part_no", "Part number", "text"), fld(d, "manufacturer", "Manufacturer", "text"),
      fld(d, "qty", "Quantity needed", "number"), fld(d, "uom", "Unit (ea, ft, box, lot)", "text"), showMoney ? fld(d, "unit_cost", "Unit cost (USD)", "number") : null),
    h("div", {class:"section-h"}, "Order"),
    h("div", {class:"form"}, distiInput(d, "distributor", "Distributor"), fld(d, "po_number", "PO number", "text"),
      fld(d, "qty_ordered", "Quantity ordered", "number"), fld(d, "ordered_on", "Ordered on", "date"), fld(d, "eta", "Expected delivery", "date"),
      h("label", {class:"field check"}, h("input", {type:"checkbox", checked:d.backordered, onchange: e => { d.backordered = e.target.checked; }}), h("span", null, "Backordered by the distributor")),
      fld(d, "note", "Note", "text", {full:true})),
    instOn ? h("div", null, h("div", {class:"section-h"}, "Install tracking"),
      h("p", {class:"muted small", style:"margin-top:0"}, "How the crew counts this work, and the labor each one takes. Installed labor hours across the job give the suggested percent complete."),
      h("div", {class:"form"},
        fld(d, "install_unit", "Counted as (blank = " + (d.uom || "ea") + ")", "text", {placeholder:"e.g. drops, APs, cameras, feet"}),
        fld(d, "install_qty", "How many to install (blank = quantity needed)", "number"),
        fld(d, "labor_per_unit", "Labor hours each", "number"),
        fld(d, "milestone_id", "Counts toward milestone", "select", {options:msOpts, blank:"None"})),
      m ? h("div", null, installs.length ? h("ul", {class:"rcpt-list"}, installs.map(x => h("li", null,
        h("div", null, h("b", null, (Number(x.qty) > 0 ? "+" : "") + num(x.qty) + " " + instUnit(m)), " on " + fmtDate(x.installed_on) + " · " + personName(x.installed_by),
          x.area || x.note ? h("div", {class:"muted small"}, [x.area, x.note].filter(Boolean).join(" · ")) : null),
        x.installed_by === S.me.id || canEdit(p) ? h("button", {class:"btn small", onclick: async () => {
          if (await run(sb.from("material_installs").delete().eq("id", x.id), "Install entry removed")) { await Promise.all([reload("insts"), reload("mats")]); render(); closeDrawer(); }
        }}, "Remove") : null))) : h("div", {class:"muted"}, "Nothing installed yet."),
        h("div", {style:"margin-top:8px"}, h("button", {class:"btn small", onclick:() => { closeDrawer(); openInstalls(p, m.id); }}, "Log installs"))) : null) : null,
    m ? h("div", null, h("div", {class:"section-h"}, "Deliveries"),
      receipts.length ? h("ul", {class:"rcpt-list"}, receipts.map(r => h("li", null,
        h("div", null, h("b", null, "+" + num(r.qty) + " " + (m.uom || "ea")), " on " + fmtDate(r.received_on) + " · " + personName(r.received_by),
          r.packing_slip || r.note ? h("div", {class:"muted small"}, [r.packing_slip ? "Packing slip " + r.packing_slip : null, r.note].filter(Boolean).join(" · ")) : null),
        r.received_by === S.me.id || canEdit(p) ? h("button", {class:"btn small", onclick: async () => {
          if (await run(sb.from("material_receipts").delete().eq("id", r.id), "Delivery removed")) { await Promise.all([reload("rcpts"), reload("mats")]); render(); closeDrawer(); }
        }}, "Remove") : null))) : h("div", {class:"muted"}, "Nothing received yet."),
      h("div", {style:"margin-top:8px"}, h("button", {class:"btn small", onclick:() => { closeDrawer(); openReceive(p, m); }}, "Log a delivery"))) : null);
  const foot = [];
  if (m) foot.push(deleteButton(async () => { if (await run(sb.from("materials").delete().eq("id", m.id), "Deleted")) { await reload("mats"); render(); closeDrawer(); } }));
  foot.push(h("button", {class:"btn" + (m ? "" : " spacer"), onclick:() => closeDrawer()}, "Cancel"));
  foot.push(h("button", {class:"btn primary", onclick: async e => {
    if (!(d.item || "").trim()) { toast("Describe the item."); return; }
    if (!(Number(d.qty) > 0)) { toast("Quantity needed must be more than zero."); return; }
    const row = {project_id:p.id, item:d.item.trim(), part_no:nullify((d.part_no || "").trim()), manufacturer:nullify((d.manufacturer || "").trim()), qty:Number(d.qty), uom:(d.uom || "ea").trim() || "ea",
      distributor:nullify((d.distributor || "").trim()), po_number:nullify((d.po_number || "").trim()), qty_ordered:Number(d.qty_ordered) || 0, ordered_on:nullify(d.ordered_on), eta:nullify(d.eta),
      note:nullify((d.note || "").trim()), status: d.backordered ? "backordered" : "ordered"};
    if (showMoney) row.unit_cost = nullify(d.unit_cost);
    if (instOn) Object.assign(row, {install_unit:nullify((d.install_unit || "").trim()), install_qty:nullify(d.install_qty), labor_per_unit:nullify(d.labor_per_unit), milestone_id:nullify(d.milestone_id)});
    if (instOn && row.install_qty != null && !(row.install_qty > 0)) { toast("How many to install must be more than zero, or blank."); return; }
    if (instOn && row.labor_per_unit != null && row.labor_per_unit < 0) { toast("Labor hours can't be negative."); return; }
    if (row.qty_ordered > 0 && !row.ordered_on) row.ordered_on = TODAY;
    const btn = e.currentTarget; btn.disabled = true;
    const ok = m ? await run(sb.from("materials").update(row).eq("id", m.id), "Saved") : await run(sb.from("materials").insert(row), "Added");
    btn.disabled = false;
    if (ok) { await reload("mats"); render(); closeDrawer(); }
  }}, m ? "Save" : "Add"));
  openDrawer({title: m ? m.item : "New material line", body, foot});
}
function openOrder(p, ids) {
  const lines = O.mats.filter(m => ids.includes(m.id));
  const d = {distributor:"", po_number:"", ordered_on:TODAY, eta:null};
  const showMoney = role() !== "field";
  const body = h("div", null,
    h("p", {class:"muted"}, "Marks each selected line as ordered in full from this distributor on this PO."),
    h("ul", {class:"rcpt-list"}, lines.map(m => h("li", null, h("div", null, h("b", null, m.item), h("div", {class:"muted small"}, qtyFmt(Number(m.qty), m.uom) + (m.part_no ? " · " + m.part_no : "") + (Number(m.qty_ordered) ? " · " + num(m.qty_ordered) + " already ordered" + (m.distributor ? " from " + m.distributor : "") : ""))),
      showMoney && m.unit_cost ? h("span", {class:"mono"}, money(matCost(m))) : null))),
    showMoney ? h("p", null, "Total ", h("b", {class:"mono"}, money(sum(lines, matCost)))) : null,
    h("div", {class:"form"}, distiInput(d, "distributor", "Distributor"), fld(d, "po_number", "PO number", "text"), fld(d, "ordered_on", "Ordered on", "date"), fld(d, "eta", "Expected delivery", "date")));
  openDrawer({title:"Order " + plural(lines.length, "line"), body, foot:[h("button", {class:"btn spacer", onclick:() => closeDrawer()}, "Cancel"),
    h("button", {class:"btn primary", onclick: async e => {
      if (!(d.distributor || "").trim()) { toast("Choose the distributor."); return; }
      const btn = e.currentTarget; btn.disabled = true; let ok = true;
      for (const m of lines) ok = !!(await run(sb.from("materials").update({distributor:d.distributor.trim(), po_number:nullify((d.po_number || "").trim()), ordered_on:d.ordered_on || TODAY,
        eta:nullify(d.eta), qty_ordered:Math.max(Number(m.qty), Number(m.qty_ordered) || 0)}).eq("id", m.id))) && ok;
      btn.disabled = false;
      await reload("mats"); O.matSel.clear(); render();
      if (ok) { closeDrawer(); toast(plural(lines.length, "line") + " ordered from " + d.distributor.trim()); }
    }}, "Mark ordered")]});
}
function weekInstalls(p, wk) {
  if (!featureOn("insts")) return null;
  const xs = O.insts.filter(x => x.project_id === p.id && x.installed_on >= wk && x.installed_on <= addDays(wk, 6));
  const by = new Map(); for (const x of xs) by.set(x.material_id, (by.get(x.material_id) || 0) + Number(x.qty));
  const bits = [...by.entries()].map(([id, q]) => { const m = byId(O.mats, id) || {}; return num(q) + " " + instUnit(m) + (m.install_unit ? "" : " " + (m.item || "")); });
  return h("div", null, h("span", {class:"k"}, "Installed this week"), h("p", null, bits.length ? bits.join(" · ") : "Nothing logged yet"));
}
function openInstalls(p, onlyId) {
  const all = O.mats.filter(m => m.project_id === p.id);
  const lines = (onlyId ? all.filter(m => m.id === onlyId) : all.filter(m => instDone(m) < instQty(m) || Number(m.qty_installed) > instQty(m)))
    .sort((a, b) => (a.sort || 0) - (b.sort || 0) || a.item.localeCompare(b.item));
  const d = {installed_on:TODAY, area:"", note:""}, q = new Map();
  const photo = h("input", {type:"file", id:"f-instphoto", accept:"image/*", class:"inp"});
  const body = h("div", null,
    h("p", {class:"muted", style:"margin-top:0"}, "Enter what was installed. Leave a line blank if nothing went in. Use a minus number to correct a mistake."),
    lines.length ? h("ul", {class:"inst-list"}, lines.map(m => {
      const left = instQty(m) - (Number(m.qty_installed) || 0), r = Number(m.received) || 0;
      return h("li", null,
        h("div", null, h("b", null, m.item), h("div", {class:"muted small"}, num(Number(m.qty_installed) || 0) + " of " + num(instQty(m)) + " " + instUnit(m) + " installed"
          + (left > 0 ? " · " + num(left) + " to go" : "") + (r < Number(m.qty) ? " · " + num(r) + " of " + num(m.qty) + " " + (m.uom || "ea") + " received" : ""))),
        h("label", {class:"inst-q"}, h("input", {type:"number", step:"any", inputmode:"decimal", class:"inp", "aria-label":"Installed now: " + m.item, placeholder:"0",
          oninput: e => { const v = e.target.value === "" ? 0 : Number(e.target.value); if (v) q.set(m.id, v); else q.delete(m.id); }}), h("span", {class:"muted small"}, instUnit(m))));
    })) : h("div", {class:"empty"}, "Everything on the list is installed."),
    h("div", {class:"form", style:"margin-top:12px"}, fld(d, "installed_on", "Installed on", "date"), fld(d, "area", "Where (floor, section, IDF, site)", "text"),
      h("div", {class:"field full"}, h("label", {for:"f-instphoto"}, "Photo of the work (optional)"), photo),
      fld(d, "note", "Note", "text", {full:true})));
  openDrawer({title:"Log installs · " + p.number, body, foot:[h("button", {class:"btn spacer", onclick:() => closeDrawer()}, "Cancel"),
    h("button", {class:"btn primary", onclick: async e => {
      if (!q.size) { toast("Enter how many were installed."); return; }
      for (const [id, v] of q) { const m = byId(O.mats, id); if ((Number(m.qty_installed) || 0) + v < 0) { toast("That would take " + m.item + " below zero installed."); return; } }
      const rows = [...q].map(([id, v]) => ({material_id:id, project_id:p.id, qty:v, installed_on:d.installed_on || TODAY, installed_by:S.me.id, area:nullify((d.area || "").trim()), note:nullify((d.note || "").trim())}));
      const btn = e.currentTarget; btn.disabled = true;
      const ok = await run(sb.from("material_installs").insert(rows));
      if (ok && photo.files[0]) await uploadOne(p, "field", photo.files[0], "Installed" + (d.area ? " · " + d.area.trim() : "") + " · " + rows.map(r => num(r.qty) + " " + instUnit(byId(O.mats, r.material_id))).join(", "));
      btn.disabled = false;
      if (ok) { await Promise.all([reload("insts"), reload("mats"), reload("docs")]); render(); closeDrawer(); toast("Logged " + plural(rows.length, "line") + " installed"); }
    }}, "Log installs")]});
}
function openReceive(p, m) {
  const remaining = Math.max(0, Math.max(Number(m.qty_ordered), Number(m.qty)) - Number(m.received));
  const d = {qty:remaining, received_on:TODAY, packing_slip:"", note:""};
  const photo = h("input", {type:"file", id:"f-slip", accept:"image/*,application/pdf", class:"inp"});
  const body = h("div", null,
    h("p", null, h("b", null, m.item), h("br"), h("span", {class:"muted small"}, [m.distributor, m.po_number, num(m.received) + " of " + num(m.qty) + " " + (m.uom || "ea") + " received so far"].filter(Boolean).join(" · "))),
    h("div", {class:"form"}, fld(d, "qty", "Quantity received now", "number"), fld(d, "received_on", "Received on", "date"),
      fld(d, "packing_slip", "Packing slip or delivery #", "text"), h("div"),
      h("div", {class:"field full"}, h("label", {for:"f-slip"}, "Photo of the packing slip (optional)"), photo),
      fld(d, "note", "Note (damage, shortages, where it's staged)", "text", {full:true})));
  openDrawer({title:"Receive material · " + p.number, body, foot:[h("button", {class:"btn spacer", onclick:() => closeDrawer()}, "Cancel"),
    h("button", {class:"btn primary", onclick: async e => {
      const q = Number(d.qty); if (!q) { toast("Enter how many arrived."); return; }
      const btn = e.currentTarget; btn.disabled = true;
      const ok = await run(sb.from("material_receipts").insert({material_id:m.id, project_id:p.id, qty:q, received_on:d.received_on || TODAY, received_by:S.me.id,
        packing_slip:nullify((d.packing_slip || "").trim()), note:nullify((d.note || "").trim())}));
      if (ok && photo.files[0]) await uploadOne(p, "field", photo.files[0], "Packing slip · " + m.item + (d.packing_slip ? " · " + d.packing_slip : ""));
      btn.disabled = false;
      if (ok) { await Promise.all([reload("rcpts"), reload("mats"), reload("docs")]); render(); closeDrawer(); toast("Received " + num(q) + " " + (m.uom || "ea") + " of " + m.item); }
    }}, "Log delivery")]});
}
// a material list from Excel or CSV
const MAT_FIELDS = [["item", "Description", /desc|item|material|product|name/i, true], ["part_no", "Part number", /part|sku|model|cat(alog)?\b|mfr ?#|p\/n/i],
  ["manufacturer", "Manufacturer", /manuf|mfr|brand|make/i], ["qty", "Quantity", /qty|quant|count|amount/i, true], ["uom", "Unit", /^u\/?o\/?m$|^units?$/i],
  ["unit_cost", "Unit cost", /unit ?(cost|price)|price|cost/i], ["distributor", "Distributor", /dist|vendor|supplier|source/i],
  ["labor_per_unit", "Labor hrs each", /labor|man ?h|hrs|hours/i]];
function parseCsvText(text) {
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) { const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += ch; }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim()));
}
let xlsxLoading = null;
function loadXlsx() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (!xlsxLoading) xlsxLoading = new Promise((res, rej) => { const s = document.createElement("script"); s.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
    s.onload = () => res(window.XLSX); s.onerror = () => { xlsxLoading = null; rej(new Error("Couldn't load the Excel reader. Save the sheet as CSV and try again.")); }; document.head.append(s); });
  return xlsxLoading;
}
async function readSheet(file) {
  if (/\.csv$|text\/csv/i.test(file.name + " " + file.type)) return parseCsvText(await file.text());
  const X = await loadXlsx();
  const wb = X.read(await file.arrayBuffer(), {type:"array"});
  return X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {header:1, raw:false, defval:""}).filter(r => r.some(c => String(c).trim()));
}
const toNum = v => { const n = Number(String(v == null ? "" : v).replace(/[$,\s]/g, "")); return isFinite(n) ? n : NaN; };
function openImport(p) {
  const st = {rows:null, head:null, map:{}, headerRow:0};
  const input = h("input", {type:"file", id:"f-bom", accept:".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel", class:"inp"});
  const area = h("div");
  const draw = () => {
    if (!st.rows) { area.replaceChildren(h("p", {class:"muted small"}, "Use the material list or BOM from the estimate. The first row should be column headings (Description, Part #, Manufacturer, Qty, Unit, Unit cost, Distributor); you'll match them on the next step.")); return; }
    const data = st.rows.slice(st.headerRow + 1);
    const pick = ([key, label, , req]) => h("div", {class:"field"}, h("label", {for:"map-" + key}, label + (req ? " (required)" : "")),
      h("select", {id:"map-" + key, onchange: e => { st.map[key] = e.target.value === "" ? null : Number(e.target.value); draw(); }},
        h("option", {value:""}, "—"), st.head.map((c, i) => h("option", {value:String(i), selected:st.map[key] === i}, c || "Column " + (i + 1)))));
    const parsed = data.map(r => { const o = {}; for (const [k] of MAT_FIELDS) o[k] = st.map[k] == null ? "" : String(r[st.map[k]] ?? "").trim(); return o; });
    const good = parsed.filter(o => o.item && toNum(o.qty) > 0);
    st.good = good;
    area.replaceChildren(
      h("div", {class:"section-h"}, "Match the columns"), h("div", {class:"form"}, MAT_FIELDS.map(pick)),
      h("div", {class:"section-h"}, "Preview"),
      h("p", {class:"muted small"}, good.length + " of " + data.length + " rows will be imported" + (data.length > good.length ? " (rows without a description or quantity are skipped)" : "") + "."),
      h("div", {class:"tbl-wrap flat"}, h("table", null, h("thead", null, h("tr", null, MAT_FIELDS.map(f => h("th", null, f[1])))),
        h("tbody", null, good.slice(0, 8).map(o => h("tr", null, MAT_FIELDS.map(([k]) => h("td", null, o[k] || "—"))))))));
  };
  input.addEventListener("change", async () => {
    const f = input.files[0]; if (!f) return;
    area.replaceChildren(h("p", {class:"muted"}, "Reading " + f.name + "…"));
    try {
      const rows = await readSheet(f);
      if (!rows.length) { area.replaceChildren(h("p", {class:"bad-t"}, "That file looks empty.")); return; }
      // the header is the first row that names a description or quantity column
      st.headerRow = Math.max(0, rows.slice(0, 10).findIndex(r => r.some(c => /desc|item|qty|quant/i.test(String(c)))));
      st.rows = rows; st.head = rows[st.headerRow].map(c => String(c).trim());
      st.map = {};
      for (const [key, , re] of MAT_FIELDS) { const i = st.head.findIndex((c, j) => re.test(c) && !Object.values(st.map).includes(j)); st.map[key] = i >= 0 ? i : null; }
      draw();
    } catch (e) { area.replaceChildren(h("p", {class:"bad-t"}, friendly(e))); }
  });
  draw();
  openDrawer({title:"Import material list · " + p.number, body:h("div", null, h("div", {class:"field full"}, h("label", {for:"f-bom"}, "Excel or CSV file"), input), area),
    foot:[h("button", {class:"btn spacer", onclick:() => closeDrawer()}, "Cancel"), h("button", {class:"btn primary", onclick: async e => {
      if (!st.good || !st.good.length) { toast(st.rows ? "Match the Description and Quantity columns first." : "Choose a file first."); return; }
      const start = (Math.max(0, ...O.mats.filter(m => m.project_id === p.id).map(m => m.sort || 0)));
      const rows = st.good.map((o, i) => ({project_id:p.id, item:o.item.slice(0, 300), part_no:nullify(o.part_no), manufacturer:nullify(o.manufacturer), qty:toNum(o.qty),
        uom:o.uom || "ea", unit_cost: isNaN(toNum(o.unit_cost)) || o.unit_cost === "" ? null : toNum(o.unit_cost), distributor:nullify(o.distributor), qty_ordered:0, received:0, status:"to_order", sort:start + i + 1,
        ...(featureOn("insts") && o.labor_per_unit !== "" && !isNaN(toNum(o.labor_per_unit)) ? {labor_per_unit:toNum(o.labor_per_unit)} : {})}));
      const btn = e.currentTarget; btn.disabled = true;
      const ok = await run(sb.from("materials").insert(rows));
      btn.disabled = false;
      if (ok) { await reload("mats"); render(); closeDrawer(); toast("Imported " + plural(rows.length, "line")); }
    }}, "Import")]});
}
function openRoster(p, r) {
  const d = r ? {...r} : {name:"", role:"Tech", days:"MTWRF", profile_id:null, sort:calc(p).roster.length + 1};
  const dayBox = h("div", {class:"pick", role:"group", "aria-label":"Days on this job"}, [["M","Mon"],["T","Tue"],["W","Wed"],["R","Thu"],["F","Fri"]].map(([k, t]) =>
    h("button", {type:"button", "aria-pressed":String((d.days || "").includes(k)), onclick: e => { d.days = (d.days || "").includes(k) ? d.days.replace(k, "") : "MTWRF".split("").filter(x => x === k || d.days.includes(x)).join(""); e.currentTarget.setAttribute("aria-pressed", String(d.days.includes(k))); }}, t)));
  const field = activePeople().filter(x => x.ops_role === "field").map(x => [x.id, x.full_name || x.email]);
  drawerForm(r ? r.name : "Add to crew", d, [
    fld(d, "name", "Name", "text"), fld(d, "role", "Role", "text"),
    h("div", {class:"field full"}, h("label", null, "Days on this job this week"), dayBox),
    fld(d, "profile_id", "App login (lets them add daily logs)", "select", {options:field, blank:"No login", full:true})],
    () => { if (!(d.name || "").trim()) { toast("Add a name."); return false; }
      return saveRow("crew_roster", {project_id:p.id, name:d.name.trim(), role:nullify(d.role), days:d.days || "", profile_id:nullify(d.profile_id), sort:d.sort || 0}, r && r.id); },
    r ? del("crew_roster", r.id) : null);
}
function openBill(p, month) {
  const b = O.bills.find(x => x.project_id === p.id && x.month === month && x.kind === "billed");
  const s = O.bills.find(x => x.project_id === p.id && x.month === month && x.kind === "scheduled");
  const d = {month, billed: b ? Number(b.amount) : null, invoice_no: b ? b.invoice_no : "", scheduled: s ? Number(s.amount) : null};
  drawerForm("Billing · " + p.number, d, [
    fld(d, "month", "Month (any day in it)", "date"), h("div"),
    fld(d, "billed", "Billed (pay app or invoice amount)", "number"), fld(d, "invoice_no", "Invoice #", "text"),
    fld(d, "scheduled", "Scheduled to bill", "number"),
    h("p", {class:"muted small", style:"grid-column:1/-1;margin:0"}, "Leave an amount blank to remove it. Once accounting is connected, billed amounts come in automatically.")],
    async () => {
      const m = monthStart(d.month || month); let ok = true;
      for (const [kind, amt, inv] of [["billed", d.billed, d.invoice_no], ["scheduled", d.scheduled, null]]) {
        const cur = O.bills.find(x => x.project_id === p.id && x.month === m && x.kind === kind);
        if (amt == null || amt === "" || Number(amt) === 0) { if (cur) ok = !!(await run(sb.from("billings").delete().eq("id", cur.id))) && ok; }
        else ok = !!(await run(sb.from("billings").upsert({project_id:p.id, month:m, kind, amount:Number(amt), invoice_no:nullify(inv)}, {onConflict:"project_id,month,kind"}))) && ok;
      }
      await reload("bills"); render(); if (ok) toast("Billing saved");
      return ok;
    });
}

// ---------------------------------------------------------------- handoffs
const HO_ST = {packet:["", "Packet in progress"], review:["acc", "In ops review"], kicked_back:["bad", "Kicked back"], accepted:["go", "Accepted"], cancelled:["", "Cancelled"]};
const PACKET = [
  ["Contract", [["contract_value","Contract value (USD)","number"],["contract_signed","Signed contract or PO received","check"],["sov_attached","Schedule of values attached","check"],
    ["retainage_pct","Retainage %","number"],["pay_app_day","Pay app due (day of month)","number"],["billing_terms","Billing terms","text"],["bonds_insurance","Bonds and insurance requirements","text"]]],
  ["Schedule", [["start_date","Planned start","date"],["end_date","Substantial completion","date"]]],
  ["Estimate it was priced on", [["labor_hours","Labor hours","number"],["material","Material (USD)","number"],["subcontract","Subcontract (USD)","number"],["equipment","Equipment and lifts (USD)","number"]]],
  ["People", [["customer_pm","Customer PM","text"],["site_contact","Site contact","text"],["billing_contact","Billing contact","text"],["gc_name","GC or prime (if we're a sub)","text"]]],
  ["Site and scope", [["site_access","Site access and badging","textarea"],["safety_reqs","Safety requirements","textarea"],["scope","Scope summary","textarea"],["exclusions","Exclusions and assumptions","textarea"]]],
];
const REQUIRED = [["contract_signed","signed contract or PO"],["sov_attached","schedule of values"],["start_date","planned start"],["end_date","completion date"],
  ["labor_hours","labor hours"],["material","material estimate"],["customer_pm","customer PM"],["billing_contact","billing contact"],["site_access","site access"]];
const missingOf = pk => REQUIRED.filter(([k]) => { const v = (pk || {})[k]; return v == null || v === "" || v === false; }).map(x => x[1]);
function viewHandoffs() {
  const wrap = h("div", {class:"o-stack"});
  wrap.append(h("div", {class:"toolbar"}, h("h2", null, "Handoffs"),
    h("span", {class:"muted"}, "Every won deal gets a handoff packet. Sales completes it, operations accepts it, and acceptance creates the project.")));
  const list = O.handoffs.filter(x => x.status !== "cancelled");
  if (!list.length) { wrap.append(h("div", {class:"panel"}, emptyState("No handoffs yet", "Mark a deal Won and its handoff packet opens here."))); return wrap; }
  const groups = [["Waiting on sales", list.filter(x => ["packet", "kicked_back"].includes(x.status))], ["In ops review", list.filter(x => x.status === "review")],
    ["Accepted", list.filter(x => x.status === "accepted").sort((a, b) => (b.accepted_at || "").localeCompare(a.accepted_at || "")).slice(0, 12)]];
  for (const [name, rows] of groups) {
    if (!rows.length) continue;
    wrap.append(panel(name, plural(rows.length, "deal"), h("div", {class:"tbl-wrap flat"}, h("table", null,
      h("thead", null, h("tr", null, h("th", null, "Won deal"), h("th", null, "Department"), h("th", {class:"num"}, "Value"), h("th", null, "Won"), h("th", null, "Sold by"), h("th", null, "PM"), h("th", null, name === "Accepted" ? "Project" : "Still missing"), h("th", null, "Status"))),
      h("tbody", null, rows.map(x => { const d = handoffDeal(x), miss = missingOf(x.packet), st = HO_ST[x.status];
        const proj = x.project_id && byId(O.projects, x.project_id);
        return h("tr", {class:"click", tabindex:"0", onclick:() => openHandoff(x.id), onkeydown: e => { if (e.key === "Enter") openHandoff(x.id); }},
          h("td", null, h("b", null, handoffName(x)), h("div", {class:"muted small"}, acctName(d.account_id) || "")),
          h("td", null, x.department || h("span", {class:"warn-t"}, "Not set")), h("td", {class:"num"}, compact(handoffValue(x))),
          h("td", null, d.close_date ? fmtDate(d.close_date) + (x.status !== "accepted" ? " · " + (-daysUntil(d.close_date)) + "d ago" : "") : "—"),
          h("td", null, personName(d.owner_id)), h("td", null, x.pm_id ? personName(x.pm_id) : h("span", {class:"muted"}, "Not assigned")),
          h("td", {class:"wrap"}, name === "Accepted" ? (proj ? proj.number : "—") : x.status === "kicked_back" ? h("span", {class:"bad-t"}, x.kickback_reason) : miss.length ? h("span", {class:"warn-t"}, miss.join(", ")) : h("span", {class:"go-t"}, "Complete")),
          h("td", null, chip(st[0], st[1]))); }))))));
  }
  return wrap;
}
function openHandoff(id) {
  const ho = byId(O.handoffs, id); if (!ho) { toast("That handoff isn't available to you."); return; }
  const d = handoffDeal(ho);
  const draft = {department:ho.department, pm_id:ho.pm_id, packet:JSON.parse(JSON.stringify(ho.packet || {})), reason:"", office:""};
  const ops = isOpsFor(ho), locked = ho.status === "accepted" || ho.status === "cancelled";
  const pms = activePeople().filter(x => (x.ops_role === "pm" || x.ops_role === "lead") && (!draft.department || x.department === draft.department || x.ops_role === "lead")).map(x => [x.id, (x.full_name || x.email) + (x.department ? " · " + x.department : "")]);
  const pk = draft.packet;
  const field = ([k, label, type]) => {
    if (type === "check") return h("label", {class:"field check"}, h("input", {type:"checkbox", id:"pk-" + k, checked:!!pk[k], disabled:locked, onchange: e => { pk[k] = e.target.checked; }}), h("span", null, label));
    return fld(pk, k, label, type, {readonly:locked, full: type === "textarea"});
  };
  const body = h("div", null,
    h("div", {class:"o-hobanner " + (HO_ST[ho.status][0] || "")}, h("b", null, HO_ST[ho.status][1]),
      ho.status === "kicked_back" ? h("div", null, "Ops needs: " + ho.kickback_reason) : ho.status === "review" ? h("div", null, "Submitted " + (ho.submitted_at ? fmtDate(ho.submitted_at.slice(0, 10)) : "") + (ho.submitted_by ? " by " + personName(ho.submitted_by) : "") + ". Waiting on operations to accept.")
        : ho.status === "accepted" ? h("div", null, "Accepted " + (ho.accepted_at ? fmtDate(ho.accepted_at.slice(0, 10)) : "") + ". ", ho.project_id ? h("button", {class:"linkish", onclick:() => openProject(ho.project_id)}, "Open the project") : null)
        : h("div", null, "Sales: fill in the packet, then submit it to operations."),
      ho.kickbacks ? h("div", {class:"muted small"}, "Kicked back " + plural(ho.kickbacks, "time")) : null),
    h("p", {class:"muted small"}, [d.name, acctName(d.account_id), d.close_date ? "won " + fmtDate(d.close_date) : null, "sold by " + personName(d.owner_id)].filter(Boolean).join(" · ")),
    h("div", {class:"section-h"}, "Who delivers it"),
    h("div", {class:"form"},
      fld(draft, "department", "Department", "select", {options:deptKeys(), blank:"Choose a department", readonly:locked}),
      fld(draft, "pm_id", "Project manager", "select", {options:pms, blank:"Assigned by operations", readonly:locked || !ops})),
    ...PACKET.flatMap(([title, fields]) => [h("div", {class:"section-h"}, title), h("div", {class:"form"}, fields.map(field))]),
    ["packet", "kicked_back"].includes(ho.status) ? h("div", null, h("div", {class:"section-h"}, "Email to newprojects@rfip.com"),
      h("p", {class:"muted small", style:"margin-top:0"}, "Goes out from your Outlook when you submit, with the subject \u201c" + d.name + (acctName(d.account_id) ? " – " + acctName(d.account_id) : "") + "\u201d and a link to the deal's SharePoint documents. Admin assigns the project number."),
      h("div", {class:"form"}, fld(draft, "office", "Message", "textarea", {full:true}))) : null,
    !locked ? h("p", {class:"muted small"}, "Required before submitting: " + REQUIRED.map(x => x[1]).join(", ") + ".") : null);
  const saveDraft = async extra => {
    const row = Object.assign({department:nullify(draft.department), packet:pk}, ops ? {pm_id:nullify(draft.pm_id)} : {}, extra || {});
    const res = await run(sb.from("handoffs").update(row).eq("id", ho.id).select().single());
    if (res) { await reload("handoffs"); render(); }
    return res;
  };
  const foot = [];
  if (!locked) {
    foot.push(h("button", {class:"btn spacer", onclick: async () => { if (await saveDraft()) { toast("Saved"); closeDrawer(); } }}, "Save"));
    if (["packet", "kicked_back"].includes(ho.status)) foot.push(h("button", {class:"btn primary", onclick: async () => {
      const miss = missingOf(pk); if (miss.length) { toast("Still missing: " + miss.join(", ")); return; }
      if (!draft.department) { toast("Choose the delivering department."); return; }
      if (await saveDraft({status:"review", kickback_reason:null})) {
        toast("Sent to " + draft.department + " for review"); closeDrawer();
        if (core.fnCall) core.fnCall("outlook", {action:"new_project", deal_id:d.id, message:draft.office, resubmit:ho.status === "kicked_back"}).then(r => {
          if (r && r.sent) toast("Also emailed " + r.to + ".");
          else toast("Couldn't email " + ((r && r.to) || "newprojects@rfip.com") + (r && r.connected === false ? ". Sign out and back in with Microsoft so RFIP can send from your Outlook." : (r && r.error ? ": " + r.error : ".")));
        });
        const leads = activePeople().filter(x => x.ops_role === "lead" && x.department === draft.department).map(x => x.id);
        tell([...leads, ho.pm_id], "Handoff ready: " + d.name, (S.me.full_name || S.me.email) + " submitted the handoff packet for " + d.name +
          (acctName(d.account_id) ? " (" + acctName(d.account_id) + ")" : "") + " to " + draft.department + ". It's waiting on operations to accept it.", "#deal=" + d.id);
      }
    }}, "Submit to operations"));
    if (ops && ho.status !== "kicked_back") {
      const reasonBox = h("div", {class:"o-kick", hidden:true}, h("textarea", {class:"inp", id:"kick-reason", placeholder:"What's missing or unclear?", oninput: e => { draft.reason = e.target.value; }}),
        h("button", {class:"btn danger", onclick: async () => {
          if (!draft.reason.trim()) { toast("Say what's missing first."); return; }
          if (await saveDraft({status:"kicked_back", kickback_reason:draft.reason.trim()})) { toast("Kicked back to " + personName(d.owner_id)); closeDrawer();
            tell([d.owner_id, ho.submitted_by], "Handoff kicked back: " + d.name, (S.me.full_name || S.me.email) + " sent the handoff for " + d.name + " back. Operations needs:\n\n" + draft.reason.trim(), "#deal=" + d.id); }
        }}, "Send back to sales"));
      body.append(reasonBox);
      foot.push(h("button", {class:"btn", onclick:() => { reasonBox.hidden = false; reasonBox.querySelector("textarea").focus(); reasonBox.scrollIntoView({block:"nearest"}); }}, "Kick back"));
      foot.push(h("button", {class:"btn primary", onclick: async e => {
        if (!draft.department) { toast("Choose the delivering department."); return; }
        if (!draft.pm_id) { toast("Assign a project manager."); return; }
        const btn = e.currentTarget; btn.disabled = true;
        if (!(await saveDraft())) { btn.disabled = false; return; }
        const pid = await run(sb.rpc("accept_handoff", {hid:ho.id}), "Accepted. Project created.");
        btn.disabled = false;
        if (pid) { await load(); render(); closeDrawer(); if (typeof pid === "string") openProject(pid);
          tell([d.owner_id, ho.submitted_by, draft.pm_id], "Handoff accepted: " + d.name, (S.me.full_name || S.me.email) + " accepted the handoff for " + d.name + ". " +
            personName(draft.pm_id) + " is the project manager.", typeof pid === "string" ? "#project=" + pid : "#deal=" + d.id); }
      }}, "Accept and create project"));
    }
  } else foot.push(h("button", {class:"btn", onclick:() => closeDrawer()}, "Close"));
  openDrawer({title:"Handoff · " + handoffName(ho), body, foot});
}

// ---------------------------------------------------------------- billing grid
function viewBilling() {
  const wrap = h("div", {class:"o-stack"});
  const NOW = monthStart(TODAY);
  const months = Array.from({length:12}, (_, i) => addMonths(NOW, i - 5));
  const nowIdx = 5;
  const pms = [...new Set(O.projects.map(p => p.pm_id).filter(Boolean))];
  wrap.append(h("div", {class:"toolbar"}, h("h2", null, "Billing"),
    role() !== "pm" ? h("select", {"aria-label":"Department", id:"b-dept", onchange: e => { O.dept = e.target.value; render(); }}, h("option", {value:""}, "All departments"), deptKeys().map(k => h("option", {value:k, selected:O.dept === k}, k))) : null,
    pms.length > 1 ? h("select", {"aria-label":"Project manager", id:"b-pm", onchange: e => { O.pm = e.target.value; render(); }}, h("option", {value:""}, "All PMs"), pms.map(id => h("option", {value:id, selected:O.pm === id}, personName(id)))) : null,
    h("label", {class:"o-toggle"}, h("input", {type:"checkbox", id:"b-hand", checked:O.hand, onchange: e => { O.hand = e.target.checked; render(); }}), "Include waiting handoffs")));
  const projs = O.projects.filter(p => p.phase !== "closed" || calc(p).left > 0).filter(p => (!O.dept || p.department === O.dept) && (!O.pm || p.pm_id === O.pm))
    .sort((a, b) => calc(b).total - calc(a).total);
  const hos = O.hand ? openHandoffs().filter(x => (!O.dept || x.department === O.dept) && (!O.pm || x.pm_id === O.pm)) : [];
  const amt = (p, m, kind) => sum(O.bills.filter(b => b.project_id === p.id && b.month === m && b.kind === kind), b => b.amount);
  const hoAmt = (x, m) => { const pk = x.packet || {}; if (!pk.start_date || !pk.end_date) return 0;
    const a = monthStart(addDays(pk.start_date, 20)), z = monthStart(pk.end_date); if (m < a || m > z) return 0;
    let n = 0; for (let t = a; t <= z; t = addMonths(t, 1)) n++; return handoffValue(x) / n; };
  const missed = (p, i) => { if (i >= nowIdx) return false; const m = months[i]; if (amt(p, m, "billed")) return false;
    const before = O.bills.some(b => b.project_id === p.id && b.kind === "billed" && b.month < m); const after = O.bills.some(b => b.project_id === p.id && b.kind === "billed" && b.month > m);
    return before && (after || i === nowIdx - 1) && calc(p).done > 0 && calc(p).billed < calc(p).total; };
  const cs = projs.map(calc);
  const last = sum(projs, p => amt(p, months[nowIdx - 1], "billed")), cur = sum(projs, p => amt(p, NOW, "scheduled") || amt(p, NOW, "billed"));
  const q = sum(projs, p => amt(p, months[nowIdx], "scheduled") + amt(p, months[nowIdx + 1], "scheduled") + amt(p, months[nowIdx + 2], "scheduled"));
  const missedN = projs.filter(p => missed(p, nowIdx - 1)).length;
  wrap.append(h("div", {class:"o-tiles"},
    tile("Billed in " + monthLabel(months[nowIdx - 1]).split(" ")[0], compact(last), projs.filter(p => amt(p, months[nowIdx - 1], "billed")).length + " projects invoiced" + (missedN ? " · " + missedN + " missed" : ""), missedN ? "warn" : ""),
    tile("Scheduled for " + monthLabel(NOW).split(" ")[0], compact(cur), "Next 3 months " + compact(q) + (hos.length ? " · plus handoffs" : "")),
    tile("Earned, not billed", compact(sum(cs, c => c.ready)), "Work done that hasn't been invoiced", sum(cs, c => c.ready) > 100000 ? "warn" : ""),
    tile("Retainage held", compact(sum(cs, c => c.retH)), "Released after closeout"),
    tile("Left to bill", compact(sum(cs, c => c.left)), plural(projs.length, "project") + (hos.length ? " · plus " + compact(sum(hos, handoffValue)) + " in handoffs" : ""))));
  // monthly totals chart
  const tA = months.map(m => sum(projs, p => amt(p, m, m < NOW ? "billed" : "scheduled"))), tH = months.map(m => sum(hos, x => hoAmt(x, m)));
  wrap.append(panel("Billing by month", monthLabel(months[0]) + " – " + monthLabel(months[11]), h("div", {class:"o-pad"}, billChart(months, tA, tH, nowIdx),
    h("div", {class:"o-keys"}, h("span", null, h("i", {class:"sw acc"}), "Billed"), h("span", null, h("i", {class:"sw acc soft"}), "Scheduled on projects"), h("span", null, h("i", {class:"sw muted"}), "Once handoffs start")))));
  // grid
  const head = h("tr", null, h("th", {class:"stick"}, "Project"), ["Contract", "Billed", "Earned, not billed", "Retainage"].map(t => h("th", {class:"num"}, t)),
    months.map((m, i) => h("th", {class:"num" + (i === nowIdx ? " now" : "") + (i === 0 ? " split" : "")}, monthLabel(m))), h("th", {class:"num"}, "Later"), h("th", null, "Next pay app"));
  const cell = (v, cls, onclick) => h("td", {class:"num m " + cls, onclick}, v ? compact(v) : "—");
  const rows = projs.map(p => { const c = calc(p), edit = canEdit(p);
    const shown = sum(months, m => amt(p, m, m < NOW ? "billed" : "scheduled")) + sum(O.bills.filter(b => b.project_id === p.id && b.kind === "billed" && b.month < months[0]), b => b.amount);
    return h("tr", null,
      h("td", {class:"stick"}, h("button", {class:"linkish", onclick:() => openProject(p.id)}, p.name), h("div", {class:"muted small"}, p.number + " · " + p.department + " · " + personName(p.pm_id)),
        p.phase === "closeout" && c.docsOpen.length && c.ready > 1000 ? chip("warn", "Final invoice held for closeout items") : null),
      h("td", {class:"num"}, compact(c.total)), h("td", {class:"num"}, compact(c.billed)), h("td", {class:"num" + (c.ready > 50000 ? " warn-t" : "")}, compact(c.ready)), h("td", {class:"num"}, compact(c.retH)),
      months.map((m, i) => { const past = i < nowIdx, v = amt(p, m, past ? "billed" : "scheduled");
        const click = edit ? () => openBill(p, m) : null;
        if (missed(p, i)) return h("td", {class:"num m miss" + (i === 0 ? " split" : ""), onclick:click}, "Missed");
        return cell(v, (v ? (past ? "act" : "sch") : "zero") + (i === nowIdx ? " now" : "") + (i === 0 ? " split" : "") + (edit ? " edit" : ""), click); }),
      h("td", {class:"num sch"}, compact(Math.max(0, c.total - shown))), h("td", null, p.pay_app_day ? "Day " + p.pay_app_day : "—"));
  });
  const hrows = hos.map(x => h("tr", {class:"pending"},
    h("td", {class:"stick"}, h("button", {class:"linkish", onclick:() => openHandoff(x.id)}, handoffName(x)), h("div", {class:"muted small"}, "Handoff · " + (x.department || "No department")), chip("", HO_ST[x.status][1])),
    h("td", {class:"num"}, compact(handoffValue(x))), h("td", {class:"num"}, "—"), h("td", {class:"num"}, "—"), h("td", {class:"num"}, "—"),
    months.map((m, i) => cell(hoAmt(x, m), "pend" + (i === nowIdx ? " now" : "") + (i === 0 ? " split" : ""))),
    h("td", {class:"num pend"}, compact(Math.max(0, handoffValue(x) - sum(months, m => hoAmt(x, m))))), h("td", null, "—")));
  const tot = (label, list, f) => h("tr", null, h("td", {class:"stick"}, h("b", null, label)), ...f);
  const totals = [tot("Projects", projs, [h("td", {class:"num"}, compact(sum(cs, c => c.total))), h("td", {class:"num"}, compact(sum(cs, c => c.billed))), h("td", {class:"num"}, compact(sum(cs, c => c.ready))), h("td", {class:"num"}, compact(sum(cs, c => c.retH))),
    ...tA.map((v, i) => h("td", {class:"num" + (i === nowIdx ? " now" : "") + (i === 0 ? " split" : "")}, compact(v))), h("td"), h("td")])];
  if (hos.length) totals.push(tot("With handoffs", hos, [h("td", {class:"num"}, compact(sum(cs, c => c.total) + sum(hos, handoffValue))), h("td"), h("td"), h("td"),
    ...tA.map((v, i) => h("td", {class:"num" + (i === nowIdx ? " now" : "") + (i === 0 ? " split" : "")}, compact(v + tH[i]))), h("td"), h("td")]));
  wrap.append(panel("Projects by month", "Past months show what was billed; this month on shows what's scheduled" + (projs.some(canEdit) ? ". Click a month to record or change it." : "."),
    h("div", {class:"tbl-wrap flat o-billgrid"}, h("table", null, h("thead", null, head), h("tbody", null, rows, hrows), h("tfoot", null, totals))),
    h("div", {class:"o-keys pad"}, h("span", null, h("b", {class:"mono"}, "$210K"), " billed"), h("span", null, h("b", {class:"mono sch"}, "$150K"), " scheduled"),
      h("span", null, h("b", {class:"mono pend"}, "$80K"), " handoff not accepted yet"), h("span", null, chip("bad", "Missed"), " earning but nothing invoiced that month"))));
  return wrap;
}
function billChart(months, tA, tH, nowIdx) {
  const W = 1120, H = 250, L = 56, R = 10, T = 20, B = 26;
  const yMax = Math.max(100000, ...tA.map((v, i) => v + tH[i])) * 1.15;
  const bw = (W - L - R) / months.length, ys = v => T + (1 - v / yMax) * (H - T - B);
  const g = [svg("rect", {x:L + nowIdx * bw, y:T - 8, width:bw, height:H - T - B + 8, class:"nowband"})];
  for (let i = 0; i <= 4; i++) { const v = yMax / 4 * i; g.push(svg("line", {x1:L, x2:W - R, y1:ys(v), y2:ys(v), class:"grid"}), svg("text", {x:L - 6, y:ys(v) + 4, "text-anchor":"end"}, i ? compact(v) : "0")); }
  months.forEach((m, i) => {
    const x = L + i * bw + bw * .18, w = bw * .64, a = tA[i], hh = tH[i];
    if (a) g.push(svg("rect", {x, y:ys(a), width:w, height:ys(0) - ys(a), rx:3, class: i < nowIdx ? "bar" : "bar soft"}, svg("title", null, monthLabel(m) + ": " + compact(a))));
    if (hh) g.push(svg("rect", {x, y:ys(a + hh), width:w, height:ys(a) - ys(a + hh), rx:3, class:"bar muted"}, svg("title", null, monthLabel(m) + ": " + compact(hh) + " from handoffs")));
    if (a + hh) g.push(svg("text", {x:x + w / 2, y:ys(a + hh) - 5, "text-anchor":"middle", class:"lbl"}, compact(a + hh)));
    g.push(svg("text", {x:x + w / 2, y:H - 8, "text-anchor":"middle", class: i === nowIdx ? "lbl" : null}, monthLabel(m).split(" ")[0]));
  });
  return svg("svg", {viewBox:`0 0 ${W} ${H}`, class:"o-chart", role:"img", "aria-label":"Billing totals by month"}, g);
}

// ---------------------------------------------------------------- manpower schedule
const DOW = d => { const [y, m, dd] = d.split("-").map(Number); return new Date(Date.UTC(y, m - 1, dd)).getUTCDay(); };
const mondayOf = d => addDays(d, -((DOW(d) + 6) % 7));
const weekDates = mon => [0, 1, 2, 3, 4].map(i => addDays(mon, i));
const isWeekend = d => DOW(d) === 0 || DOW(d) === 6;
const dayName = d => new Date(d + "T12:00:00").toLocaleDateString("en-US", {weekday:"short"});
const dayLabel = d => new Date(d + "T12:00:00").toLocaleDateString("en-US", {weekday:"short", month:"short", day:"numeric"});
const tech = id => byId(O.techs, id) || {};
const proj = id => byId(O.projects, id) || byId(O.dir, id) || {};
const jobs = () => O.dir.length ? O.dir : O.projects;
const short = p => (p.number || "").split("-")[1] || p.number || "?";
const pjClass = id => { const i = jobs().findIndex(p => p.id === id); return "pj" + ((i < 0 ? 0 : i) % 10); };
const asgOn = (techId, d) => O.asg.find(a => a.tech_id === techId && a.work_date === d);
const needFor = (projectId, d) => { const x = O.plan.find(r => r.project_id === projectId && r.week_start === mondayOf(d)); return x ? x.techs : 0; };
const canSchedule = (projectId, techId, kind) => { const r = role(); if (r === "admin") return true;
  if (kind === "job") { const p = proj(projectId); return !!p.id && canEdit(p); }
  return r === "lead" && tech(techId).department === S.me.department; };
// who's on a project this week, for the project page
function scheduleRoster(projectId) {
  if (!O.techs.length) return O.roster.filter(r => r.project_id === projectId).sort((a, b) => a.sort - b.sort);
  const days = weekDates(mondayOf(TODAY)), L = "MTWRF", by = new Map();
  for (const a of O.asg) {
    if (a.project_id !== projectId) continue;
    const i = days.indexOf(a.work_date); if (i < 0) continue;
    const t = tech(a.tech_id); if (!by.has(a.tech_id)) by.set(a.tech_id, {tech_id:a.tech_id, name:t.name || "—", role:t.trade || "", days:"", sort:t.sort || 0});
    by.get(a.tech_id).days += L[i];
  }
  return [...by.values()].map(r => ({...r, days:L.split("").filter(x => r.days.includes(x)).join("")})).sort((a, b) => (b.role === "Foreman") - (a.role === "Foreman") || a.sort - b.sort);
}
function techsShown() {
  const dep = O.mpDept;
  return O.techs.filter(t => t.active && (!dep || t.department === dep))
    .sort((a, b) => deptKeys().indexOf(a.department) - deptKeys().indexOf(b.department) || a.sort - b.sort || a.name.localeCompare(b.name));
}
function projectsShown(dates) {
  return jobs().filter(p => (!O.mpDept || p.department === O.mpDept) && p.phase !== "closed" &&
    dates.some(d => needFor(p.id, d) > 0 || O.asg.some(a => a.project_id === p.id && a.work_date === d)))
    .sort((a, b) => a.department.localeCompare(b.department) || a.number.localeCompare(b.number));
}
function asgCell(t, d, size) {
  const a = asgOn(t.id, d), weekend = isWeekend(d);
  const p = a && a.project_id ? proj(a.project_id) : null;
  const editable = role() === "admin" || role() === "lead" || role() === "pm";
  const click = editable ? () => openAssign({techId:t.id, date:d, projectId:a ? a.project_id : null}) : null;
  let inner = null, cls = "mp-cell" + (weekend ? " wkend" : "") + (d === TODAY ? " today" : "") + (editable ? " edit" : "");
  if (a && a.kind === "job") { inner = h("span", {class:"mp-chip " + pjClass(a.project_id), title:(p ? p.number + " · " + p.name : "Job") + (a.note ? " · " + a.note : "")}, size === "s" ? short(p || {}) : (p ? p.number : "Job")); }
  else if (a) { inner = h("span", {class:"mp-chip off", title:(a.kind === "pto" ? "Time off" : "Training") + (a.note ? " · " + a.note : "")}, a.kind === "pto" ? "PTO" : size === "s" ? "TRN" : "Training"); }
  return h("td", {class:cls, onclick:click, title: !a && editable ? "Assign " + t.name + " on " + dayLabel(d) : null}, inner);
}
function mpToolbar(label, dates) {
  const step = dir => {
    const d = O.mpDate || TODAY;
    if (O.mpMode === "day") { let n = addDays(d, dir); while (isWeekend(n)) n = addDays(n, dir); O.mpDate = n; }
    else if (O.mpMode === "week") O.mpDate = addDays(mondayOf(d), dir * 7);
    else O.mpDate = addMonths(monthStart(d), dir);
    render();
  };
  return h("div", {class:"toolbar"}, h("h2", null, "Manpower"),
    h("div", {class:"sections mp-modes", role:"group", "aria-label":"Board"}, [["day", "Day"], ["week", "Week"], ["month", "Month"]].map(([m, t]) =>
      h("button", {"aria-pressed":String(O.mpMode === m), onclick:() => { O.mpMode = m; try { localStorage.setItem("rfipops.mpMode", m); } catch (e) {} render(); }}, t))),
    h("div", {class:"mp-nav"}, h("button", {class:"btn small", "aria-label":"Previous", onclick:() => step(-1)}, "‹"),
      h("button", {class:"btn small", onclick:() => { O.mpDate = null; render(); }}, "Today"),
      h("button", {class:"btn small", "aria-label":"Next", onclick:() => step(1)}, "›"), h("b", {class:"mp-label"}, label)),
    h("select", {"aria-label":"Department", id:"mp-dept", onchange: e => { O.mpDept = e.target.value; render(); }},
      h("option", {value:""}, "All departments"), deptKeys().map(k => h("option", {value:k, selected:O.mpDept === k}, k))),
    role() === "admin" || role() === "lead" ? h("button", {class:"btn small", onclick:() => openTech()}, "+ Tech") : null,
    role() === "admin" || role() === "lead" || role() === "pm" ? h("button", {class:"btn primary small", onclick:() => openAssign({date:dates.find(d => d >= TODAY) || dates[0]})}, "Assign") : null);
}
function mpSummary(dates) {
  const ts = techsShown(), ids = new Set(ts.map(t => t.id));
  const work = dates.filter(d => !isWeekend(d));
  const sched = work.map(d => O.asg.filter(a => ids.has(a.tech_id) && a.work_date === d && a.kind === "job").length);
  const off = work.map(d => O.asg.filter(a => ids.has(a.tech_id) && a.work_date === d && a.kind !== "job").length);
  const ps = projectsShown(dates);
  const shortDays = ps.map(p => work.reduce((n, d) => n + Math.max(0, needFor(p.id, d) - O.asg.filter(a => a.project_id === p.id && a.work_date === d).length), 0));
  const capDays = ts.length * work.length, schedDays = sum(sched, x => x), offDays = sum(off, x => x);
  const one = work.length === 1;
  return h("div", {class:"o-tiles"},
    tile(one ? "Scheduled" : "Person-days scheduled", String(schedDays), capDays ? pct(schedDays / Math.max(1, capDays - offDays)) + " of available" + (one ? "" : " · " + ts.length + " techs") : ""),
    tile(one ? "Not assigned" : "Unassigned person-days", String(Math.max(0, capDays - schedDays - offDays)), one ? "Free to send to a job" : "Free days across the crew", capDays - schedDays - offDays > ts.length ? "warn" : ""),
    tile(one ? "Open slots" : "Unfilled person-days", String(sum(shortDays, x => x)), "Needed on jobs, nobody scheduled", sum(shortDays, x => x) ? "bad" : ""),
    tile("Time off and training", String(offDays), one ? "people out today" : "person-days"));
}
function needsTable(dates) {
  const work = dates.filter(d => !isWeekend(d));
  const ps = projectsShown(dates); if (!ps.length) return null;
  return panel("Needs vs scheduled", "Crew each job needs (from its crew plan) against who's on the board",
    h("div", {class:"tbl-wrap flat"}, h("table", null,
      h("thead", null, h("tr", null, h("th", null, "Job"), h("th", null, "PM"), work.map(d => h("th", {class:"num" + (d === TODAY ? " now" : "")}, work.length > 5 ? dayName(d) : dayLabel(d))), h("th", null, ""))),
      h("tbody", null, ps.map(p => { const gaps = work.map(d => needFor(p.id, d) - O.asg.filter(a => a.project_id === p.id && a.work_date === d).length);
        return h("tr", null, h("td", null, h("span", {class:"mp-chip " + pjClass(p.id)}, p.number), " ", byId(O.projects, p.id) ? h("button", {class:"linkish", onclick:() => openProject(p.id)}, p.name) : p.name),
          h("td", null, personName(p.pm_id)),
          work.map((d, i) => { const n = needFor(p.id, d), s = n - gaps[i];
            return h("td", {class:"num" + (gaps[i] > 0 ? " bad-t" : "") + (d === TODAY ? " now" : ""), title:s + " scheduled of " + n + " needed"}, n || s ? s + "/" + n : "—"); }),
          h("td", null, !byId(O.projects, p.id) ? "" : gaps.some(g => g > 0) ? (canEdit(p) ? h("button", {class:"btn small", onclick:() => openAssign({projectId:p.id, date:work[Math.max(0, gaps.findIndex(g => g > 0))]})}, "Fill") : chip("bad", "Short")) : chip("go", "Covered"))); })))));
}
function viewManpower() {
  const wrap = h("div", {class:"o-stack"});
  const base = O.mpDate || TODAY;
  if (!O.techs.length) {
    wrap.append(mpToolbar("", [TODAY]), h("div", {class:"panel"}, emptyState("No field techs yet", role() === "admin" || role() === "lead" ? "Add your techs with + Tech, then assign them to jobs." : "An admin or department lead adds the tech roster first.")));
    return wrap;
  }
  if (O.mpMode === "day") {
    let d = base; while (isWeekend(d)) d = addDays(d, 1);
    wrap.append(mpToolbar(dayLabel(d) + (d === TODAY ? " · today" : ""), [d]), mpSummary([d]), dayBoard(d));
  } else if (O.mpMode === "month") {
    const m0 = monthStart(base), days = []; for (let d = m0; d < addMonths(m0, 1); d = addDays(d, 1)) if (!isWeekend(d)) days.push(d);
    wrap.append(mpToolbar(new Date(m0 + "T12:00:00").toLocaleDateString("en-US", {month:"long", year:"numeric"}), days), mpSummary(days), monthBoard(days));
  } else {
    const days = weekDates(mondayOf(base));
    wrap.append(...[mpToolbar("Week of " + fmtDate(days[0]), days), mpSummary(days), weekBoard(days), needsTable(days)].filter(Boolean));
  }
  wrap.append(h("p", {class:"muted small"}, role() === "pm" ? "You can schedule people onto your own jobs and take them off. Someone already on another job that day has to be released by that job's PM first."
    : role() === "field" ? "Your crew schedule. Your PM makes changes." : "PMs schedule people onto their own jobs. Department leads can also record time off and training for their techs."));
  return wrap;
}
function groupedRows(ts, cells) {
  const rows = []; let last = null;
  for (const t of ts) {
    if (t.department !== last) { last = t.department; rows.push(h("tr", {class:"mp-group"}, h("td", {class:"stick", colspan:"1"}, h("b", null, t.department || "No department")), h("td", {colspan:"60"}))); }
    rows.push(h("tr", {class: t.profile_id === S.me.id ? "me" : null}, h("td", {class:"stick"},
      h("button", {class:"linkish who", disabled: !(role() === "admin" || (role() === "lead" && t.department === S.me.department)), onclick:() => openTech(t)}, t.name), h("small", null, t.trade || "")), cells(t)));
  }
  return rows;
}
function weekBoard(days) {
  const ts = techsShown();
  const foot = days.map(d => O.asg.filter(a => ts.some(t => t.id === a.tech_id) && a.work_date === d && a.kind === "job").length);
  return panel("Week board", "Click a day to assign or change it", h("div", {class:"tbl-wrap flat mp-board"}, h("table", null,
    h("thead", null, h("tr", null, h("th", {class:"stick"}, "Tech"), days.map(d => h("th", {class:"mp-h" + (d === TODAY ? " today" : "")}, dayLabel(d))))),
    h("tbody", null, groupedRows(ts, t => days.map(d => asgCell(t, d)))),
    h("tfoot", null, h("tr", null, h("td", {class:"stick"}, "Scheduled"), foot.map((n, i) => h("td", {class:"num" + (days[i] === TODAY ? " today" : "")}, n + " / " + ts.length)))))));
}
function monthBoard(days) {
  const ts = techsShown();
  const util = t => { const w = days.filter(d => d <= addMonths(monthStart(days[0]), 1)); const n = w.filter(d => { const a = asgOn(t.id, d); return a && a.kind === "job"; }).length; return w.length ? n / w.length : 0; };
  const used = [...new Set(O.asg.filter(a => a.project_id && days.includes(a.work_date) && ts.some(t => t.id === a.tech_id)).map(a => a.project_id))];
  return panel("Month board", "Each square is a workday; the number is the job", h("div", {class:"tbl-wrap flat mp-board month"}, h("table", null,
    h("thead", null, h("tr", null, h("th", {class:"stick"}, "Tech"), days.map(d => h("th", {class:"mp-h" + (d === TODAY ? " today" : "") + (DOW(d) === 1 ? " mon" : "")}, h("span", null, dayName(d)[0]), h("b", null, d.slice(8).replace(/^0/, "")))), h("th", {class:"num"}, "Booked"))),
    h("tbody", null, groupedRows(ts, t => [...days.map(d => asgCell(t, d, "s")), h("td", {class:"num" + (util(t) < .5 ? " warn-t" : "")}, pct(util(t)))])),
    h("tfoot", null, h("tr", null, h("td", {class:"stick"}, "Scheduled"), days.map(d => h("td", {class:"num" + (d === TODAY ? " today" : "")}, String(O.asg.filter(a => ts.some(t => t.id === a.tech_id) && a.work_date === d && a.kind === "job").length))), h("td"))))),
    used.length ? h("div", {class:"o-keys pad"}, used.map(id => h("span", null, h("span", {class:"mp-chip " + pjClass(id)}, short(proj(id))), " " + proj(id).name))) : null);
}
function dayBoard(d) {
  const ts = techsShown(), ids = new Set(ts.map(t => t.id));
  const ps = projectsShown([d]);
  const todays = O.asg.filter(a => a.work_date === d && ids.has(a.tech_id));
  const free = ts.filter(t => !todays.some(a => a.tech_id === t.id));
  const out = todays.filter(a => a.kind !== "job");
  const card = p => { const crew = todays.filter(a => a.project_id === p.id).map(a => tech(a.tech_id)).sort((a, b) => a.sort - b.sort), n = byId(O.projects, p.id) ? needFor(p.id, d) : crew.length, edit = canEdit(p);
    return h("div", {class:"mp-card"},
      h("div", {class:"mp-card-h"}, h("span", {class:"mp-chip " + pjClass(p.id)}, p.number), byId(O.projects, p.id) ? h("button", {class:"linkish", onclick:() => openProject(p.id)}, p.name) : h("b", {class:"grow"}, p.name),
        h("span", {class:"chip " + (crew.length < n ? "bad" : "go")}, crew.length + " of " + n)),
      h("div", {class:"muted small"}, p.department + " · PM " + personName(p.pm_id)),
      h("ul", null, crew.map(t => h("li", null, h("span", null, t.name, h("small", null, t.trade || "")),
        edit ? h("button", {class:"btn small", "aria-label":"Take " + t.name + " off this job", onclick:() => openAssign({techId:t.id, date:d, projectId:p.id})}, "Change") : null)),
        crew.length < n ? h("li", {class:"open"}, (n - crew.length) + " open " + (n - crew.length === 1 ? "slot" : "slots")) : null),
      edit ? h("button", {class:"btn small", onclick:() => openAssign({projectId:p.id, date:d})}, "+ Add someone") : null); };
  return h("div", {class:"o-stack"},
    h("div", {class:"mp-cards"}, ps.map(card)),
    h("div", {class:"o-two even"},
      panel("Not assigned", people(free.length), free.length ? h("ul", {class:"mp-free"}, free.map(t => h("li", null, h("span", null, t.name, h("small", null, t.department + " · " + (t.trade || ""))),
        role() === "pm" || role() === "admin" || role() === "lead" ? h("button", {class:"btn small", onclick:() => openAssign({techId:t.id, date:d})}, "Assign") : null))) : h("div", {class:"empty"}, "Everyone is on a job.")),
      panel("Out", people(out.length), out.length ? h("ul", {class:"mp-free"}, out.map(a => h("li", null, h("span", null, tech(a.tech_id).name, h("small", null, (a.kind === "pto" ? "Time off" : "Training") + (a.note ? " · " + a.note : "")))))) : h("div", {class:"empty"}, "Nobody out."))));
}
function openAssign(opts) {
  const r = role();
  const jobs = O.projects.filter(p => p.phase !== "closed" && canEdit(p)).sort((a, b) => a.number.localeCompare(b.number));
  const d = {tech_id:opts.techId || null, target:opts.projectId ? opts.projectId : (jobs[0] && r === "pm" ? jobs[0].id : ""), from:opts.date || TODAY, to:opts.date || TODAY, note:""};
  const kinds = [...jobs.map(p => [p.id, p.number + " · " + p.name])];
  if (r === "admin" || r === "lead") kinds.push(["pto", "Time off"], ["training", "Training"]);
  const techOpts = O.techs.filter(t => t.active).sort((a, b) => a.department.localeCompare(b.department) || a.sort - b.sort).map(t => {
    const a = asgOn(t.id, d.from); return [t.id, t.name + " · " + t.department + (a ? " (" + (a.kind === "job" ? proj(a.project_id).number : a.kind === "pto" ? "PTO" : "training") + ")" : " (free)")]; });
  const rangeBox = h("div", {class:"o-actions", style:"grid-column:1/-1;justify-content:flex-start;border:0;padding:0"},
    h("button", {class:"btn small", type:"button", onclick:() => { d.to = addDays(mondayOf(d.from), 4); document.getElementById("f-to").value = d.to; }}, "Rest of the week"),
    h("button", {class:"btn small", type:"button", onclick:() => { d.to = addDays(mondayOf(d.from), 11); document.getElementById("f-to").value = d.to; }}, "Through next week"),
    d.target && proj(d.target).end_date ? h("button", {class:"btn small", type:"button", onclick:() => { d.to = proj(d.target).end_date; document.getElementById("f-to").value = d.to; }}, "Through end of job") : null);
  const cur = opts.techId && opts.date ? asgOn(opts.techId, opts.date) : null;
  const body = h("div", {class:"form"},
    fld(d, "tech_id", "Person", "select", {options:techOpts, blank:"Choose a tech", full:true}),
    fld(d, "target", "Job", "select", {options:kinds, blank: kinds.length ? "Choose a job" : "You don't manage any active jobs", full:true}),
    fld(d, "from", "From", "date"), fld(d, "to", "Through", "date"), rangeBox,
    fld(d, "note", "Note (optional)", "text", {full:true}),
    h("p", {class:"muted small", style:"grid-column:1/-1;margin:0"}, "Weekdays only. If the person is already on another job, that job's PM has to release them first."));
  const datesIn = () => { const out = []; for (let x = d.from; x <= d.to && out.length < 120; x = addDays(x, 1)) if (!isWeekend(x)) out.push(x); return out; };
  const foot = [];
  if (cur && canSchedule(cur.project_id, cur.tech_id, cur.kind)) foot.push(h("button", {class:"btn danger spacer", onclick: async () => {
    const dates = datesIn().filter(x => { const a = asgOn(d.tech_id || cur.tech_id, x); return a && (a.project_id || a.kind) === (cur.project_id || cur.kind); });
    const ok = await run(sb.from("assignments").delete().eq("tech_id", cur.tech_id).in("work_date", dates.length ? dates : [cur.work_date]),
      "Removed " + tech(cur.tech_id).name + (dates.length > 1 ? " for " + dates.length + " days" : ""));
    if (ok) { await reload("asg"); render(); closeDrawer(); }
  }}, cur.kind === "job" ? "Take off this job" : "Remove time off"));
  foot.push(h("button", {class:"btn" + (foot.length ? "" : " spacer"), onclick:() => closeDrawer()}, "Cancel"));
  foot.push(h("button", {class:"btn primary", onclick: async e => {
    if (!d.tech_id) { toast("Choose a person."); return; }
    if (!d.target) { toast("Choose a job."); return; }
    if (d.to < d.from) { toast("The end date is before the start date."); return; }
    const kind = d.target === "pto" || d.target === "training" ? d.target : "job";
    const projectId = kind === "job" ? d.target : null;
    const rows = [], blocked = [];
    for (const x of datesIn()) {
      const a = asgOn(d.tech_id, x);
      if (a && a.kind === kind && a.project_id === projectId) continue;
      if (a && !canSchedule(a.project_id, a.tech_id, a.kind)) { blocked.push([x, a]); continue; }
      rows.push({tech_id:d.tech_id, work_date:x, kind, project_id:projectId, note:nullify(d.note), created_by:S.me.id});
    }
    const btn = e.currentTarget; btn.disabled = true;
    let ok = true;
    if (rows.length) ok = !!(await run(sb.from("assignments").upsert(rows, {onConflict:"tech_id,work_date"})));
    btn.disabled = false;
    await reload("asg"); render();
    if (blocked.length) {
      const b = blocked[0][1], p = proj(b.project_id);
      toast((rows.length ? "Scheduled " + rows.length + " days. " : "") + tech(d.tech_id).name + " is on " + (b.kind === "job" ? p.number + " (" + personName(p.pm_id) + ")" : "time off") + " " + plural(blocked.length, "day") + ". Ask " + (b.kind === "job" ? personName(p.pm_id) : "their lead") + " to release them.");
    } else if (ok) toast(rows.length ? tech(d.tech_id).name + " scheduled for " + plural(rows.length, "day") : "Already scheduled");
    if (ok) closeDrawer();
  }}, "Save"));
  openDrawer({title: cur ? tech(cur.tech_id).name + " · " + dayLabel(cur.work_date) : "Assign crew", body, foot});
}
function openTech(t) {
  const lead = role() === "lead";
  const d = t ? {...t} : {name:"", department: lead ? S.me.department : (O.mpDept || deptKeys()[0]), trade:"Tech", active:true, sort:99, profile_id:null};
  const logins = activePeople().filter(x => x.ops_role === "field").map(x => [x.id, x.full_name || x.email]);
  const body = [fld(d, "name", "Name", "text", {full:true}), fld(d, "department", "Department", "select", {options:deptKeys(), blank:false, readonly:lead}),
    fld(d, "trade", "Trade", "select", {options:["Foreman", "Lead tech", "Tech", "Apprentice", "Climber", "Climber / foreman", "RF engineer", "Project coordinator"], blank:false}),
    fld(d, "profile_id", "App login (lets them see their schedule and add field logs)", "select", {options:logins, blank:"No login", full:true}),
    t ? h("label", {class:"field check"}, h("input", {type:"checkbox", checked:d.active !== false, onchange: e => { d.active = e.target.checked; }}), h("span", null, "Active (uncheck when someone leaves; their history stays)")) : null];
  drawerForm(t ? t.name : "Add a field tech", d, body.filter(Boolean),
    () => { if (!(d.name || "").trim()) { toast("Add a name."); return false; }
      return saveRow("techs", {name:d.name.trim(), department:d.department, trade:d.trade, profile_id:nullify(d.profile_id), active:d.active !== false, sort:d.sort || 99}, t && t.id); });
}


// ---------------------------------------------------------------- timeline (Gantt)
// Full-width view to coordinate time across jobs: projects as bars (name, % complete, milestones,
// plan phases on demand) or people as bars of who's on which job, over months.
const TL_SPANS = {projects:[[3, "3 months"], [6, "6 months"], [12, "12 months"]], people:[[4, "4 weeks"], [8, "8 weeks"], [13, "3 months"], [26, "6 months"]]};
const tlSave = () => { try { localStorage.setItem("rfipops.tl", JSON.stringify({mode:O.tl.mode, span:O.tl.span, group:O.tl.group, show:O.tl.show})); } catch (e) {} };
function tlRange() {
  const t = O.tl;
  if (t.mode === "projects") {
    const span = [3, 6, 12].includes(t.span) ? t.span : 6;
    const start = t.start || addMonths(monthStart(TODAY), span >= 6 ? -1 : 0);
    return {start, end:addDays(addMonths(start, span), -1), ppd: span === 3 ? 11 : span === 6 ? 6 : 3.2, span};
  }
  const span = [4, 8, 13, 26].includes(t.span) ? t.span : 8;
  const start = t.start || addDays(mondayOf(TODAY), -7);
  return {start, end:addDays(start, span * 7 - 1), ppd: span === 4 ? 34 : span === 8 ? 18 : span === 13 ? 11 : 6, span};
}
function tlScale(r) {
  const days = dayDiff(r.start, r.end) + 1;
  const x = d => Math.max(0, Math.min(days, dayDiff(r.start, d))) / days * 100;
  return {days, x, w: (a, b) => Math.max(0, x(addDays(b, 1)) - x(a))};
}
function tlHeader(r, sc) {
  const ticks = [], subs = [];
  if (O.tl.mode === "projects") {
    for (let m = monthStart(r.start); m <= r.end; m = addMonths(m, 1)) {
      const a = m < r.start ? r.start : m, b = addDays(addMonths(m, 1), -1) > r.end ? r.end : addDays(addMonths(m, 1), -1);
      ticks.push(h("div", {class:"tl-tick", style:`left:${sc.x(a)}%;width:${sc.w(a, b)}%`}, new Date(m + "T12:00:00").toLocaleDateString("en-US", {month:"short", year: m.slice(5, 7) === "01" || m === monthStart(r.start) ? "numeric" : undefined})));
    }
    for (let w = mondayOf(r.start); w <= r.end; w = addDays(w, 7)) if (w >= r.start && r.ppd >= 6) subs.push(h("div", {class:"tl-sub", style:`left:${sc.x(w)}%`}, String(Number(w.slice(8)))));
  } else {
    for (let w = mondayOf(r.start); w <= r.end; w = addDays(w, 7)) {
      ticks.push(h("div", {class:"tl-tick", style:`left:${sc.x(w)}%;width:${sc.w(w, addDays(w, 6))}%`}, (r.ppd >= 11 ? "Week of " : "") + new Date(w + "T12:00:00").toLocaleDateString("en-US", {month:"short", day:"numeric"})));
      if (r.ppd >= 18) for (let i = 0; i < 5; i++) subs.push(h("div", {class:"tl-sub" + (addDays(w, i) === TODAY ? " now" : ""), style:`left:${sc.x(addDays(w, i))}%;width:${sc.w(addDays(w, i), addDays(w, i))}%`}, "MTWTF"[i]));
    }
  }
  return h("div", {class:"tl-row tl-head"}, h("div", {class:"tl-lab"}, O.tl.mode === "projects" ? "Project" : "Person"), h("div", {class:"tl-track"}, ticks, subs.length ? h("div", {class:"tl-subs"}, subs) : null));
}
function tlGrid(r, sc) {
  const lines = [];
  if (O.tl.mode === "projects") { for (let m = monthStart(r.start); m <= r.end; m = addMonths(m, 1)) if (m >= r.start) lines.push(h("i", {class:"tl-line", style:`left:${sc.x(m)}%`})); }
  else for (let w = mondayOf(r.start); w <= r.end; w = addDays(w, 7)) { if (w >= r.start) lines.push(h("i", {class:"tl-line", style:`left:${sc.x(w)}%`}));
    if (r.ppd >= 11) lines.push(h("i", {class:"tl-wkend", style:`left:${sc.x(addDays(w, 5))}%;width:${sc.w(addDays(w, 5), addDays(w, 6))}%`})); }
  if (TODAY >= r.start && TODAY <= r.end) lines.push(h("i", {class:"tl-today", style:`left:${sc.x(TODAY) + sc.w(TODAY, TODAY) / 2}%`, title:"Today"}));
  return h("div", {class:"tl-grid"}, lines);
}
// a project's dates: its own start/end, else its plan and milestones
function tlSpanOf(p) {
  const ds = [], de = [];
  if (p.start_date) ds.push(p.start_date); if (p.end_date) de.push(p.end_date);
  if (!ds.length || !de.length) for (const i of itemsOf(p.id)) { if (i.start_date) ds.push(i.start_date); if (i.due_date) de.push(i.due_date); }
  if (!ds.length || !de.length) for (const m of O.ms.filter(m => m.project_id === p.id)) { if (m.planned) { ds.push(m.planned); de.push(m.planned); } }
  if (!ds.length && !de.length) return null;
  const a = (p.start_date || ds.sort()[0] || de.sort()[0]), b = (p.end_date || de.sort().slice(-1)[0] || a);
  return {a, b: b < a ? a : b, guessed: !(p.start_date && p.end_date)};
}
// who sees which jobs on the timeline: admins, viewers and department leads see every active job;
// a PM sees the jobs they run and the ones shared with them
const tlJobs = () => role() === "pm" ? O.projects.filter(p => p.pm_id === S.me.id || (O.members || []).some(m => m.project_id === p.id && m.profile_id === S.me.id)) : jobs();
function tlProjects(r, sc) {
  const t = O.tl;
  const pool = tlJobs().filter(p => p.phase !== "closed" && (!t.dept || p.department === t.dept) && (!t.pm || p.pm_id === t.pm))
    .map(p => ({p:byId(O.projects, p.id) || p, sp:tlSpanOf(byId(O.projects, p.id) || p)}))
    .filter(x => x.sp && x.sp.b >= r.start && x.sp.a <= r.end)
    .sort((a, b) => a.sp.a.localeCompare(b.sp.a) || a.p.number.localeCompare(b.p.number));
  const undated = tlJobs().filter(p => p.phase !== "closed" && (!t.dept || p.department === t.dept) && (!t.pm || p.pm_id === t.pm) && !tlSpanOf(byId(O.projects, p.id) || p));
  const groupKey = x => t.group === "pm" ? personName(x.p.pm_id) : t.group === "customer" ? (acctName(x.p.account_id) || "Customer not set") : (x.p.department || "No department");
  const groups = new Map(); for (const x of pool) { const k = t.group === "none" ? "" : groupKey(x); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(x); }
  const keys = [...groups.keys()].sort((a, b) => t.group === "dept" ? deptKeys().indexOf(a) - deptKeys().indexOf(b) : a.localeCompare(b));
  const rows = [];
  for (const k of keys) {
    if (k) rows.push(h("div", {class:"tl-row tl-grp"}, h("div", {class:"tl-lab"}, h("b", null, k), h("small", null, plural(groups.get(k).length, "project"))), h("div", {class:"tl-track"})));
    for (const {p, sp} of groups.get(k)) {
      const full = !!byId(O.projects, p.id), pctDone = Math.max(0, Math.min(100, Number(p.pct_complete) || 0));
      const late = sp.b < TODAY && p.phase !== "closeout";
      const phases = full ? itemsOf(p.id).filter(i => !i.parent_id && (i.start_date || i.due_date)).sort((a, b) => (a.start_date || a.due_date).localeCompare(b.start_date || b.due_date)) : [];
      const isOpen = t.open.has(p.id);
      const ms = full ? O.ms.filter(m => m.project_id === p.id && (m.actual || m.planned)) : [];
      const openIss = full ? O.issues.filter(i => i.project_id === p.id && issOpen(i)).length : 0;
      const crew = new Set(O.asg.filter(a => a.project_id === p.id && a.work_date >= mondayOf(TODAY) && a.work_date <= addDays(mondayOf(TODAY), 4)).map(a => a.tech_id)).size;
      rows.push(h("div", {class:"tl-row"},
        h("div", {class:"tl-lab"},
          phases.length ? h("button", {class:"tl-caret", "aria-expanded":String(isOpen), "aria-label":(isOpen ? "Hide" : "Show") + " plan phases", onclick:() => { isOpen ? t.open.delete(p.id) : t.open.add(p.id); render(); }}, isOpen ? "▾" : "▸") : h("span", {class:"tl-caret"}),
          h("div", {class:"tl-name"}, full ? h("button", {class:"linkish", onclick:() => openProject(p.id)}, p.name) : h("b", null, p.name),
            h("small", null, [p.number, t.group !== "pm" ? personName(p.pm_id) : null, t.group !== "customer" && full ? acctName(p.account_id) : null].filter(Boolean).join(" · ")))),
        h("div", {class:"tl-track"},
          h("button", {class:"tl-bar " + pjClass(p.id) + (late ? " late" : "") + (sp.guessed ? " guess" : ""), style:`left:${sc.x(sp.a)}%;width:${Math.max(.4, sc.w(sp.a, sp.b))}%`,
              title:`${p.number} · ${p.name}\n${fmtDate(sp.a)} – ${fmtDate(sp.b)} · ${pctDone}% complete · PM ${personName(p.pm_id)}${crew ? "\n" + people(crew) + " scheduled this week" : ""}${openIss ? "\n" + plural(openIss, "open issue") : ""}${sp.guessed ? "\nDates estimated from the plan" : ""}`,
              onclick:() => full && openProject(p.id)},
            h("i", {class:"tl-done", style:`width:${pctDone}%`}),
            h("span", null, p.name + (pctDone ? " · " + pctDone + "%" : "") + (crew ? " · " + crew + " crew" : "") + (openIss ? " · " + plural(openIss, "issue") : ""))),
          ms.map(m => { const d = m.actual || m.planned, lateM = !m.actual && m.planned < TODAY;
            return d >= r.start && d <= r.end ? h("span", {class:"tl-ms" + (m.actual ? " done" : lateM ? " late" : ""), style:`left:${sc.x(d) + sc.w(d, d) / 2}%`, title:m.name + " · " + (m.actual ? "done " + fmtDate(m.actual) : "planned " + fmtDate(m.planned))}) : null; }))));
      if (isOpen) for (const ph of phases) {
        const a = ph.start_date || ph.due_date, b = ph.due_date || ph.start_date;
        rows.push(h("div", {class:"tl-row tl-phase"}, h("div", {class:"tl-lab"}, h("span", {class:"tl-caret"}), h("div", {class:"tl-name"}, h("span", null, ph.title), h("small", null, planStLabel(ph.status) + (ph.assignee_id ? " · " + personName(ph.assignee_id) : "")))),
          h("div", {class:"tl-track"}, b >= r.start && a <= r.end ? h("button", {class:"tl-bar thin st-" + ph.status + (isLate(ph) ? " late" : ""), style:`left:${sc.x(a)}%;width:${Math.max(.4, sc.w(a, b))}%`,
            title:ph.title + "\n" + fmtDate(a) + " – " + fmtDate(b), onclick:() => openPlanItem(p, ph)}, h("span", null, ph.title)) : null)));
      }
    }
  }
  return {rows, count:pool.length, undated};
}
function tlPeople(r, sc) {
  const t = O.tl, ts = O.techs.filter(x => x.active && (!t.dept || x.department === t.dept))
    .sort((a, b) => deptKeys().indexOf(a.department) - deptKeys().indexOf(b.department) || a.sort - b.sort || a.name.localeCompare(b.name));
  const editable = ["admin", "lead", "pm"].includes(role());
  const rows = []; let last = null;
  const workdays = []; for (let d = r.start; d <= r.end; d = addDays(d, 1)) if (!isWeekend(d)) workdays.push(d);
  for (const tc of ts) {
    if (tc.department !== last) { last = tc.department; rows.push(h("div", {class:"tl-row tl-grp"}, h("div", {class:"tl-lab"}, h("b", null, tc.department || "No department")), h("div", {class:"tl-track"}))); }
    const mine = O.asg.filter(a => a.tech_id === tc.id && a.work_date >= r.start && a.work_date <= r.end).sort((a, b) => a.work_date.localeCompare(b.work_date));
    // merge runs of workdays on the same job (weekends don't break a run)
    const segs = [];
    for (const a of mine) {
      const key = a.kind === "job" ? a.project_id : a.kind, prev = segs[segs.length - 1];
      let gap = prev ? addDays(prev.b, 1) : null; while (gap && gap < a.work_date && isWeekend(gap)) gap = addDays(gap, 1);
      if (prev && prev.key === key && gap === a.work_date) prev.b = a.work_date; else segs.push({key, kind:a.kind, a:a.work_date, b:a.work_date, note:a.note});
    }
    const booked = mine.filter(a => a.kind === "job").length, avail = workdays.length - mine.filter(a => a.kind !== "job").length;
    rows.push(h("div", {class:"tl-row" + (tc.profile_id === S.me.id ? " me" : "")},
      h("div", {class:"tl-lab"}, h("span", {class:"tl-caret"}), h("div", {class:"tl-name"}, h("b", null, tc.name), h("small", null, (tc.trade || "") + " · " + (avail ? Math.round(booked / avail * 100) : 0) + "% booked"))),
      h("div", {class:"tl-track", onclick: editable ? e => { if (e.target !== e.currentTarget) return; const rect = e.currentTarget.getBoundingClientRect();
          let d = addDays(r.start, Math.floor((e.clientX - rect.left) / rect.width * sc.days)); while (isWeekend(d)) d = addDays(d, 1); openAssign({techId:tc.id, date:d}); } : null,
          title: editable ? "Click an empty spot to assign " + tc.name : null},
        segs.map(sg => { const pj = sg.kind === "job" ? proj(sg.key) : null, n = workdays.filter(d => d >= sg.a && d <= sg.b).length;
          const label = sg.kind === "job" ? (pj && pj.name ? pj.name : "Job") : sg.kind === "pto" ? "Time off" : "Training";
          return h("button", {class:"tl-bar " + (sg.kind === "job" ? pjClass(sg.key) : "off"), style:`left:${sc.x(sg.a)}%;width:${Math.max(.4, sc.w(sg.a, sg.b))}%`,
            title:(pj && pj.number ? pj.number + " · " : "") + label + "\n" + fmtDate(sg.a) + (sg.b !== sg.a ? " – " + fmtDate(sg.b) : "") + " · " + plural(n, "day") + (sg.note ? "\n" + sg.note : ""),
            onclick:() => editable && openAssign({techId:tc.id, date:sg.a, projectId:sg.kind === "job" ? sg.key : null})}, h("span", null, label)); }))));
  }
  return {rows, count:ts.length};
}

// month calendar: project bars across the days they run, plus milestones, tasks due and issue next steps
function tlCalendar() {
  const t = O.tl, m0 = t.cal || monthStart(TODAY);
  const first = mondayOf(m0), lastDay = addDays(addMonths(m0, 1), -1), last = addDays(mondayOf(lastDay), 6);
  const inF = p => p.phase !== "closed" && (!t.dept || p.department === t.dept) && (!t.pm || p.pm_id === t.pm);
  const projs = tlJobs().map(p => byId(O.projects, p.id) || p).filter(inF).map(p => ({p, sp:tlSpanOf(p)})).filter(x => x.sp && x.sp.b >= first && x.sp.a <= last)
    .sort((a, b) => a.sp.a.localeCompare(b.sp.a) || dayDiff(b.sp.a, b.sp.b) - dayDiff(a.sp.a, a.sp.b));
  const pid = new Set(tlJobs().filter(inF).map(p => p.id));
  const ev = new Map(), add = (d, x) => { if (d < first || d > last) return; if (!ev.has(d)) ev.set(d, []); ev.get(d).push(x); };
  if (t.show.ms) for (const m of O.ms) if (pid.has(m.project_id) && (m.actual || m.planned)) add(m.actual || m.planned, {kind:"ms", cls: m.actual ? "done" : m.planned < TODAY ? "late" : "",
    text:m.name, sub:proj(m.project_id).name, open:() => openProject(m.project_id)});
  if (t.show.tasks) for (const i of O.items) if (pid.has(i.project_id) && i.due_date && i.status !== "done") { const p = byId(O.projects, i.project_id);
    add(i.due_date, {kind:"task", cls: isLate(i) ? "late" : "", text:i.title, sub:(i.assignee_id ? personName(i.assignee_id) + " · " : "") + (p ? p.name : ""), open:() => p && openPlanItem(p, i)}); }
  if (t.show.issues) for (const i of O.issues) if (pid.has(i.project_id) && issOpen(i) && i.next_step_due) { const p = byId(O.projects, i.project_id) || proj(i.project_id);
    add(i.next_step_due, {kind:"issue", cls: issLate(i) ? "late" : "", text:i.next_step || i.title, sub:issOwner(i) + " · " + (p.name || ""), open:() => openIssue(p, i)}); }
  const weeks = [];
  for (let w = first; w <= last; w = addDays(w, 7)) {
    const days = [0, 1, 2, 3, 4, 5, 6].map(i => addDays(w, i)), we = days[6];
    const lanes = [], bars = [];
    let hidden = 0;
    for (const x of t.show.bars === false ? [] : projs) {
      if (x.sp.b < w || x.sp.a > we) continue;
      const a = x.sp.a < w ? w : x.sp.a, b = x.sp.b > we ? we : x.sp.b;
      let lane = lanes.findIndex(end => end < a); if (lane < 0) { if (lanes.length >= 8) { hidden++; continue; } lane = lanes.length; lanes.push(b); } else lanes[lane] = b;
      bars.push({x, a, b, lane, cutL:x.sp.a < w, cutR:x.sp.b > we});
    }
    const evRow = lanes.length + 2 + (hidden ? 1 : 0);
    weeks.push(h("div", {class:"cal-week", style:`grid-template-rows:26px repeat(${lanes.length}, 24px)${hidden ? " 18px" : ""} auto`},
      hidden ? h("div", {class:"cal-more", style:`grid-column:1 / -1;grid-row:${lanes.length + 2}`}, "+" + plural(hidden, "more project") + " this week · filter by department or PM, or use the Projects view") : null,
      days.map((d, i) => h("div", {class:"cal-day" + (d.slice(0, 7) !== m0.slice(0, 7) ? " other" : "") + (d === TODAY ? " today" : "") + (i >= 5 ? " wkend" : ""), style:`grid-column:${i + 1};grid-row:1 / -1`})),
      days.map((d, i) => h("div", {class:"cal-num" + (d === TODAY ? " today" : ""), style:`grid-column:${i + 1};grid-row:1`}, d.slice(8) === "01" ? new Date(d + "T12:00:00").toLocaleDateString("en-US", {month:"short", day:"numeric"}) : String(Number(d.slice(8))))),
      bars.map(bb => { const p = bb.x.p, full = !!byId(O.projects, p.id), pctDone = Math.max(0, Math.min(100, Number(p.pct_complete) || 0));
        return h("button", {class:"cal-bar " + pjClass(p.id) + (bb.cutL ? " cutl" : "") + (bb.cutR ? " cutr" : "") + (bb.x.sp.b < TODAY && p.phase !== "closeout" ? " late" : ""),
          style:`grid-column:${dayDiff(w, bb.a) + 1} / ${dayDiff(w, bb.b) + 2};grid-row:${bb.lane + 2}`,
          title:`${p.number} · ${p.name}\n${fmtDate(bb.x.sp.a)} – ${fmtDate(bb.x.sp.b)} · ${pctDone}% complete · PM ${personName(p.pm_id)}`, onclick:() => full && openProject(p.id)},
          h("span", null, p.name)); }),
      days.map((d, i) => { const list = (ev.get(d) || []); return list.length ? h("ul", {class:"cal-ev", style:`grid-column:${i + 1};grid-row:${evRow}`},
        list.slice(0, 6).map(e => h("li", null, h("button", {class:"cal-e " + e.kind + (e.cls ? " " + e.cls : ""), title:e.text + "\n" + e.sub, onclick:e.open},
          h("i", {"aria-hidden":"true"}), h("span", null, e.text)))),
        list.length > 6 ? h("li", {class:"muted small"}, "+" + (list.length - 6) + " more") : null) : null; })));
  }
  return {grid:h("div", {class:"cal"}, h("div", {class:"cal-head"}, ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((n, i) => h("div", {class:i >= 5 ? "wkend" : ""}, n))), weeks), count:projs.length + [...ev.values()].reduce((n, l) => n + l.length, 0)};
}
const planStLabel = st => (PLAN_ST.find(x => x[0] === st) || PLAN_ST[0])[1];
function viewTimeline() {
  const t = O.tl, wrap = h("div", {class:"o-stack tl-full"}), cal = t.mode === "calendar";
  const r = tlRange(), sc = tlScale(r);
  const shift = dir => { t.start = t.mode === "projects" ? addMonths(r.start, dir * Math.max(1, Math.round(r.span / 3))) : addDays(r.start, dir * 7 * Math.max(1, Math.round(r.span / 4))); render(); };
  const pms = [...new Set(tlJobs().map(p => p.pm_id).filter(Boolean))];
  wrap.append(h("div", {class:"toolbar"}, h("h2", null, "Timeline"),
    h("div", {class:"sections mp-modes", role:"group", "aria-label":"Show"}, [["projects", "Projects"], ["people", "People"], ["calendar", "Calendar"]].map(([m, l]) =>
      h("button", {"aria-pressed":String(t.mode === m), onclick:() => { t.mode = m; t.start = null; t.cal = null; t.span = m === "people" ? 8 : 6; tlSave(); render(); }}, l))),
    cal ? null : h("select", {class:"inp", style:"max-width:140px", "aria-label":"How long", onchange: e => { t.span = Number(e.target.value); tlSave(); render(); }},
      TL_SPANS[t.mode].map(([v, l]) => h("option", {value:v, selected:r.span === v}, l))),
    h("div", {class:"mp-nav"}, h("button", {class:"btn small", "aria-label":"Earlier", onclick:() => cal ? (t.cal = addMonths(t.cal || monthStart(TODAY), -1), render()) : shift(-1)}, "‹"),
      h("button", {class:"btn small", onclick:() => { t.start = null; t.cal = null; render(); }}, "Today"),
      h("button", {class:"btn small", "aria-label":"Later", onclick:() => cal ? (t.cal = addMonths(t.cal || monthStart(TODAY), 1), render()) : shift(1)}, "›"),
      h("b", {class:"mp-label"}, cal ? new Date((t.cal || monthStart(TODAY)) + "T12:00:00").toLocaleDateString("en-US", {month:"long", year:"numeric"}) : fmtDate(r.start) + " – " + fmtDate(r.end))),
    deptKeys().length > 1 ? h("select", {class:"inp", style:"max-width:170px", "aria-label":"Department", onchange: e => { t.dept = e.target.value; render(); }},
      h("option", {value:""}, "All departments"), deptKeys().map(k => h("option", {value:k, selected:t.dept === k}, k))) : null,
    t.mode !== "people" && pms.length > 1 && role() !== "pm" ? h("select", {class:"inp", style:"max-width:170px", "aria-label":"Project manager", onchange: e => { t.pm = e.target.value; render(); }},
      h("option", {value:""}, "All PMs"), pms.map(id => h("option", {value:id, selected:t.pm === id}, personName(id)))) : null,
    t.mode === "projects" ? h("select", {class:"inp", style:"max-width:190px", "aria-label":"Group by", onchange: e => { t.group = e.target.value; tlSave(); render(); }},
      [["dept", "Group by department"], ["pm", "Group by PM"], ["customer", "Group by customer"], ["none", "No grouping"]].map(([v, l]) => h("option", {value:v, selected:t.group === v}, l))) : null,
    cal ? h("div", {class:"cal-show", role:"group", "aria-label":"Show on the calendar"}, [["bars", "Projects"], ["ms", "Milestones"], ["tasks", "Tasks due"], ["issues", "Issue next steps"]].map(([k, l]) =>
      h("label", null, h("input", {type:"checkbox", checked:t.show[k] !== false, onchange: e => { t.show = {...t.show, [k]:e.target.checked}; tlSave(); render(); }}), " " + l))) : null));
  if (cal) {
    const c = tlCalendar();
    wrap.append(c.grid, h("div", {class:"o-keys"}, h("span", null, h("i", {class:"sw acc"}), "Project running (click to open)"), h("span", null, h("b", {class:"cal-k ms"}), "Milestone"),
      h("span", null, h("b", {class:"cal-k task"}), "Task due"), h("span", null, h("b", {class:"cal-k issue"}), "Issue next step due"), h("span", {class:"bad-t"}, "Red = late")));
    return wrap;
  }
  const body = t.mode === "projects" ? tlProjects(r, sc) : tlPeople(r, sc);
  const innerW = Math.round(sc.days * r.ppd);
  if (!body.count) wrap.append(h("div", {class:"panel"}, emptyState(t.mode === "projects" ? "No projects in this window" : "No field techs yet",
    t.mode === "projects" ? "Projects show here once they have start and end dates (or plan dates)." : "Add techs on the Manpower tab, then schedule them to jobs.")));
  else wrap.append(h("div", {class:"tl-wrap"}, h("div", {class:"tl", style:`--tl-w:${innerW}px`}, tlHeader(r, sc), h("div", {class:"tl-body"}, tlGrid(r, sc), body.rows))));
  if (t.mode === "projects") {
    wrap.append(h("div", {class:"o-keys"}, h("span", null, h("i", {class:"sw acc"}), "Planned start to finish (darker part = % complete)"), h("span", null, h("span", {class:"tl-ms"}), "Milestone"),
      h("span", null, h("span", {class:"tl-ms done"}), "Milestone done"), h("span", null, h("span", {class:"tl-ms late"}), "Milestone late"), h("span", null, h("i", {class:"tl-today key"}), "Today"),
      h("span", {class:"muted"}, "▸ shows plan phases · click a bar to open the project")));
    if (body.undated.length) wrap.append(h("p", {class:"muted small"}, "Not shown (no dates yet): " + body.undated.map(p => p.number + " " + p.name).join(", ")));
  } else wrap.append(h("p", {class:"muted small"}, "Each bar is a run of workdays on one job. Click a bar to change it" + (["admin", "lead", "pm"].includes(role()) ? ", or an empty spot to assign someone." : ".")));
  return wrap;
}

// ---------------------------------------------------------------- weekly PM updates
const UPDATE_DUE = {dow:5, hour:12};
const worstOf = u => ["off_track", "at_risk"].find(s => [u.schedule_status, u.cost_status, u.safety_status].includes(s)) || "on_track";   // Friday at noon, local time
const STATUS = [["on_track", "On track", "go"], ["at_risk", "At risk", "warn"], ["off_track", "Off track", "bad"]];
const stChip = (s, label) => { const x = STATUS.find(y => y[0] === s) || STATUS[0]; return chip(x[2], (label ? label + ": " : "") + x[1]); };
const reportWeek = () => mondayOf(TODAY);
const dueAt = wk => { const [y, m, d] = addDays(wk, UPDATE_DUE.dow - 1).split("-").map(Number); return new Date(y, m - 1, d, UPDATE_DUE.hour); };
const dueLabel = wk => "Due " + dueAt(wk).toLocaleDateString("en-US", {weekday:"short", month:"short", day:"numeric"}) + " at " + dueAt(wk).toLocaleTimeString("en-US", {hour:"numeric", minute:"2-digit"});
const needsUpdate = p => ["mobilizing", "in_progress", "closeout"].includes(p.phase);
const updateFor = (projectId, wk) => O.wu.find(u => u.project_id === projectId && u.week_start === wk);
function updateState(p, wk) {
  wk = wk || reportWeek();
  const u = updateFor(p.id, wk);
  if (u) return {u, cls:"go", text:"Submitted " + new Date(u.submitted_at).toLocaleDateString("en-US", {weekday:"short", month:"short", day:"numeric"})};
  if (!needsUpdate(p)) return {cls:"", text:"Not needed"};
  if (new Date() > dueAt(wk)) return {cls:"bad", text:"Missing", missing:true};
  return {cls:"warn", text:dueLabel(wk).replace("Due ", "Due ")};
}
function updatePanel(p, c, edit) {
  const wk = reportWeek(), st = updateState(p, wk);
  const hist = O.wu.filter(u => u.project_id === p.id).sort((a, b) => b.week_start.localeCompare(a.week_start));
  const latest = hist[0];
  const body = latest ? updateCard(latest, true) : h("div", {class:"empty"}, "No weekly updates yet.");
  return panel("Weekly update", "Week of " + fmtDate(wk) + " · " + st.text,
    h("div", {class:"o-pad"},
      !st.u && needsUpdate(p) ? h("div", {class:"o-due " + st.cls}, h("b", null, st.missing ? "This week's update is missing" : "This week's update isn't in yet"),
        h("span", null, dueLabel(wk) + (edit ? "" : " · " + personName(p.pm_id) + " writes it")),
        edit ? h("button", {class:"btn primary small", onclick:() => openUpdate(p, wk)}, "Write this week's update") : null) : null,
      body,
      st.u && edit ? h("div", {class:"o-actions", style:"border:0;padding:8px 0 0"}, h("button", {class:"btn small", onclick:() => openUpdate(p, wk)}, "Edit this week's update")) : null,
      hist.length > 1 ? h("details", {class:"o-hist"}, h("summary", null, "Earlier updates (" + (hist.length - 1) + ")"), hist.slice(1).map(u => updateCard(u, false))) : null));
}
function updateCard(u, top) {
  const field = (label, text) => text ? h("div", {class:"wu-f"}, h("div", {class:"k"}, label), h("p", null, text)) : null;
  return h("div", {class:"wu-card" + (top ? " top" : "")},
    h("div", {class:"wu-h"}, h("b", null, "Week of " + fmtDate(u.week_start)), h("span", {class:"chips"}, stChip(u.schedule_status, "Schedule"), stChip(u.cost_status, "Cost"), stChip(u.safety_status, "Safety")),
      h("span", {class:"muted small"}, (u.pct_complete != null ? Number(u.pct_complete).toFixed(0) + "% complete · " : "") + personName(u.author_id) + " · " + new Date(u.submitted_at).toLocaleDateString("en-US", {month:"short", day:"numeric"}))),
    field("Done this week", u.accomplished), field("Plan for next week", u.next_week),
    u.needs ? h("div", {class:"wu-f needs"}, h("div", {class:"k"}, "Needs and decisions"), h("p", null, u.needs)) : null,
    field("Customer", u.customer_notes));
}
function openUpdate(p, wk) {
  const cur = updateFor(p.id, wk), c = calc(p);
  const prev = O.wu.filter(u => u.project_id === p.id && u.week_start < wk).sort((a, b) => b.week_start.localeCompare(a.week_start))[0];
  const logs = O.logs.filter(l => l.project_id === p.id && l.log_date >= wk && l.log_date <= addDays(wk, 6)).sort((a, b) => a.log_date.localeCompare(b.log_date));
  const hrs = sum(O.labor.filter(l => l.project_id === p.id && l.week_start === wk), l => l.hours);
  const d = cur ? {...cur, pct_complete:Number(cur.pct_complete)} : {pct_complete:Number(p.pct_complete), schedule_status: c.lateDays ? "at_risk" : "on_track",
    cost_status: c.fcM < c.estM - .05 ? "off_track" : c.fcM < c.estM - .02 ? "at_risk" : "on_track", safety_status:"on_track",
    accomplished: logs.map(l => fmtDate(l.log_date) + ": " + l.work).join("\n"), next_week:"", needs:"", customer_notes:""};
  if (d.share_with_customer == null) d.share_with_customer = true;
  const shareOn = featureOn("clinks");
  const shareBox = shareOn ? h("label", {class:"field full check-row"}, h("input", {type:"checkbox", checked:d.share_with_customer !== false, onchange: e => { d.share_with_customer = e.target.checked; }}),
    " Show \"Done this week\" and \"Plan for next week\" on the customer's status page", h("small", {class:"muted"}, " (needs, decisions and customer notes are never shown)")) : null;
  const facts = h("div", {class:"wu-facts"},
    h("div", null, h("span", {class:"k"}, "Last week's plan"), h("p", null, prev && prev.next_week || "—")),
    h("div", null, h("span", {class:"k"}, "This week"), h("p", null, [hrs ? num(hrs) + " labor hours" : "Hours not entered yet", plural(logs.length, "daily log"),
      c.lateDays ? c.late[0].name + " " + c.lateDays + " days late" : null, c.coPend ? compact(c.coPend) + " in change orders pending" : null, c.backordered.length ? plural(c.backordered.length, "backorder") : null].filter(Boolean).join(" · "))),
    weekInstalls(p, wk),
    featureOn("issues") && issuesOf(p.id).some(issOpen) ? h("div", null, h("span", {class:"k"}, "Open issues"), h("ul", {class:"wu-iss"}, issuesOf(p.id).filter(issOpen).sort(issSort).map(i =>
      h("li", {class: issLate(i) ? "bad-t" : ""}, i.title + " — " + issOwner(i) + (i.next_step ? ": " + i.next_step : "") + (i.next_step_due ? " (by " + fmtDate(i.next_step_due) + ")" : ""))))) : null,
    h("div", null, h("span", {class:"k"}, "Forecast"), h("p", null, "Margin " + pct(c.fcM) + " vs " + pct(c.estM) + " budget · labor " + pct(c.burn) + " used at " + pct(c.done) + " complete")));
  const sel = (key, label) => fld(d, key, label, "select", {options:STATUS.map(s => [s[0], s[1]]), blank:false});
  const body = h("div", null, facts, h("div", {class:"form"},
    suggestBox(p, d),
    fld(d, "pct_complete", "Percent complete (0–100)", "number"), h("div"),
    sel("schedule_status", "Schedule"), sel("cost_status", "Cost"), sel("safety_status", "Safety"), h("div"),
    fld(d, "accomplished", "Done this week", "textarea", {full:true}),
    fld(d, "next_week", "Plan for next week", "textarea", {full:true}),
    fld(d, "needs", "Needs and decisions (crew, material, customer, from leadership)", "textarea", {full:true}),
    fld(d, "customer_notes", "Customer (relationship, requests, possible new work)", "textarea", {full:true}), shareBox),
    h("p", {class:"muted small"}, "Submitting also updates the project's percent complete, which drives earned revenue and the margin forecast."));
  openDrawer({title:"Weekly update · " + p.number + " · week of " + fmtDate(wk), body, foot:[
    h("button", {class:"btn spacer", onclick:() => closeDrawer()}, "Cancel"),
    h("button", {class:"btn primary", onclick: async e => {
      const v = Number(d.pct_complete);
      if (!(v >= 0 && v <= 100)) { toast("Percent complete must be between 0 and 100."); return; }
      if (!(d.accomplished || "").trim()) { toast("Say what got done this week."); return; }
      const btn = e.currentTarget; btn.disabled = true;
      const row = {project_id:p.id, week_start:wk, author_id:S.me.id, pct_complete:v, schedule_status:d.schedule_status, cost_status:d.cost_status, safety_status:d.safety_status,
        accomplished:d.accomplished.trim(), next_week:nullify((d.next_week || "").trim()), needs:nullify((d.needs || "").trim()), customer_notes:nullify((d.customer_notes || "").trim()),
        submitted_at:new Date().toISOString(), updated_at:new Date().toISOString()};
      if (shareOn) row.share_with_customer = d.share_with_customer !== false;
      let ok = !!(await run(sb.from("weekly_updates").upsert(row, {onConflict:"project_id,week_start"})));
      if (ok && v !== Number(p.pct_complete)) ok = !!(await run(sb.from("projects").update({pct_complete:v}).eq("id", p.id)));
      btn.disabled = false;
      if (ok) { await Promise.all([reload("wu"), reload("projects")]); render(); closeDrawer(); toast(cur ? "Update saved" : "Weekly update submitted"); }
    }}, cur ? "Save changes" : "Submit update")]});
}
function viewUpdates() {
  const wrap = h("div", {class:"o-stack"});
  const wk = O.wuWeek || reportWeek();
  const rank = p => { const u = updateFor(p.id, wk); return !u ? 0 : {off_track:1, at_risk:2, on_track:3}[worstOf(u)]; };
  const ps = O.projects.filter(p => needsUpdate(p) || updateFor(p.id, wk)).filter(p => !O.dept || p.department === O.dept)
    .sort((a, b) => rank(a) - rank(b) || a.department.localeCompare(b.department) || a.number.localeCompare(b.number));
  const ups = ps.map(p => updateFor(p.id, wk)).filter(Boolean);
  const past = new Date() > dueAt(wk);
  const missing = ps.filter(p => !updateFor(p.id, wk) && needsUpdate(p));
  const worst = u => ["off_track", "at_risk"].find(s => [u.schedule_status, u.cost_status, u.safety_status].includes(s));
  wrap.append(h("div", {class:"toolbar"}, h("h2", null, "Weekly updates"),
    h("div", {class:"mp-nav"}, h("button", {class:"btn small", "aria-label":"Previous week", onclick:() => { O.wuWeek = addDays(wk, -7); render(); }}, "‹"),
      h("button", {class:"btn small", onclick:() => { O.wuWeek = null; render(); }}, "This week"),
      h("button", {class:"btn small", "aria-label":"Next week", onclick:() => { O.wuWeek = addDays(wk, 7); render(); }}, "›"), h("b", {class:"mp-label"}, "Week of " + fmtDate(wk))),
    deptKeys().length > 1 && role() !== "pm" ? h("select", {"aria-label":"Department", id:"wu-dept", onchange: e => { O.dept = e.target.value; render(); }},
      h("option", {value:""}, "All departments"), deptKeys().map(k => h("option", {value:k, selected:O.dept === k}, k))) : null));
  wrap.append(h("div", {class:"o-tiles"},
    tile("Submitted", ups.length + " of " + ps.filter(needsUpdate).length, dueLabel(wk)),
    tile(past ? "Missing" : "Not in yet", String(missing.length), missing.length ? missing.map(p => personName(p.pm_id)).filter((x, i, a) => a.indexOf(x) === i).join(", ") : "Everyone's in", missing.length ? (past ? "bad" : "warn") : ""),
    tile("Off track", String(ups.filter(u => worst(u) === "off_track").length), "Schedule, cost or safety", ups.some(u => worst(u) === "off_track") ? "bad" : ""),
    tile("At risk", String(ups.filter(u => worst(u) === "at_risk").length), "Watch list", ups.some(u => worst(u) === "at_risk") ? "warn" : ""),
    tile("Asks for help", String(ups.filter(u => (u.needs || "").trim()).length), "Needs and decisions to clear")));
  if (!ps.length) { wrap.append(h("div", {class:"panel"}, emptyState("No active projects", "Weekly updates are due for every active project."))); return wrap; }
  wrap.append(h("div", {class:"wu-list"}, ps.map(p => { const u = updateFor(p.id, wk);
    return h("section", {class:"o-panel wu-row" + (u ? "" : past ? " missing" : " pending")},
      h("header", null, h("div", null, h("button", {class:"linkish", style:"font-weight:600", onclick:() => openProject(p.id)}, p.number + " · " + p.name),
          h("div", {class:"muted small"}, p.department + " · PM " + personName(p.pm_id) + (u && u.pct_complete != null ? " · " + Number(u.pct_complete).toFixed(0) + "% complete" : ""))),
        u ? h("span", {class:"chips"}, stChip(u.schedule_status, "Schedule"), stChip(u.cost_status, "Cost"), stChip(u.safety_status, "Safety"))
          : h("span", {class:"chips"}, chip(past ? "bad" : "warn", past ? "Missing" : "Not in yet"), canEdit(p) ? h("button", {class:"btn primary small", onclick:() => openUpdate(p, wk)}, "Write it") : null)),
      u ? h("div", {class:"o-pad wu-cols"},
        h("div", null, h("div", {class:"k"}, "Done this week"), h("p", null, u.accomplished || "—")),
        h("div", null, h("div", {class:"k"}, "Next week"), h("p", null, u.next_week || "—")),
        h("div", {class: u.needs ? "needs" : ""}, h("div", {class:"k"}, "Needs"), h("p", null, u.needs || "Nothing")),
        u.customer_notes ? h("div", null, h("div", {class:"k"}, "Customer"), h("p", null, u.customer_notes)) : null) : null); })));
  return wrap;
}

// ---------------------------------------------------------------- documents
const FOLDERS = [["contract", "Contract and PO", true], ["scope", "Scope and estimate", true], ["submittals", "Submittals"], ["drawings", "Drawings"],
  ["change_orders", "Change orders"], ["pay_apps", "Pay apps", true], ["field", "Field photos and daily reports"], ["tests", "Test results"], ["closeout", "Closeout"], ["safety", "Safety"]];
const folderName = k => (FOLDERS.find(f => f[0] === k) || [k, k])[1];
const canReadFolder = (p, k) => { const f = FOLDERS.find(x => x[0] === k); return !(f && f[2]) || (role() && role() !== "field"); };
const canUploadTo = (p, k) => canEdit(p) || (role() === "field" && ["field", "tests", "safety"].includes(k));
const BUCKET = "project-files";
const urlCache = new Map();
const fmtSize = b => !b ? "" : b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB";
const isImg = d => /^image\//.test(d.mime_type || "");
const fileIcon = d => isImg(d) ? "IMG" : /pdf/.test(d.mime_type || "") ? "PDF" : /sheet|excel|csv/.test(d.mime_type || "") ? "XLS" : /word|document/.test(d.mime_type || "") ? "DOC" : /dwg|dxf|vnd\.(ms-visio|autocad)/i.test(d.mime_type + d.name) ? "CAD" : "FILE";
async function signedUrls(paths) {
  const now = Date.now(), need = paths.filter(x => !urlCache.has(x) || urlCache.get(x).exp < now + 60000);
  if (need.length) {
    const {data} = await sb.storage.from(BUCKET).createSignedUrls(need, 3600);
    for (const r of data || []) if (r.signedUrl) urlCache.set(r.path, {url:r.signedUrl, exp:now + 3600000});
  }
  return paths.map(x => (urlCache.get(x) || {}).url);
}
// Files live in the project's SharePoint folder (shared with the deal it came from). Uploads go there;
// files added in SharePoint or Teams show up here. Older files in the storage bucket still work.
const spKeyOf = p => "project:" + p.id;
function docsPanel(p) {
  const folders = FOLDERS.filter(f => canReadFolder(p, f[0]));
  const key = spKeyOf(p), sp = spState ? spState(key) : null;
  if (spLoad && (!sp || (!sp.loading && Date.now() - sp.at > 60000))) spLoad(key, {project_id:p.id}).then(() => { if (O.detail === p.id) render(); });
  const spOn = !!(sp && sp.data && sp.data.connected !== false && sp.data.folders);
  const spItems = new Map();
  if (spOn) for (const f of sp.data.folders) for (const x of f.files) if (!x.folder) spItems.set(x.id, {...x, fkey:f.key});
  const known = new Set(O.docs.filter(d => d.sp_item_id).map(d => d.sp_item_id));
  let docs = O.docs.filter(d => d.project_id === p.id && folders.some(f => f[0] === d.folder))
    .filter(d => !d.sp_item_id || !spOn || spItems.has(d.sp_item_id))          // deleted in SharePoint → gone here too
    .map(d => d.sp_item_id ? {...d, _sp: spItems.get(d.sp_item_id) || {url:d.sp_url}} : d);
  if (spOn) docs = docs.concat([...spItems.values()].filter(x => !known.has(x.id) && folders.some(f => f[0] === x.fkey)).map(x => ({
    id:"sp-" + x.id, project_id:p.id, folder:x.fkey, name:x.name, path:"sp:" + x.id, sp_item_id:x.id, size_bytes:x.size, mime_type:x.mime,
    created_at:x.created || x.modified || "", uploaded_by:null, _by:x.by, _sp:x, _spOnly:true})));
  docs.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  const cur = O.docFolder && folders.some(f => f[0] === O.docFolder) ? O.docFolder : "";
  const shown = docs.filter(d => !cur || d.folder === cur);
  const box = h("div");
  const tabs = h("div", {class:"doc-tabs", role:"tablist"}, h("button", {role:"tab", "aria-selected":String(!cur), onclick:() => { O.docFolder = ""; render(); }}, "All ", h("small", null, String(docs.length))),
    folders.map(f => { const n = docs.filter(d => d.folder === f[0]).length;
      return h("button", {role:"tab", "aria-selected":String(cur === f[0]), class: n ? "" : "empty", onclick:() => { O.docFolder = f[0]; render(); }}, f[1], " ", h("small", null, String(n))); }));
  const imgs = shown.filter(isImg).slice(0, 12), files = shown.filter(d => !isImg(d) || shown.filter(isImg).indexOf(d) >= 12);
  const who = d => d._spOnly ? (d._by || "SharePoint") : personName(d.uploaded_by);
  const when = d => d.created_at ? fmtDate(d.created_at.slice(0, 10)) : "";
  const view = d => e => { if (!core.previewFile || e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); core.previewFile({project_id:p.id}, {id:d.sp_item_id, name:d.name, url:d._sp.url}); };
  const link = d => { if (d._sp) return h("a", {href:d._sp.url || "#", target:"_blank", rel:"noopener", class:"doc-name", onclick:view(d)}, d.name);
    const a = h("a", {href:"#", target:"_blank", rel:"noopener", "data-path":d.path, class:"doc-name", onclick: async ev => {
    if (a.getAttribute("href") === "#") { ev.preventDefault(); const [u] = await signedUrls([d.path]); if (u) { a.href = u; window.open(u, "_blank", "noopener"); } else toast("Couldn't open that file."); } }}, d.name); return a; };
  const thumbs = imgs.length ? h("div", {class:"doc-thumbs"}, imgs.map(d => h("figure", null,
    d._sp ? h("a", {href:d._sp.url || "#", target:"_blank", rel:"noopener", class:"thumb", onclick:view(d)}, d._sp.thumb ? h("img", {alt:d.name, src:d._sp.thumb, loading:"lazy"}) : null)
      : h("a", {href:"#", target:"_blank", rel:"noopener", "data-path":d.path, class:"thumb"}, h("img", {alt:d.name, "data-path":d.path, loading:"lazy"})),
    h("figcaption", null, d.note || d.name, h("small", null, who(d) + " · " + when(d)))))) : null;
  const canDel = d => d._spOnly ? canEdit(p) : (d.uploaded_by === S.me.id || canEdit(p));
  const list = files.length ? h("ul", {class:"doc-list"}, files.map(d => h("li", null, h("span", {class:"doc-ic " + fileIcon(d).toLowerCase()}, fileIcon(d)),
    h("div", {class:"doc-main"}, link(d), h("small", null, [!cur ? folderName(d.folder) : null, fmtSize(d.size_bytes), who(d), when(d), d.note].filter(Boolean).join(" · "))),
    canDel(d) ? h("button", {class:"btn small", "aria-label":"Delete " + d.name, onclick: async e => {
      const b = e.currentTarget; if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Click again to delete"; setTimeout(() => { b.dataset.armed = ""; b.textContent = "Delete"; }, 3000); return; }
      if (d.sp_item_id) {
        b.disabled = true; const r = await spDelete({project_id:p.id}, d.sp_item_id);
        if (r.error) { b.disabled = false; toast(r.error); return; }
        toast("Moved to the SharePoint recycle bin"); await Promise.all([reload("docs"), spLoad(key, {project_id:p.id}, true)]); render(); return;
      }
      const {error} = await sb.storage.from(BUCKET).remove([d.path]);
      if (error && !/not found/i.test(error.message || "")) { toast(friendly(error)); return; }
      if (await run(sb.from("documents").delete().eq("id", d.id), "Deleted")) { await reload("docs"); render(); }
    }}, "Delete") : null))) : null;
  const note = sp && !sp.data && sp.error ? h("p", {class:"bad-t small", style:"margin:0 0 10px"}, "SharePoint: " + sp.error + " ",
      h("button", {class:"btn small", onclick:() => spLoad(key, {project_id:p.id}, true).then(render)}, "Try again"))
    : sp && sp.data && sp.error ? h("p", {class:"muted small", style:"margin:0 0 10px"}, "Couldn't refresh from SharePoint just now.")
    : !sp || (!sp.data && sp.loading) ? h("p", {class:"muted small", style:"margin:0 0 10px"}, "Checking SharePoint for files…") : null;
  box.append(note || "", tabs, thumbs || list ? h("div", null, thumbs, list) : h("div", {class:"empty"}, cur ? "Nothing in " + folderName(cur) + " yet." : "No documents yet."));
  // fill thumbnail and link addresses of older (storage bucket) files once the page is on screen
  setTimeout(async () => { const els = [...box.querySelectorAll("[data-path]")]; if (!els.length) return;
    const paths = [...new Set(els.map(e => e.dataset.path))]; const urls = await signedUrls(paths); const m = new Map(paths.map((x, i) => [x, urls[i]]));
    for (const el of els) { const u = m.get(el.dataset.path); if (!u) continue; if (el.tagName === "IMG") el.src = u; else el.href = u; } }, 0);
  const canUp = folders.some(f => canUploadTo(p, f[0]));
  const spUrl = (sp && sp.data && sp.data.url) || p.sharepoint_url;
  return panel("Documents", plural(docs.length, "file") + (spOn ? " · synced with SharePoint" : canUp ? " · photos are resized for the phone" : ""), h("div", {class:"o-pad"}, box),
    canUp || spUrl ? h("div", {class:"o-actions"},
      spUrl ? h("a", {class:"btn small", href:spUrl, target:"_blank", rel:"noopener"}, "Open in SharePoint") : null,
      spOn ? h("button", {class:"btn small", onclick:() => spLoad(key, {project_id:p.id}, true).then(render)}, "Refresh") : null,
      canUp ? h("button", {class:"btn primary small", onclick:() => openUpload(p, cur)}, "Upload files") : null) : null);
}
// one file into a project folder: SharePoint when it's connected, the storage bucket otherwise
async function storeFile(p, folder, f, note, closeoutId) {
  const r = spUpload ? await spUpload({project_id:p.id}, folder, f, {note:nullify(note), closeout_item_id:nullify(closeoutId)}) : {connected:false};
  if (r.connected !== false) return r.error ? {error:r.error} : {ok:true, sp:true};
  const safe = f.name.replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, " ").slice(-120);
  const path = p.id + "/" + folder + "/" + Date.now() + "-" + Math.random().toString(36).slice(2, 6) + "-" + safe;
  const {error} = await sb.storage.from(BUCKET).upload(path, f, {contentType:f.type || "application/octet-stream", upsert:false});
  if (error) return {error:friendly(error)};
  const {error:e2} = await sb.from("documents").insert({project_id:p.id, folder, name:f.name, path, size_bytes:f.size, mime_type:f.type || null, note:nullify(note), closeout_item_id:nullify(closeoutId), uploaded_by:S.me.id});
  if (e2) { await sb.storage.from(BUCKET).remove([path]); return {error:friendly(e2)}; }
  return {ok:true};
}
async function uploadOne(p, folder, file0, note) {
  const f = await shrinkImage(file0);
  const r = await storeFile(p, folder, f, note);
  if (r.error) { toast("Photo didn't upload: " + r.error); return false; }
  if (r.sp && spLoad) spLoad(spKeyOf(p), {project_id:p.id}, true);
  return true;
}
async function shrinkImage(file) {
  if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(file.type) || file.size < 900000) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const cv = document.createElement("canvas"); cv.width = Math.round(bmp.width * scale); cv.height = Math.round(bmp.height * scale);
    cv.getContext("2d").drawImage(bmp, 0, 0, cv.width, cv.height);
    const blob = await new Promise(r => cv.toBlob(r, "image/jpeg", .82));
    return blob && blob.size < file.size ? new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", {type:"image/jpeg"}) : file;
  } catch (e) { return file; }
}
function openUpload(p, folder) {
  const allowed = FOLDERS.filter(f => canReadFolder(p, f[0]) && canUploadTo(p, f[0]));
  const d = {folder: allowed.some(f => f[0] === folder) ? folder : (role() === "field" ? "field" : allowed[0][0]), note:"", closeout_item_id:null};
  const input = h("input", {type:"file", id:"f-files", multiple:true, class:"inp"});
  const items = O.closeout.filter(x => x.project_id === p.id && x.status !== "done").map(x => [x.id, x.item]);
  const coBox = h("div", {style:"display:contents"});
  const drawCo = () => coBox.replaceChildren(...(["closeout", "tests"].includes(d.folder) && items.length && canEdit(p) ? [fld(d, "closeout_item_id", "Completes a closeout item (optional)", "select", {options:items, blank:"No", full:true})] : []));
  drawCo();
  const status = h("p", {class:"muted small", style:"grid-column:1/-1;margin:0"}, "Files go into the project's SharePoint folder. Up to 50 MB per file; photos over 1 MB are resized to 1600 px. For long videos, share a link in the note instead.");
  const body = h("div", {class:"form"},
    fld(d, "folder", "Folder", "select", {options:allowed.map(f => [f[0], f[1]]), blank:false, full:true, onchange:drawCo}),
    h("div", {class:"field full"}, h("label", {for:"f-files"}, "Files"), input),
    fld(d, "note", "Note (optional, e.g. what the photo shows)", "text", {full:true}), coBox, status);
  openDrawer({title:"Upload to " + p.number, body, foot:[h("button", {class:"btn spacer", onclick:() => closeDrawer()}, "Cancel"),
    h("button", {class:"btn primary", onclick: async e => {
      const files = [...input.files]; if (!files.length) { toast("Choose one or more files."); return; }
      const big = files.find(f => f.size > 52428800 && !/^image\//.test(f.type)); if (big) { toast(big.name + " is over 50 MB."); return; }
      const btn = e.currentTarget; btn.disabled = true; let done = 0, failed = [];
      for (const f0 of files) {
        status.textContent = "Uploading " + (done + 1) + " of " + files.length + "…";
        const f = await shrinkImage(f0);
        const r = await storeFile(p, d.folder, f, (d.note || "").trim(), d.closeout_item_id);
        if (r.error) { failed.push(f0.name + " (" + r.error + ")"); continue; }
        done++;
      }
      if (done && d.closeout_item_id) await run(sb.from("closeout_items").update({status:"done", note:"File: " + files[0].name}).eq("id", d.closeout_item_id));
      btn.disabled = false;
      await Promise.all([reload("docs"), reload("closeout"), spLoad ? spLoad(spKeyOf(p), {project_id:p.id}, true) : null]); render();
      if (failed.length) { status.textContent = "Couldn't upload: " + failed.join("; "); toast(done ? "Uploaded " + done + ", " + failed.length + " failed" : "Upload failed"); }
      else { closeDrawer(); toast("Uploaded " + plural(done, "file")); O.docFolder = d.folder; render(); }
    }}, "Upload")]});
}

// ---------------------------------------------------------------- project plan and tasks
const PLAN_ST = [["not_started", "Not started", ""], ["in_progress", "In progress", "acc"], ["blocked", "Blocked", "bad"], ["done", "Done", "go"]];
const planChip = s => { const x = PLAN_ST.find(y => y[0] === s) || PLAN_ST[0]; return chip(x[2], x[1]); };
const opsPeople = () => activePeople().filter(x => x.role === "admin" || x.ops_role).sort((a, b) => (a.full_name || a.email).localeCompare(b.full_name || b.email));
const itemsOf = pid => O.items.filter(i => i.project_id === pid);
const dayDiff = (a, b) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 864e5);
const isLate = i => i.status !== "done" && !!i.due_date && i.due_date < TODAY;
const featureOn = k => !O.off.has(k);
function planTree(pid) {
  const all = itemsOf(pid), ids = new Set(all.map(i => i.id)), kids = new Map();
  for (const i of all) { const k = i.parent_id && ids.has(i.parent_id) ? i.parent_id : ""; if (!kids.has(k)) kids.set(k, []); kids.get(k).push(i); }
  for (const a of kids.values()) a.sort((x, y) => x.sort - y.sort || (x.start_date || "9").localeCompare(y.start_date || "9") || (x.created_at || "").localeCompare(y.created_at || ""));
  const rows = [];
  const walk = (k, depth) => { for (const i of kids.get(k) || []) { rows.push({i, depth}); walk(i.id, depth + 1); } };
  walk("", 0);
  return {rows, kids};
}
const descendants = (id, kids) => { const out = [], st = [...(kids.get(id) || [])]; while (st.length) { const x = st.pop(); out.push(x); st.push(...(kids.get(x.id) || [])); } return out; };
const parentPath = i => { const out = []; let cur = i.parent_id ? byId(O.items, i.parent_id) : null, n = 0; while (cur && n++ < 12) { out.unshift(cur.title); cur = cur.parent_id ? byId(O.items, cur.parent_id) : null; } return out.join(" › "); };
const canTick = (i, p) => (p && canPlan(p)) || i.assignee_id === S.me.id;
async function setItemStatus(i, status) {
  if (await run(sb.from("plan_items").update({status}).eq("id", i.id), status === "done" ? "Marked done" : "Reopened")) { await reload("items"); render(); }
  else render();
}
function planPanel(p, edit) {
  const {rows, kids} = planTree(p.id);
  const items = itemsOf(p.id), done = items.filter(i => i.status === "done").length, late = items.filter(isLate).length;
  const dates = items.flatMap(i => [i.start_date, i.due_date]).concat([p.start_date, p.end_date]).filter(Boolean).sort();
  const t0 = dates[0], t1 = dates[dates.length - 1], span = t0 && t1 ? Math.max(1, dayDiff(t0, t1)) : 0;
  const pos = d => span ? Math.max(0, Math.min(100, dayDiff(t0, d) / span * 100)) : 0;
  const todayPos = span && TODAY >= t0 && TODAY <= t1 ? pos(TODAY) : null;
  const body = rows.length ? h("div", {class:"tbl-wrap flat"}, h("table", {class:"plan-tbl"},
    h("thead", null, h("tr", null, h("th", {class:"plan-ck"}, h("span", {class:"sr"}, "Done")), h("th", null, "Phase / task"), h("th", null, "Assigned to"), h("th", null, "Start"), h("th", null, "Due"),
      h("th", null, "Status"), h("th", {class:"plan-tl"}, t0 ? fmtDate(t0) + " – " + fmtDate(t1) : "Timeline"), edit ? h("th", null, h("span", {class:"sr"}, "Add")) : null)),
    h("tbody", null, rows.map(({i, depth}) => {
      const sub = descendants(i.id, kids), nd = sub.filter(x => x.status === "done").length;
      const s = i.start_date || i.due_date, e = i.due_date || i.start_date;
      return h("tr", {class:"plan-r d" + Math.min(depth, 3) + (i.status === "done" ? " is-done" : "") + (isLate(i) ? " is-late" : "")},
        h("td", {class:"plan-ck"}, canTick(i, p) ? h("input", {type:"checkbox", "aria-label":"Done: " + i.title, checked:i.status === "done", onchange: ev => setItemStatus(i, ev.target.checked ? "done" : "in_progress")}) : null),
        h("td", {class:"plan-t", style:"padding-left:" + (8 + depth * 22) + "px"}, h("button", {class:"linkish", onclick:() => openPlanItem(p, i)}, i.title),
          sub.length ? h("small", {class:"muted"}, " · " + nd + " of " + sub.length + " done") : null),
        h("td", null, i.assignee_id ? personName(i.assignee_id) : h("span", {class:"muted"}, "—")),
        h("td", {class:"mono nowrap"}, i.start_date ? fmtDate(i.start_date) : ""),
        h("td", {class:"mono nowrap" + (isLate(i) ? " bad-t" : "")}, i.due_date ? fmtDate(i.due_date) : ""),
        h("td", null, planChip(i.status)),
        h("td", {class:"plan-tl"}, h("div", {class:"plan-track"}, todayPos != null ? h("i", {class:"plan-today", style:"left:" + todayPos + "%"}) : null,
          s && span ? h("b", {class:"plan-bar st-" + i.status + (depth ? "" : " ph") + (isLate(i) ? " late" : ""), style:"left:" + pos(s) + "%;width:" + Math.max(1.5, pos(e) - pos(s)) + "%"}) : null)),
        edit ? h("td", null, h("button", {class:"btn small", title:"Add a sub-task under " + i.title, onclick:() => openPlanItem(p, null, i.id)}, "+ Sub-task")) : null);
    })))) : h("div", {class:"empty"}, edit ? "No plan yet. Start with the standard phases, or add your own, then put tasks and sub-tasks under each and assign them." : "No plan yet.");
  return panel("Project plan", items.length ? plural(items.length, "item") + " · " + done + " done" + (late ? " · " + late + " overdue" : "") : "Phases, tasks and sub-tasks", body,
    edit ? h("div", {class:"o-actions"}, !items.length ? h("button", {class:"btn small", onclick:() => addStarterPlan(p)}, "Start from the standard phases") : null,
      readBook ? h("button", {class:"btn small", onclick:() => openPlanImport(p)}, "Import from Excel") : null,
      h("button", {class:"btn primary small", onclick:() => openPlanItem(p, null, null)}, "+ Phase or task")) : null);
}
const STARTER = {
  Tower: ["Mobilize and site walk", "Site prep and staging", "Install", "Test and commission", "Closeout"],
  DAS: ["Mobilize and site walk", "Cable and pathway", "Install headend and antennas", "Test, optimize and commission", "Closeout"],
  Network: ["Mobilize and staging", "Configure and stage equipment", "Install and cut over", "Test and acceptance", "Closeout"],
  DataComm: ["Mobilize and site walk", "Rough-in and pathway", "Pull cable", "Terminate and dress", "Test and certify", "Closeout"],
  Security: ["Mobilize and site walk", "Rough-in and pathway", "Install devices", "Program and test", "Train customer and closeout"],
};
async function addStarterPlan(p) {
  const names = STARTER[p.department] || STARTER.DataComm;
  const s = p.start_date || TODAY, e = p.end_date && p.end_date > s ? p.end_date : addDays(s, 30), span = Math.max(names.length, dayDiff(s, e));
  const rows = names.map((title, k) => ({project_id:p.id, title, sort:k + 1, status:"not_started",
    start_date:addDays(s, Math.round(span * k / names.length)), due_date:addDays(s, Math.max(0, Math.round(span * (k + 1) / names.length) - 1))}));
  if (await run(sb.from("plan_items").insert(rows), "Added " + names.length + " phases")) { await reload("items"); render(); }
}
// ---------------------------------------------------------------- project plan import (Excel or CSV)
// One row per item. Columns: Phase | Task | Sub-task | Assigned to | Start | Due | Status | Notes.
// A row's level is its deepest filled name column; phase and task names carry down so they
// don't need repeating. Phases already on the plan with the same name are reused.
const PLAN_COLS = {phase:["phase"], task:["task"], sub:["sub-task","subtask","sub task"], who:["assigned to","assigned","assignee","owner","who"],
  start:["start"], due:["due","finish","end"], status:["status"], notes:["notes","note","comments"]};
function planCols(head) {
  const lh = head.map(x => (x || "").toLowerCase().trim()), used = new Set(), m = {};
  for (const k of ["sub", "phase", "task", "who", "start", "due", "status", "notes"])
    for (const key of PLAN_COLS[k]) { const i = lh.findIndex((x, j) => !used.has(j) && (x === key || x.startsWith(key))); if (i >= 0) { m[k] = i; used.add(i); break; } }
  return m;
}
function planStatus(v) { v = (v || "").toLowerCase();
  if (/done|complete|finished|closed/.test(v)) return "done"; if (/block|hold|stuck|wait/.test(v)) return "blocked";
  if (/progress|started|working|underway|active/.test(v)) return "in_progress"; return "not_started"; }
function parsePlanRows(rows, p) {
  const head = rows[0] || [], m = planCols(head), get = (r, k) => m[k] != null ? (r[m[k]] || "").trim() : "";
  if (m.phase == null && m.task == null) return {error:"Couldn't find a Phase or Task column. Use the RFIP project plan template, or name the columns Phase, Task, Sub-task, Assigned to, Start, Due, Status, Notes."};
  const people = opsPeople(), findWho = v => { const x = v.toLowerCase(); if (!x) return null;
    const hit = people.find(q => (q.email || "").toLowerCase() === x || (q.full_name || "").toLowerCase() === x); return hit ? hit.id : undefined; };
  const nodes = [], unmatched = new Set(); let ph = null, tk = null, bad = 0;
  const node = (level, title, parent) => { const n = {level, title, parent, row:null}; nodes.push(n); return n; };
  const phaseFor = t => nodes.find(n => n.level === 0 && n.title.toLowerCase() === t.toLowerCase()) || node(0, t, null);
  for (const r of rows.slice(1)) {
    const P = get(r, "phase"), T = get(r, "task"), U = get(r, "sub");
    if (!P && !T && !U) { bad++; continue; }
    if (P && (!ph || ph.title.toLowerCase() !== P.toLowerCase())) { ph = phaseFor(P); tk = null; }
    let n;
    if (U) { if (T && (!tk || tk.title.toLowerCase() !== T.toLowerCase())) tk = node(1, T, ph); n = node(tk ? 2 : 1, U, tk || ph); }
    else if (T) { tk = node(1, T, ph); n = tk; }
    else n = ph;
    const w = get(r, "who"), wid = findWho(w); if (wid === undefined) unmatched.add(w);
    const sd = normDate(get(r, "start")), dd = normDate(get(r, "due"));
    n.row = {assignee_id:wid || null, start_date:sd, due_date:dd && sd && dd < sd ? sd : dd, status:planStatus(get(r, "status")), notes:get(r, "notes") || null};
  }
  return {nodes, unmatched:[...unmatched], skipped:bad, cols:m};
}
async function runPlanImport(p, parsed) {
  const have = itemsOf(p.id);
  const sortNext = parentId => Math.max(0, ...have.filter(x => (x.parent_id || null) === parentId).map(x => x.sort), ...parsed.nodes.filter(n => n.id && (n.parent ? n.parent.id : null) === parentId).map(n => n.sort || 0)) + 1;
  let made = 0;
  for (const level of [0, 1, 2]) {
    const batch = [];
    for (const n of parsed.nodes.filter(x => x.level === level)) {
      if (level === 0) { const old = have.find(x => !x.parent_id && x.title.toLowerCase() === n.title.toLowerCase()); if (old) { n.id = old.id; continue; } }
      const parent_id = n.parent ? n.parent.id || null : null;
      n.sort = sortNext(parent_id); n.id = "pending";
      batch.push({n, row:Object.assign({project_id:p.id, title:n.title, parent_id, status:"not_started", sort:n.sort}, n.row || {})});
    }
    for (let i = 0; i < batch.length; i += 200) {
      const part = batch.slice(i, i + 200);
      const {data, error} = await sb.from("plan_items").insert(part.map(x => x.row)).select("id");
      if (error) throw error;
      data.forEach((d, j) => { part[j].n.id = d.id; }); made += data.length;
    }
  }
  const byWho = new Map();
  for (const n of parsed.nodes) if (n.row && n.row.assignee_id && n.row.assignee_id !== S.me.id && n.row.status !== "done")
    byWho.set(n.row.assignee_id, (byWho.get(n.row.assignee_id) || []).concat(n));
  for (const [who, list] of byWho)
    tell([who], plural(list.length, "new task") + " on " + p.number, (S.me.full_name || S.me.email) + " assigned you " + plural(list.length, "task") + " on " + p.number + " " + p.name + ":\n\n" +
      list.map(n => "• " + n.title + (n.row.due_date ? " (due " + fmtDate(n.row.due_date) + ")" : "")).join("\n"), "#project=" + p.id);
  return made;
}
function openPlanImport(p) {
  const st = {parsed:null, busy:false, name:""};
  const body = h("div");
  const draw = () => {
    const kids = [h("p", {class:"muted small", style:"margin:0 0 10px"}, "Upload the RFIP project plan template (or any sheet with Phase, Task, Sub-task, Assigned to, Start, Due, Status and Notes columns). Tasks are added to this plan; phases with the same name as ones already here are reused."),
      h("input", {type:"file", accept:".xlsx,.xls,.csv,text/csv", "aria-label":"Plan spreadsheet", onchange: async e => {
        const f = e.target.files[0]; if (!f) return; st.name = f.name;
        try { const rows = await readBook(f, ["Project plan", "Plan"]); st.parsed = parsePlanRows(rows, p); }
        catch (err) { st.parsed = {error:err.message || "Couldn't read that file."}; }
        draw(); }})];
    const x = st.parsed;
    if (x && x.error) kids.push(h("p", {class:"bad-t", style:"margin-top:10px"}, x.error));
    else if (x) {
      const c = [0, 1, 2].map(l => x.nodes.filter(n => n.level === l).length);
      const reuse = x.nodes.filter(n => n.level === 0 && itemsOf(p.id).some(i => !i.parent_id && i.title.toLowerCase() === n.title.toLowerCase())).length;
      kids.push(h("div", {class:"panel", style:"margin-top:12px"},
        h("b", null, st.name), h("ul", {style:"margin:6px 0 0;padding-left:18px"},
          h("li", null, plural(c[0], "phase") + (reuse ? " (" + reuse + " already on the plan, reused)" : "")),
          h("li", null, plural(c[1], "task") + (c[2] ? " and " + plural(c[2], "sub-task") : "")),
          h("li", null, plural(x.nodes.filter(n => n.row && n.row.assignee_id).length, "item") + " assigned"),
          x.unmatched.length ? h("li", {class:"bad-t"}, "Not matched, left unassigned: " + x.unmatched.join(", ") + ". Names must match someone with an operations role in RFIP (full name or email).") : null,
          x.skipped ? h("li", {class:"muted"}, plural(x.skipped, "blank row") + " skipped") : null)));
    }
    body.replaceChildren(...kids);
  };
  draw();
  openDrawer({title:"Import plan · " + p.number, body, foot:[
    h("button", {class:"btn spacer", onclick:() => closeDrawer()}, "Cancel"),
    h("button", {class:"btn primary", onclick: async e => {
      const x = st.parsed; if (!x || x.error || !x.nodes.length) { toast("Pick a plan spreadsheet first."); return; }
      const btn = e.currentTarget; btn.disabled = true;
      try { const n = await runPlanImport(p, x); toast("Added " + plural(n, "plan item")); closeDrawer(); await reload("items"); render(); }
      catch (err) { toast("Import stopped: " + friendly(err)); await reload("items"); render(); }
      btn.disabled = false; }}, "Import")]});
}
function openPlanItem(p, it, parentId) {
  const edit = canPlan(p), ro = !edit;
  const d = it ? {...it} : {title:"", parent_id:parentId || null, assignee_id:null, start_date:null, due_date:null, status:"not_started", notes:""};
  const tree = planTree(p.id);
  const bad = it ? new Set([it.id, ...descendants(it.id, tree.kids).map(x => x.id)]) : new Set();
  const parents = tree.rows.filter(r => !bad.has(r.i.id)).map(r => [r.i.id, " ".repeat(r.depth) + r.i.title]);
  const crumbs = it && it.parent_id ? parentPath(it) : parentId ? parentPath({parent_id:parentId}) : "";
  const fields = [
    crumbs ? h("p", {class:"muted small", style:"grid-column:1/-1;margin:0"}, "Under: " + crumbs) : null,
    fld(d, "title", "What needs doing", "text", {full:true, readonly:ro, placeholder:"e.g. Pull cable to IDF 2"}),
    fld(d, "parent_id", "Sits under", "select", {options:parents, blank:"Top level (a phase)", full:true, readonly:ro}),
    fld(d, "assignee_id", "Assigned to", "select", {options:opsPeople().map(x => [x.id, x.full_name || x.email]), blank:"Nobody yet", readonly:ro}),
    fld(d, "status", "Status", "select", {options:PLAN_ST.map(x => [x[0], x[1]]), blank:false}),
    fld(d, "start_date", "Start", "date", {readonly:ro}), fld(d, "due_date", "Due", "date", {readonly:ro}),
    fld(d, "notes", "Notes", "textarea", {full:true}),
    ro ? h("p", {class:"muted small", style:"grid-column:1/-1;margin:0"}, "You can update the status and notes. " + personName(p.pm_id) + " (the PM) or someone the project is shared with changes the rest of the plan.") : null].filter(Boolean);
  drawerForm((it ? "" : "New ") + (d.parent_id ? "task" : "phase or task").replace(/^./, m => m.toUpperCase()) + " · " + p.number, d, fields, async () => {
    if (!(d.title || "").trim()) { toast("Give it a name."); return false; }
    if (d.start_date && d.due_date && d.due_date < d.start_date) { toast("The due date is before the start."); return false; }
    const row = ro ? {status:d.status, notes:nullify((d.notes || "").trim())}
      : {project_id:p.id, title:d.title.trim(), parent_id:nullify(d.parent_id), assignee_id:nullify(d.assignee_id), start_date:nullify(d.start_date), due_date:nullify(d.due_date), status:d.status, notes:nullify((d.notes || "").trim())};
    if (!it && !ro) row.sort = Math.max(0, ...itemsOf(p.id).filter(x => (x.parent_id || null) === row.parent_id).map(x => x.sort)) + 1;
    const ok = await saveRow("plan_items", row, it && it.id);
    if (ok && row.assignee_id && row.assignee_id !== S.me.id && (!it || it.assignee_id !== row.assignee_id))
      tell([row.assignee_id], "New task on " + p.number + ": " + row.title, (S.me.full_name || S.me.email) + " assigned you a task on " + p.number + " " + p.name +
        (row.due_date ? ", due " + fmtDate(row.due_date) : "") + ":\n\n" + row.title + (row.notes ? "\n\n" + row.notes : ""), "#project=" + p.id);
    return ok;
  }, it && edit ? del("plan_items", it.id) : null);
}
function viewTasks() {
  const wrap = h("div", {class:"o-stack"});
  const lead = ["admin", "lead", "pm", "viewer"].includes(role());
  const who = O.taskWho || "me";
  const mine = i => i.assignee_id === S.me.id;
  const pick = i => who === "me" ? mine(i) : who === "all" ? true : who === "none" ? !i.assignee_id : i.assignee_id === who;
  const all = O.items.filter(pick);
  const open = all.filter(i => i.status !== "done").sort((a, b) => (a.due_date || "9999").localeCompare(b.due_date || "9999"));
  const recent = all.filter(i => i.status === "done" && i.completed_at && i.completed_at.slice(0, 10) >= addDays(TODAY, -14)).sort((a, b) => b.completed_at.localeCompare(a.completed_at));
  const groups = [["Overdue", open.filter(isLate), "bad"], ["Due in the next 7 days", open.filter(i => !isLate(i) && i.due_date && i.due_date <= addDays(TODAY, 7)), "warn"],
    ["Later", open.filter(i => i.due_date && i.due_date > addDays(TODAY, 7)), ""], ["No due date", open.filter(i => !i.due_date), ""]].filter(g => g[1].length);
  const peopleWith = [...new Set(O.items.filter(i => i.status !== "done" && i.assignee_id).map(i => i.assignee_id))].map(id => [id, personName(id)]).sort((a, b) => a[1].localeCompare(b[1]));
  wrap.append(h("div", {class:"toolbar"}, h("h2", null, who === "me" ? "My tasks" : "Tasks"),
    lead ? h("select", {"aria-label":"Whose tasks", class:"inp", style:"max-width:240px", onchange: e => { O.taskWho = e.target.value; render(); }},
      [["me", "My tasks"], ["all", "Everyone on my projects"], ["none", "Not assigned yet"], ...peopleWith.filter(x => x[0] !== S.me.id)].map(([v, t]) => h("option", {value:v, selected:who === v}, t))) : null));
  wrap.append(h("div", {class:"o-tiles"}, tile("Open", String(open.length), who === "me" ? "assigned to you" : ""), tile("Overdue", String(open.filter(isLate).length), "", open.some(isLate) ? "bad" : ""),
    tile("Due this week", String(open.filter(i => !isLate(i) && i.due_date && i.due_date <= addDays(TODAY, 7)).length)), tile("Done, last 2 weeks", String(recent.length))));
  const row = i => {
    const p = byId(O.projects, i.project_id) || proj(i.project_id), path = parentPath(i);
    return h("li", {class:"task-r" + (i.status === "done" ? " is-done" : "")},
      canTick(i, p.id ? p : null) ? h("input", {type:"checkbox", "aria-label":"Done: " + i.title, checked:i.status === "done", onchange: ev => setItemStatus(i, ev.target.checked ? "done" : "in_progress")}) : h("span"),
      h("div", {class:"task-main"}, h("button", {class:"linkish", onclick:() => p.id && openPlanItem(p, i)}, i.title),
        h("small", null, [p.number ? p.number + " · " + p.name : "", path].filter(Boolean).join(" · "))),
      who !== "me" ? h("span", {class:"muted small"}, i.assignee_id ? personName(i.assignee_id) : "Unassigned") : null,
      planChip(i.status),
      h("span", {class:"mono small nowrap" + (isLate(i) ? " bad-t" : "")}, i.due_date ? (isLate(i) ? dayDiff(i.due_date, TODAY) + "d late · " : "") + fmtDate(i.due_date) : "—"),
      byId(O.projects, i.project_id) ? h("button", {class:"btn small", onclick:() => openProject(i.project_id)}, "Project") : null);
  };
  if (!open.length && !recent.length) wrap.append(h("div", {class:"panel"}, emptyState(who === "me" ? "Nothing assigned to you" : "No tasks here",
    "Tasks come from each project's plan. The PM adds phases and tasks on the project page and assigns them.")));
  for (const [title, list, cls] of groups) wrap.append(panel(title, plural(list.length, "task"), h("ul", {class:"task-list " + cls}, list.map(row))));
  if (recent.length) wrap.append(h("details", {class:"o-hist panel-ish"}, h("summary", null, "Done in the last 2 weeks (" + recent.length + ")"), h("ul", {class:"task-list"}, recent.map(row))));
  return wrap;
}

// ---------------------------------------------------------------- expenses
const EXP_CAT = [["materials", "Materials"], ["equipment", "Equipment rental"], ["tools", "Tools"], ["fuel", "Fuel"], ["lodging", "Lodging"], ["meals", "Meals / per diem"],
  ["travel", "Travel"], ["permits", "Permits and fees"], ["shipping", "Shipping"], ["other", "Other"]];
const EXP_PAID = [["company_card", "Company card"], ["reimburse", "Paid myself (reimburse me)"], ["invoice", "Invoice / on account"]];
const EXP_ST = {submitted:["Waiting on PM", "warn"], pm_approved:["Waiting on CFO", "acc"], approved:["Approved", "go"], rejected:["Sent back", "bad"]};
const catName = k => (EXP_CAT.find(x => x[0] === k) || [k, k])[1];
const paidName = k => (EXP_PAID.find(x => x[0] === k) || [k, k])[1];
const isFin = () => !!(S.me && S.me.finance_approver);
const canPmApprove = e => { if (e.status !== "submitted") return false;
  if (!e.project_id) return e.approver_id === S.me.id || isAdmin();
  const p = byId(O.projects, e.project_id); return !!p && canEdit(p); };
// jobs anyone can log an expense against (falls back to the projects you can see if the list isn't set up yet)
const expJobs = () => (O.expProj || O.projects.filter(p => p.phase !== "closed")).slice().sort((a, b) => a.number.localeCompare(b.number));
const GENERAL = {id:null, number:"", name:"General / overhead", general:true};
const expProject = id => id ? (byId(O.projects, id) || byId(O.expProj || [], id) || proj(id)) : GENERAL;
const canCfoApprove = e => e.status === "pm_approved" && isFin();
const canSendBack = e => (e.status === "submitted" && (canPmApprove(e) || isFin())) || (e.status === "pm_approved" && isFin());
const waitingOnMe = () => O.exps.filter(e => canPmApprove(e) || canCfoApprove(e));
const fullMoney = v => core.money(Number(v) || 0);
function expTable(list, showProject) {
  if (!list.length) return h("div", {class:"empty"}, "No expenses here.");
  const trail = e => [e.pm_by ? "PM approved: " + personName(e.pm_by) + " " + fmtDate((e.pm_at || "").slice(0, 10)) : null,
    e.cfo_by ? "Final approval: " + personName(e.cfo_by) + " " + fmtDate((e.cfo_at || "").slice(0, 10)) : null].filter(Boolean).join(" · ");
  return h("div", {class:"tbl-wrap flat"}, h("table", {class:"exp-tbl"},
    h("thead", null, h("tr", null, h("th", null, "Date"), showProject ? h("th", null, "Project") : null, h("th", null, "Category"), h("th", null, "Vendor and purpose"), h("th", null, "Logged by"),
      h("th", {class:"num"}, "Amount"), h("th", null, "Status"), h("th", null, "Receipt"), h("th", null, h("span", {class:"sr"}, "Actions")))),
    h("tbody", null, list.map(e => {
      const p = expProject(e.project_id);
      return h("tr", null, h("td", {class:"mono nowrap"}, fmtDate(e.spent_on)),
        showProject ? h("td", null, p.number ? h("button", {class:"linkish", onclick:() => byId(O.projects, e.project_id) && openProject(e.project_id)}, p.number) : "—", h("div", {class:"muted small"}, p.name || "")) : null,
        h("td", null, catName(e.category)),
        h("td", null, h("button", {class:"linkish", onclick:() => openExpenseReview(e)}, e.vendor || catName(e.category)), e.description ? h("div", {class:"muted small"}, e.description) : null),
        h("td", null, personName(e.submitted_by), h("div", {class:"muted small"}, paidName(e.paid_with))),
        h("td", {class:"num mono"}, fullMoney(e.amount)),
        h("td", {title:trail(e) || null}, chip((EXP_ST[e.status] || EXP_ST.submitted)[1], (EXP_ST[e.status] || EXP_ST.submitted)[0]), e.status === "rejected" && e.reject_reason ? h("div", {class:"small bad-t"}, e.reject_reason) : null,
          trail(e) ? h("div", {class:"muted small"}, trail(e)) : null),
        h("td", null, e.receipt_path ? h("button", {class:"linkish", onclick: async () => { const [u] = await signedUrls([e.receipt_path]); if (u) window.open(u, "_blank", "noopener"); else toast("Couldn't open the receipt."); }}, "View") : h("span", {class:"muted"}, "None")),
        h("td", {class:"nowrap"},
          canPmApprove(e) || canCfoApprove(e) ? h("button", {class:"btn small primary", onclick: ev => decideExpense(e, ev.currentTarget)}, canCfoApprove(e) ? "Final approve" : "Approve") : null,
          canSendBack(e) ? h("button", {class:"btn small", onclick:() => openSendBack(e)}, "Send back") : null,
          e.submitted_by === S.me.id && ["submitted", "rejected"].includes(e.status) && (p.id || p.general) ? h("button", {class:"btn small", onclick:() => openExpense(p, e)}, e.status === "rejected" ? "Fix and resubmit" : "Edit") : null));
    }))));
}
async function decideExpense(e, btn) {
  if (btn) btn.disabled = true;
  const wasPm = e.status === "pm_approved";
  const {error} = await sb.rpc("expense_decide", {eid:e.id, decision:"approve", reason:null});
  if (btn) btn.disabled = false;
  if (error) { toast(friendly(error)); return; }
  toast(wasPm ? "Approved. It now counts toward the job cost." : "Approved. It's now with the CFO for final approval.");
  { const p = byId(O.projects, e.project_id) || {}; const what = fullMoney(e.amount) + " · " + (e.vendor || catName(e.category)) + (p.number ? " on " + p.number : "");
    if (wasPm) tell([e.submitted_by], "Expense approved: " + what, "Your expense " + what + " has final approval.", "#expense=" + e.id);
    else tell(activePeople().filter(x => x.finance_approver).map(x => x.id), "Expense to approve: " + what,
      (S.me.full_name || S.me.email) + " approved " + personName(e.submitted_by) + "'s expense " + what + ". It needs your final approval.", "#expense=" + e.id); }
  await reload("exps"); render();
}

// one expense on its own: what emails link to (#expense=<id>), with the receipt and Approve / Send back
async function openExpenseById(id) {
  let e = byId(O.exps, id);
  if (!e) { await reload("exps"); e = byId(O.exps, id); }
  if (!e) { toast("That expense isn't available to you."); return; }
  openExpenseReview(e);
}
function openExpenseReview(e) {
  const p = expProject(e.project_id), st = EXP_ST[e.status] || EXP_ST.submitted;
  const rc = h("div", {class:"rc-view"}, e.receipt_path ? h("span", {class:"muted small"}, "Loading receipt…") : h("span", {class:"muted"}, "No receipt attached."));
  if (e.receipt_path) signedUrls([e.receipt_path]).then(([u]) => {
    if (!u) { rc.replaceChildren(h("span", {class:"muted"}, "Couldn't load the receipt.")); return; }
    rc.replaceChildren(/\.pdf($|\?)/i.test(e.receipt_path) ? h("a", {class:"btn small", href:u, target:"_blank", rel:"noopener"}, "Open receipt (PDF)")
      : h("a", {href:u, target:"_blank", rel:"noopener", title:"Open full size"}, h("img", {src:u, alt:"Receipt"}))); });
  const row = (k, v) => v ? h("div", {class:"rv-row"}, h("span", {class:"k"}, k), h("span", null, v)) : null;
  const trail = [e.pm_by ? "First approval: " + personName(e.pm_by) + " " + fmtDate((e.pm_at || "").slice(0, 10)) : null,
    e.cfo_by ? "Final approval: " + personName(e.cfo_by) + " " + fmtDate((e.cfo_at || "").slice(0, 10)) : null].filter(Boolean).join(" · ");
  const body = h("div", {class:"o-stack"},
    h("div", {class:"rv-top"}, h("b", null, fullMoney(e.amount)), chip(st[1], st[0])),
    e.status === "rejected" && e.reject_reason ? h("div", {class:"o-due bad"}, h("b", null, "Sent back by " + personName(e.rejected_by)), h("span", null, e.reject_reason)) : null,
    h("div", {class:"rv"}, row("Logged by", personName(e.submitted_by)), row("Date", fmtDate(e.spent_on)), row("Job", p.general ? "General / overhead" : (p.number || "") + " · " + (p.name || "")),
      row("Category", catName(e.category)), row("Vendor", e.vendor), row("For", e.description), row("Paid with", paidName(e.paid_with)),
      !e.project_id && e.approver_id && e.status === "submitted" ? row("First approval", personName(e.approver_id)) : null, row("History", trail)),
    rc);
  const foot = [];
  if (canSendBack(e)) foot.push(h("button", {class:"btn spacer", onclick:() => openSendBack(e)}, "Send back"));
  if (canPmApprove(e) || canCfoApprove(e)) foot.push(h("button", {class:"btn primary" + (foot.length ? "" : " spacer"), onclick: async ev => { await decideExpense(e, ev.currentTarget); closeDrawer(); }}, canCfoApprove(e) ? "Final approve" : "Approve"));
  if (e.submitted_by === S.me.id && ["submitted", "rejected"].includes(e.status)) foot.push(h("button", {class:"btn" + (foot.length ? "" : " spacer"), onclick:() => openExpense(p.general ? null : p, e)}, e.status === "rejected" ? "Fix and resubmit" : "Edit"));
  if (p.id && byId(O.projects, p.id)) foot.push(h("button", {class:"btn" + (foot.length ? "" : " spacer"), onclick:() => { closeDrawer(); openProject(p.id); }}, "Open the job"));
  foot.push(h("button", {class:"btn" + (foot.length ? "" : " spacer"), onclick:() => closeDrawer()}, "Close"));
  openDrawer({title:"Expense · " + (e.vendor || catName(e.category)), body, foot});
}
function openSendBack(e) {
  const d = {reason:""};
  openDrawer({title:"Send back " + fullMoney(e.amount) + " · " + (e.vendor || catName(e.category)), body:h("div", {class:"form"},
    fld(d, "reason", "What needs fixing? " + personName(e.submitted_by) + " sees this.", "textarea", {full:true, placeholder:"e.g. Receipt is unreadable, retake the photo"})),
    foot:[h("button", {class:"btn spacer", onclick:() => closeDrawer()}, "Cancel"), h("button", {class:"btn primary", onclick: async () => {
      if (!d.reason.trim()) { toast("Say what needs fixing."); return; }
      const {error} = await sb.rpc("expense_decide", {eid:e.id, decision:"reject", reason:d.reason.trim()});
      if (error) { toast(friendly(error)); return; }
      closeDrawer(); toast("Sent back to " + personName(e.submitted_by)); await reload("exps"); render();
      tell([e.submitted_by], "Expense sent back: " + fullMoney(e.amount) + " · " + (e.vendor || catName(e.category)), (S.me.full_name || S.me.email) + " sent your expense back:\n\n" + d.reason.trim(), "#expense=" + e.id);
    }}, "Send back")]});
}
function openExpense(p, e) {
  p = p || GENERAL;
  const d = e ? {...e, amount:Number(e.amount)} : {spent_on:TODAY, category:"materials", amount:null, paid_with:"company_card", vendor:"", description:""};
  // two pickers: the camera (phones open it straight away) or a photo/PDF already on the device
  let picked = null;
  const preview = h("div", {class:"rc-preview"});
  const choose = f => { picked = f || null; preview.replaceChildren();
    if (!f) return;
    if (/^image\//.test(f.type)) { const u = URL.createObjectURL(f); preview.append(h("img", {src:u, alt:"Receipt photo"})); }
    preview.append(h("span", null, f.name + " · " + Math.max(1, Math.round(f.size / 1024)) + " KB"), h("button", {class:"btn small", type:"button", onclick:() => choose(null)}, "Remove")); };
  const cam = h("input", {type:"file", accept:"image/*", capture:"environment", class:"sr", id:"f-receipt-cam", onchange: ev => choose(ev.target.files[0])});
  const pick = h("input", {type:"file", accept:"image/*,application/pdf", class:"sr", id:"f-receipt", onchange: ev => choose(ev.target.files[0])});
  const file = {get files() { return picked ? [picked] : []; }};
  const mgr = S.me.manager_id ? personName(S.me.manager_id) : null;
  const note = h("p", {class:"muted small", style:"grid-column:1/-1;margin:0"}, p.general
    ? "Not tied to a project. Goes to " + (mgr ? mgr + " (your manager)" : "your department lead, or straight to the CFO if you don't have one,") + " to approve, then to the CFO for final approval."
    : "Goes to " + (p.pm_id ? personName(p.pm_id) + " (PM)" : "the PM") + " to approve, then to the CFO for final approval. Approved expenses count toward the job's cost.");
  const body = h("div", null,
    e && e.status === "rejected" ? h("div", {class:"o-due bad"}, h("b", null, "Sent back by " + personName(e.rejected_by)), h("span", null, e.reject_reason || "")) : null,
    h("div", {class:"form"},
      fld(d, "spent_on", "Date", "date"), fld(d, "amount", "Amount ($)", "number"),
      fld(d, "category", "Category", "select", {options:EXP_CAT, blank:false}), fld(d, "paid_with", "Paid with", "select", {options:EXP_PAID, blank:false}),
      fld(d, "vendor", "Vendor or store", "text", {full:true, placeholder:"e.g. Home Depot, Sunbelt Rentals, Hampton Inn"}),
      fld(d, "description", "What it was for", "textarea", {full:true}),
      h("div", {class:"field full"}, h("span", {class:"lab-like"}, e && e.receipt_path ? "Replace the receipt (photo or PDF)" : "Receipt"),
        h("div", {class:"rc-btns"}, cam, pick, h("label", {for:"f-receipt-cam", class:"btn primary rc-cam"}, "📷 Take a photo"), h("label", {for:"f-receipt", class:"btn"}, "Choose a photo or PDF")), preview),
      note));
  const foot = [];
  if (e && e.submitted_by === S.me.id && ["submitted", "rejected"].includes(e.status)) foot.push(deleteButton(async () => {
    if (await run(sb.from("expenses").delete().eq("id", e.id), "Deleted")) { if (e.receipt_path) await sb.storage.from(BUCKET).remove([e.receipt_path]); await reload("exps"); render(); closeDrawer(); } }));
  foot.push(h("button", {class:"btn" + (foot.length ? "" : " spacer"), onclick:() => closeDrawer()}, "Cancel"));
  foot.push(h("button", {class:"btn primary", onclick: async ev => {
    const amt = Number(d.amount);
    if (!(amt > 0)) { toast("Enter the amount."); return; }
    if (!d.spent_on) { toast("Enter the date."); return; }
    if (!file.files.length && !(e && e.receipt_path)) { toast("Add a photo of the receipt."); return; }
    const btn = ev.currentTarget; btn.disabled = true; btn.textContent = "Saving…";
    let path = e ? e.receipt_path : null, uploaded = null;
    if (file.files.length) {
      const f = await shrinkImage(file.files[0]);
      const safe = f.name.replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, " ").slice(-100);
      uploaded = (p.general ? "general/" + S.me.id : p.id) + "/expenses/" + Date.now() + "-" + Math.random().toString(36).slice(2, 6) + "-" + safe;
      const {error} = await sb.storage.from(BUCKET).upload(uploaded, f, {contentType:f.type || "application/octet-stream", upsert:false});
      if (error) { btn.disabled = false; btn.textContent = e ? "Resubmit" : "Submit"; toast("The receipt didn't upload: " + friendly(error)); return; }
      path = uploaded;
    }
    const row = {project_id:p.general ? null : p.id, spent_on:d.spent_on, category:d.category, amount:amt, paid_with:d.paid_with, vendor:nullify((d.vendor || "").trim()), description:nullify((d.description || "").trim()), receipt_path:path};
    const res = e ? await run(sb.from("expenses").update(row).eq("id", e.id).select().single(), "Resubmitted to the PM")
                  : await run(sb.from("expenses").insert(row).select().single(), "Submitted to the PM");
    btn.disabled = false; btn.textContent = e ? "Resubmit" : "Submit";
    if (!res) { if (uploaded) await sb.storage.from(BUCKET).remove([uploaded]); return; }
    if (uploaded && e && e.receipt_path && e.receipt_path !== uploaded) await sb.storage.from(BUCKET).remove([e.receipt_path]);
    closeDrawer(); await reload("exps"); render();
    const where = p.general ? "(general, not a project)" : "on " + p.number + " " + p.name;
    const who = p.general ? (res.status === "pm_approved" ? activePeople().filter(x => x.finance_approver).map(x => x.id) : [res.approver_id]) : [p.pm_id];
    tell(who.filter(Boolean), "Expense to approve: " + fullMoney(amt) + " · " + (row.vendor || catName(row.category)) + (p.general ? "" : " on " + p.number),
      (S.me.full_name || S.me.email) + (e ? " resubmitted" : " submitted") + " an expense " + where + ": " + fullMoney(amt) + " at " + (row.vendor || catName(row.category)) + ". It needs your approval.", "#expense=" + res.id);
  }}, e ? "Resubmit" : "Submit"));
  openDrawer({title:(e ? "Expense · " : "Log an expense · ") + (p.general ? "General" : p.number), body, foot});
  const amt = document.getElementById("f-amount"); if (amt) { amt.setAttribute("inputmode", "decimal"); amt.setAttribute("placeholder", "0.00"); }
}
// on a phone: big buttons and cards instead of the wide tables
const isPhone = () => window.matchMedia && window.matchMedia("(max-width:700px)").matches;
const isInstalled = () => (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true;
function startExpense() {
  const ps = expJobs();
  const mine = ps.filter(p => p.pm_id === S.me.id || O.asg.some(a => a.project_id === p.id && a.work_date === TODAY && tech(a.tech_id).profile_id === S.me.id)
    || (O.members || []).some(m => m.project_id === p.id && m.profile_id === S.me.id));
  const rest = ps.filter(p => !mine.includes(p));
  const q = h("input", {class:"inp", type:"search", placeholder:"Search jobs by name or number", "aria-label":"Search jobs"});
  const list = h("div", {class:"pick-job"});
  const row = (p, tag) => h("button", {class:"btn wide pick-row", onclick:() => openExpense(p)}, h("b", null, p.name), h("small", null, (p.number || "") + (tag ? " · " + tag : "")));
  const draw = () => { const t = q.value.trim().toLowerCase(), f = p => !t || (p.name + " " + p.number).toLowerCase().includes(t);
    list.replaceChildren(row(GENERAL, "not tied to a project (sales travel, office, training…)"), ...mine.filter(f).map(p => row(p, "yours")), ...rest.filter(f).map(p => row(p))); };
  q.oninput = draw; draw();
  openDrawer({title:"Log an expense · which job?", body:h("div", {class:"o-stack"}, ps.length > 8 ? q : null, list), foot:[h("button", {class:"btn spacer", onclick:() => closeDrawer()}, "Cancel")]});
}
function expCards(list) {
  if (!list.length) return h("div", {class:"empty"}, "No expenses here.");
  return h("ul", {class:"exp-cards"}, list.map(e => { const p = expProject(e.project_id), st = EXP_ST[e.status] || EXP_ST.submitted;
    return h("li", null,
      h("div", {class:"ec-top", onclick:() => openExpenseReview(e), style:"cursor:pointer"}, h("b", null, fullMoney(e.amount)), chip(st[1], st[0])),
      h("div", null, (e.vendor || catName(e.category)) + " · " + fmtDate(e.spent_on)),
      h("div", {class:"muted small"}, (p.general ? "General / overhead" : p.number ? p.number + " · " + p.name : "") + (e.submitted_by !== S.me.id ? " · " + personName(e.submitted_by) : "")),
      e.status === "rejected" && e.reject_reason ? h("div", {class:"small bad-t"}, e.reject_reason) : null,
      h("div", {class:"ec-acts"},
        e.receipt_path ? h("button", {class:"btn small", onclick: async () => { const [u] = await signedUrls([e.receipt_path]); if (u) window.open(u, "_blank", "noopener"); else toast("Couldn't open the receipt."); }}, "Receipt") : null,
        canPmApprove(e) || canCfoApprove(e) ? h("button", {class:"btn small primary", onclick: ev => decideExpense(e, ev.currentTarget)}, canCfoApprove(e) ? "Final approve" : "Approve") : null,
        canSendBack(e) ? h("button", {class:"btn small", onclick:() => openSendBack(e)}, "Send back") : null,
        e.submitted_by === S.me.id && ["submitted", "rejected"].includes(e.status) && (p.id || p.general) ? h("button", {class:"btn small", onclick:() => openExpense(p, e)}, e.status === "rejected" ? "Fix and resubmit" : "Edit") : null)); }));
}
function expensePanel(p) {
  const list = O.exps.filter(e => e.project_id === p.id).sort((a, b) => b.spent_on.localeCompare(a.spent_on) || (b.created_at || "").localeCompare(a.created_at || ""));
  const appr = sum(list.filter(e => e.status === "approved"), e => e.amount), pend = sum(list.filter(e => ["submitted", "pm_approved"].includes(e.status)), e => e.amount);
  const sub = role() === "field" ? "The expenses you've logged on this job" : list.length ? fullMoney(appr) + " approved" + (pend ? " · " + fullMoney(pend) + " waiting on approval" : "") : "Receipts from the field, approved by the PM and then the CFO";
  return panel("Expenses", sub, expTable(list, false),
    h("div", {class:"o-actions"}, h("button", {class:"btn primary small", onclick:() => openExpense(p)}, "+ Log an expense")));
}
function viewExpenses() {
  const wrap = h("div", {class:"o-stack"});
  if (isPhone()) return phoneExpenses(wrap);
  const me = waitingOnMe().sort((a, b) => a.spent_on.localeCompare(b.spent_on));
  const mine = O.exps.filter(e => e.submitted_by === S.me.id).sort((a, b) => b.spent_on.localeCompare(a.spent_on));
  const others = O.exps.filter(e => e.submitted_by !== S.me.id && !me.includes(e));
  const month = TODAY.slice(0, 7);
  const tot = f => sum(O.exps.filter(f), e => e.amount);
  wrap.append(h("div", {class:"toolbar"}, h("h2", null, "Expenses"),
    h("button", {class:"btn primary", onclick:() => startExpense()}, "+ Log an expense")));
  wrap.append(h("div", {class:"o-tiles"},
    tile("Waiting on you", String(me.length), me.length ? fullMoney(sum(me, e => e.amount)) : isFin() ? "final approvals" : "approvals", me.length ? "warn" : ""),
    role() !== "field" ? tile("Waiting on PMs", fullMoney(tot(e => e.status === "submitted")), plural(O.exps.filter(e => e.status === "submitted").length, "expense")) : null,
    role() !== "field" ? tile("Waiting on the CFO", fullMoney(tot(e => e.status === "pm_approved")), plural(O.exps.filter(e => e.status === "pm_approved").length, "expense")) : null,
    tile("Approved this month", fullMoney(tot(e => e.status === "approved" && (e.cfo_at || "").slice(0, 7) === month)), role() === "field" ? "yours" : "")));
  wrap.append(panel(isFin() ? "Waiting on you" : "Waiting on your approval", isFin() ? "PM-approved expenses need your final approval; submitted ones on your projects need your PM approval" : "Expenses logged on your projects",
    me.length ? expTable(me, true) : h("div", {class:"empty"}, "Nothing waiting on you.")));
  wrap.append(panel("Expenses you logged", plural(mine.length, "expense"), expTable(mine, true)));
  if (role() !== "field" && others.length) wrap.append(h("details", {class:"o-hist panel-ish"}, h("summary", null, "All other expenses on your projects (" + others.length + ")"),
    expTable(others.sort((a, b) => b.spent_on.localeCompare(a.spent_on)), true)));
  return wrap;
}

function phoneExpenses(wrap) {
  const me = waitingOnMe().sort((a, b) => a.spent_on.localeCompare(b.spent_on));
  const mine = O.exps.filter(e => e.submitted_by === S.me.id).sort((a, b) => b.spent_on.localeCompare(a.spent_on) || (b.created_at || "").localeCompare(a.created_at || ""));
  let tipOff = false; try { tipOff = localStorage.getItem("rfip.hometip") === "off"; } catch (e) {}
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  wrap.append(h("button", {class:"btn primary big-cta", onclick:() => startExpense()}, "+ Log an expense"),
    !isInstalled() && !tipOff ? h("div", {class:"home-tip"}, h("b", null, "Put RFIP on your home screen"),
      h("span", null, ios ? "In Safari, tap the Share button, then “Add to Home Screen.”" : "In Chrome, tap ⋮ (top right), then “Add to Home screen” or “Install app.”"),
      h("button", {class:"btn small", onclick:() => { try { localStorage.setItem("rfip.hometip", "off"); } catch (e) {} render(); }}, "Got it")) : null,
    me.length ? panel("Waiting on your approval", plural(me.length, "expense"), expCards(me)) : null,
    panel("Your expenses", mine.length ? fullMoney(sum(mine.filter(e => ["submitted", "pm_approved"].includes(e.status)), e => e.amount)) + " waiting on approval" : "", expCards(mine.slice(0, 30))));
  return wrap;
}

// ---------------------------------------------------------------- customer view link
const customerUrl = l => location.origin + location.pathname.replace(/[^/]*$/, "") + "customer.html?k=" + l.token;
async function customerLink(p, action) {
  const {data, error} = await sb.rpc("customer_link", {p:p.id, action});
  if (error) { toast(friendly(error)); return; }
  await reload("clinks"); render();
  if (action !== "off" && data && data.token) { try { await navigator.clipboard.writeText(customerUrl(data)); toast(action === "new" ? "New link copied. The old one no longer works." : "Link copied. Paste it into an email to the customer."); } catch (e) { toast("Link is on. Use Copy to grab it."); } }
  else if (action === "off") toast("Customer link turned off");
}
function customerPanel(p, edit) {
  const l = O.clinks.find(x => x.project_id === p.id);
  const what = "A live status page for the customer: progress, schedule, plan phases and your weekly update's \"done\" and \"next week\". No money, internal notes or documents.";
  let body;
  if (!l) body = h("div", null, h("p", {class:"muted", style:"margin-top:0"}, what),
    edit ? h("button", {class:"btn primary small", onclick:() => customerLink(p, "on")}, "Turn on and copy the link") : h("p", {class:"muted"}, "The PM hasn't shared this project yet."));
  else if (!l.active) body = h("div", null, h("p", {style:"margin-top:0"}, h("b", null, "The customer link is off."), " Anyone who had it now sees a message to contact their PM."),
    edit ? h("div", {class:"cl-btns"}, h("button", {class:"btn small", onclick:() => customerLink(p, "on")}, "Turn the same link back on"), h("button", {class:"btn small", onclick:() => customerLink(p, "new")}, "Make a new link")) : null);
  else {
    const url = customerUrl(l);
    const inp = h("input", {class:"inp mono", readonly:true, value:url, "aria-label":"Customer link", onclick: e => e.target.select()});
    body = h("div", null, h("p", {class:"muted", style:"margin-top:0"}, what),
      h("div", {class:"cl-row"}, inp, h("button", {class:"btn small primary", onclick: async () => { try { await navigator.clipboard.writeText(url); toast("Link copied"); } catch (e) { inp.select(); toast("Press Ctrl+C to copy"); } }}, "Copy"),
        h("a", {class:"btn small", href:url, target:"_blank", rel:"noopener"}, "Preview")),
      h("p", {class:"muted small"}, l.views ? "Opened " + plural(l.views, "time") + ", last " + new Date(l.last_viewed_at).toLocaleString("en-US", {month:"short", day:"numeric", hour:"numeric", minute:"2-digit"}) : "Not opened yet"),
      edit ? h("div", {class:"cl-btns"}, h("button", {class:"btn small", onclick:() => customerLink(p, "off")}, "Turn off"),
        h("button", {class:"btn small", title:"Use this if the link went to the wrong person", onclick:() => customerLink(p, "new")}, "Replace the link")) : null);
  }
  return panel("Customer view", l && l.active ? "On · anyone with the link can see it" : "Off", h("div", {class:"o-pad"}, body));
}

// ---------------------------------------------------------------- routing




// ---------------------------------------------------------------- programs (parent job + a phase job per PO)
const kidsOf = pid => O.projects.filter(x => x.parent_id === pid).sort((a, b) => a.number.localeCompare(b.number));
const isProgram = p => !!p && kidsOf(p.id).length > 0;
const famIds = p => [p.id, ...kidsOf(p.id).map(k => k.id)];
const phaseLabel = pid => { const x = byId(O.projects, pid) || proj(pid); return x.parent_id ? (x.number || "") + " · " + (x.name || "") : "Program-wide"; };
const phaseTag = pid => { const x = byId(O.projects, pid) || proj(pid); return h("span", {class:"chip " + (x.parent_id ? pjClass(pid) : "") + " ph-tag", title:phaseLabel(pid)}, x.parent_id ? (x.number || "").split("-").slice(-1)[0] === x.number ? x.number : "Ph " + (x.number || "").split("-").slice(-1)[0] : "Program"); };
function programPanels(p) {
  const kids = kidsOf(p.id), all = [p, ...kids], ids = new Set(all.map(x => x.id)), money = role() !== "field";
  const cs = all.map(x => ({x, c:calc(x)}));
  const tot = sum(cs, r => r.c.total), billed = sum(cs, r => r.c.billed), budCost = sum(cs, r => r.c.budCost), fcCost = sum(cs, r => r.c.fcCost);
  const done = tot ? sum(cs, r => r.c.total * r.c.done) / tot : 0;
  const iss = O.issues.filter(i => ids.has(i.project_id) && issOpen(i)).sort(issSort);
  const out = [];
  out.push(h("div", {class:"o-tiles"},
    money ? tile("Program contract", compact(tot), plural(kids.length, "phase job") + (p.contract_value ? " + program-level" : "")) : null,
    money ? tile("Billed", compact(billed), compact(Math.max(0, tot - billed)) + " left to bill") : null,
    tile("Complete", pct(done), "weighted by contract"),
    money ? tile("Margin forecast", pct(tot ? (tot - fcCost) / tot : 0), "budget " + pct(tot ? (tot - budCost) / tot : 0), tot && (tot - fcCost) / tot < (tot - budCost) / tot - .02 ? "bad" : "") : null,
    tile("Open issues", String(iss.length), iss.filter(issLate).length + " overdue", iss.some(issLate) ? "bad" : "")));
  out.push(panel("Phase jobs", "One per customer PO · click a phase for its full page", h("div", {class:"tbl-wrap flat"}, h("table", {class:"prog-tbl"},
    h("thead", null, h("tr", null, h("th", null, "Phase job"), h("th", null, "PO"), h("th", null, "PM"), money ? h("th", {class:"num"}, "Contract") : null, money ? h("th", {class:"num"}, "Billed") : null,
      h("th", null, "Labor hours"), money ? h("th", {class:"num"}, "Margin fcst") : null, h("th", null, "Complete"), h("th", null, "Phase"))),
    h("tbody", null, kids.map(k => { const c = calc(k), over = c.burn >= .8 && c.done < .8;
      return h("tr", {class:"click", tabindex:"0", onclick:() => openProject(k.id), onkeydown: e => { if (e.key === "Enter") openProject(k.id); }},
        h("td", null, h("b", null, k.number), h("div", {class:"muted small"}, k.name)), h("td", {class:"mono"}, k.po_number || "—"), h("td", null, personName(k.pm_id)),
        money ? h("td", {class:"num"}, compact(c.total)) : null, money ? h("td", {class:"num"}, compact(c.billed)) : null,
        h("td", {class:over ? "bad-t" : ""}, num(c.hu) + " / " + num(c.hb)),
        money ? h("td", {class:"num" + (c.fcM < c.estM - .02 ? " bad-t" : "")}, pct(c.fcM), h("div", {class:"muted small"}, "budget " + pct(c.estM))) : null,
        h("td", {class:"nowrap"}, h("span", {class:"minibar inline"}, h("i", {class:"go", style:"width:" + Math.round(c.done * 100) + "%"})), " " + pct(c.done)),
        h("td", null, phaseChip(k.phase))); }),
      p.contract_value || calc(p).hu ? h("tr", {class:"muted"}, h("td", null, h("b", null, p.number), h("div", {class:"muted small"}, "Program-level (this page)")), h("td", {class:"mono"}, p.po_number || "—"), h("td", null, personName(p.pm_id)),
        money ? h("td", {class:"num"}, compact(calc(p).total)) : null, money ? h("td", {class:"num"}, compact(calc(p).billed)) : null, h("td", null, num(calc(p).hu) + " / " + num(calc(p).hb)),
        money ? h("td", {class:"num"}, pct(calc(p).fcM)) : null, h("td", null, pct(calc(p).done)), h("td", null, phaseChip(p.phase))) : null))),
    canEdit(p) ? h("div", {class:"o-actions"}, h("button", {class:"btn primary small", onclick:() => openAddPhase(p)}, "+ Add phase job (new PO)")) : null));
  // everything from every phase, combined
  const logOn = (list, sel) => h("select", {class:"inp", style:"max-width:240px", "aria-label":"Choose the phase", onchange: e => { const x = byId(O.projects, e.target.value); e.target.value = ""; if (x) sel(x); }},
    h("option", {value:""}, list[0]), all.filter(x => canPlan(x)).map(x => h("option", {value:x.id}, x.parent_id ? x.number + " · " + x.name : x.number + " · whole program")));
  out.push(h("div", {class:"prog-h"}, h("h3", null, "Across all phases"), h("span", {class:"muted small"}, "Everything from " + plural(kids.length, "phase job") + " and this page, labeled by phase")));
  if (featureOn("issues")) out.push(panel("Issue log", plural(iss.length, "open issue"), all.some(canPlan) ? h("div", {class:"o-pad", style:"padding-bottom:0"}, logOn(["+ Log an issue on…"], x => openIssue(x, null))) : null,
    issueTable(iss, true), (() => { const cl = O.issues.filter(i => ids.has(i.project_id) && !issOpen(i)); return cl.length ? h("details", {class:"o-hist", style:"padding:0 16px 10px"}, h("summary", null, "Closed (" + cl.length + ")"), issueTable(cl.sort(issSort), true)) : null; })()));
  const wk = reportWeek();
  out.push(panel("Weekly updates", "Latest from each phase", h("div", {class:"o-pad"}, all.map(x => { const u = O.wu.filter(w => w.project_id === x.id).sort((a, b) => b.week_start.localeCompare(a.week_start))[0], st = updateState(x, wk);
    if (!u && !needsUpdate(x)) return null;
    return h("div", {class:"prog-wu"}, h("div", {class:"prog-wu-h"}, phaseTag(x.id), h("b", null, x.parent_id ? x.name : "Program-wide"), chip(st.cls, st.text),
      canEdit(x) && needsUpdate(x) ? h("button", {class:"btn small", onclick:() => openUpdate(x, wk)}, st.u ? "Edit" : "Write update") : null),
      u ? updateCard(u, false) : h("div", {class:"muted small"}, "No updates yet.")); }))));
  if (featureOn("items")) out.push(programPlanPanel(p, all));
  const ms = O.ms.filter(m => ids.has(m.project_id)).sort((a, b) => (a.actual ? 1 : 0) - (b.actual ? 1 : 0) || (a.planned || "9999").localeCompare(b.planned || "9999"));
  if (ms.length) out.push(panel("Milestones", ms.filter(m => m.actual).length + " of " + ms.length + " done", h("ul", {class:"prog-list"}, ms.map(m => h("li", {class:(m.actual ? "done" : m.planned && m.planned < TODAY ? "late" : "")},
    phaseTag(m.project_id), h("span", {class:"grow"}, m.name), h("span", {class:"mono small"}, m.actual ? "Done " + fmtDate(m.actual) : m.planned ? fmtDate(m.planned) : "no date"))))));
  const crew = O.asg.filter(a => ids.has(a.project_id) && a.work_date >= mondayOf(TODAY) && a.work_date <= addDays(mondayOf(TODAY), 4));
  if (crew.length) { const by = new Map(); for (const a of crew) { if (!by.has(a.project_id)) by.set(a.project_id, new Set()); by.get(a.project_id).add(a.tech_id); }
    out.push(panel("Crew this week", people(new Set(crew.map(a => a.tech_id)).size) + " across the phases", h("ul", {class:"prog-list"}, [...by].map(([pid, set]) => h("li", null, phaseTag(pid),
      h("span", {class:"grow"}, [...set].map(t => tech(t).name).filter(Boolean).join(", ")), h("span", {class:"muted small"}, people(set.size))))))); }
  const logs = O.logs.filter(l => ids.has(l.project_id)).sort((a, b) => b.log_date.localeCompare(a.log_date) || (b.created_at || "").localeCompare(a.created_at || "")).slice(0, 15);
  if (logs.length) out.push(panel("Daily field logs", "Latest across the phases", h("ul", {class:"prog-list logs"}, logs.map(l => h("li", null, phaseTag(l.project_id),
    h("div", {class:"grow"}, h("b", {class:"small"}, fmtDate(l.log_date) + (l.crew_count ? " · crew " + l.crew_count : "") + (l.hours ? " · " + num(l.hours) + " hrs" : "")), h("div", {class:"pre small"}, l.work),
      l.issues ? h("div", {class:"small warn-t"}, "Issue: " + l.issues) : null), h("span", {class:"muted small"}, personName(l.author_id)))))));
  const cos = O.cos.filter(c => ids.has(c.project_id));
  if (cos.length && money) out.push(panel("Change orders", plural(cos.length, "change order"), h("ul", {class:"prog-list"}, cos.map(c => h("li", null, phaseTag(c.project_id),
    h("span", {class:"grow"}, (c.number ? c.number + " · " : "") + (c.title || c.description || "Change order")), h("span", {class:"mono small"}, c.amount != null ? compact(c.amount) : "not priced"), chip(c.status === "approved" ? "go" : c.status === "pending" ? "warn" : "", c.status || ""))))));
  const reqs = O.reqs.filter(r => ids.has(r.project_id) && reqOpen(r));
  if (reqs.length) out.push(panel("Customer requests", plural(reqs.length, "open request"), h("ul", {class:"prog-list"}, reqs.map(r => h("li", null, phaseTag(r.project_id),
    h("button", {class:"linkish grow", onclick:() => openRequest(r)}, reqRef(r) + " · " + r.title), reqChip(r.status))))));
  const docs = O.docs.filter(d => ids.has(d.project_id)).sort((a, b) => (b.created_at || "").localeCompare(a.created_at || "")).slice(0, 15);
  if (docs.length) out.push(panel("Recent documents", "Newest across the phases · each phase's page has its full document set", h("ul", {class:"prog-list"}, docs.map(d => h("li", null, phaseTag(d.project_id),
    h("button", {class:"linkish grow", onclick: async () => { const [u] = await signedUrls([d.path]); if (u) window.open(u, "_blank", "noopener"); else toast("Couldn't open that file."); }}, d.name),
    h("span", {class:"muted small"}, folderName(d.folder) + " · " + fmtDate((d.created_at || "").slice(0, 10))))))));
  if (featureOn("exps")) { const ex = O.exps.filter(e => ids.has(e.project_id)).sort((a, b) => b.spent_on.localeCompare(a.spent_on));
    out.push(panel("Expenses", ex.length ? fullMoney(sum(ex.filter(e => e.status === "approved"), e => e.amount)) + " approved across the phases" : "None yet", h("div", {class:"o-pad", style:"padding-bottom:0"}, logOn(["+ Log an expense on…"], x => openExpense(x))), expTable(ex, true))); }
  out.push(h("div", {class:"prog-h"}, h("h3", null, "Program-wide records"), h("span", {class:"muted small"}, "Things logged on the parent job itself")));
  return out;
}

// the program's plan: every phase job's plan in one table on one timeline, each job as a header row
function programPlanPanel(p, all) {
  O.progClosed = O.progClosed || new Set();
  const jobs = all.filter(x => x.id !== p.id || itemsOf(p.id).length);
  const items = jobs.flatMap(x => itemsOf(x.id)), done = items.filter(i => i.status === "done").length, late = items.filter(isLate).length;
  const dates = items.flatMap(i => [i.start_date, i.due_date]).concat(jobs.flatMap(x => [x.start_date, x.end_date])).filter(Boolean).sort();
  const t0 = dates[0], t1 = dates[dates.length - 1], span = t0 && t1 ? Math.max(1, dayDiff(t0, t1)) : 0;
  const pos = d => span ? Math.max(0, Math.min(100, dayDiff(t0, d) / span * 100)) : 0;
  const todayPos = span && TODAY >= t0 && TODAY <= t1 ? pos(TODAY) : null;
  const track = (...bars) => h("div", {class:"plan-track"}, todayPos != null ? h("i", {class:"plan-today", style:"left:" + todayPos + "%"}) : null, ...bars);
  const body = [];
  for (const x of jobs) {
    const {rows, kids} = planTree(x.id), its = itemsOf(x.id), nd = its.filter(i => i.status === "done").length, open = !O.progClosed.has(x.id), ed = canPlan(x);
    const ds = its.flatMap(i => [i.start_date, i.due_date]).concat([x.start_date, x.end_date]).filter(Boolean).sort(), a = ds[0], b = ds[ds.length - 1];
    body.push(h("tr", {class:"plan-job"},
      h("td", {class:"plan-ck"}, h("button", {class:"tl-caret", "aria-expanded":String(open), "aria-label":(open ? "Hide " : "Show ") + x.number, onclick:() => { open ? O.progClosed.add(x.id) : O.progClosed.delete(x.id); render(); }}, open ? "▾" : "▸")),
      h("td", {class:"plan-t"}, x.id !== p.id && byId(O.projects, x.id) ? h("button", {class:"linkish", onclick:() => openProject(x.id)}, h("b", null, x.number + " · " + x.name)) : h("b", null, x.id === p.id ? "Program-wide" : x.number + " · " + x.name),
        h("small", {class:"muted"}, its.length ? " · " + nd + " of " + its.length + " done" : " · no plan yet")),
      h("td", null, personName(x.pm_id)), h("td", {class:"mono nowrap"}, a ? fmtDate(a) : ""), h("td", {class:"mono nowrap"}, b ? fmtDate(b) : ""),
      h("td", null, phaseChip(x.phase)),
      h("td", {class:"plan-tl"}, track(a && b && span ? h("b", {class:"plan-bar ph job " + pjClass(x.id), style:"left:" + pos(a) + "%;width:" + Math.max(1.5, pos(b) - pos(a)) + "%"}) : null)),
      h("td", null, ed ? h("button", {class:"btn small", onclick:() => openPlanItem(x, null, null)}, "+ Phase or task") : null)));
    if (!open) continue;
    if (!rows.length) body.push(h("tr", null, h("td"), h("td", {colspan:"7", class:"muted small", style:"padding-left:30px"}, ed ? "No plan yet. Add phases and tasks here, or open " + x.number + " to start from the standard phases or import from Excel." : "No plan yet.")));
    for (const {i, depth} of rows) {
      const sub = descendants(i.id, kids), sd = sub.filter(y => y.status === "done").length, st = i.start_date || i.due_date, en = i.due_date || i.start_date, d = depth + 1;
      body.push(h("tr", {class:"plan-r d" + Math.min(d, 3) + (i.status === "done" ? " is-done" : "") + (isLate(i) ? " is-late" : "")},
        h("td", {class:"plan-ck"}, canTick(i, x) ? h("input", {type:"checkbox", "aria-label":"Done: " + i.title, checked:i.status === "done", onchange: ev => setItemStatus(i, ev.target.checked ? "done" : "in_progress")}) : null),
        h("td", {class:"plan-t", style:"padding-left:" + (8 + d * 22) + "px"}, h("button", {class:"linkish", onclick:() => openPlanItem(x, i)}, i.title), sub.length ? h("small", {class:"muted"}, " · " + sd + " of " + sub.length + " done") : null),
        h("td", null, i.assignee_id ? personName(i.assignee_id) : h("span", {class:"muted"}, "—")),
        h("td", {class:"mono nowrap"}, i.start_date ? fmtDate(i.start_date) : ""), h("td", {class:"mono nowrap" + (isLate(i) ? " bad-t" : "")}, i.due_date ? fmtDate(i.due_date) : ""),
        h("td", null, planChip(i.status)),
        h("td", {class:"plan-tl"}, track(st && span ? h("b", {class:"plan-bar st-" + i.status + (depth ? "" : " ph") + (isLate(i) ? " late" : ""), style:"left:" + pos(st) + "%;width:" + Math.max(1.5, pos(en) - pos(st)) + "%"}) : null)),
        h("td", null, ed ? h("button", {class:"btn small", title:"Add a sub-task under " + i.title, onclick:() => openPlanItem(x, null, i.id)}, "+ Sub-task") : null)));
    }
  }
  return panel("Project plan · all phases", items.length ? plural(items.length, "item") + " · " + done + " done" + (late ? " · " + late + " overdue" : "") : "Each phase job's plan, on one timeline",
    h("div", {class:"tbl-wrap flat"}, h("table", {class:"plan-tbl prog-plan"},
      h("thead", null, h("tr", null, h("th", {class:"plan-ck"}, h("span", {class:"sr"}, "Done")), h("th", null, "Phase job / phase / task"), h("th", null, "Assigned to"), h("th", null, "Start"), h("th", null, "Due"),
        h("th", null, "Status"), h("th", {class:"plan-tl"}, t0 ? fmtDate(t0) + " – " + fmtDate(t1) : "Timeline"), h("th", null, h("span", {class:"sr"}, "Add")))),
      h("tbody", null, body))),
    canPlan(p) && !itemsOf(p.id).length ? h("div", {class:"o-actions"}, h("button", {class:"btn small", onclick:() => openPlanItem(p, null, null)}, "+ Program-wide phase or task")) : null);
}
function openAddPhase(p) {
  const n = kidsOf(p.id).length + 1;
  const d = {name:"Phase " + n, po:"", contract:null, hours:null, pm:p.pm_id};
  const pms = activePeople().filter(x => x.ops_role === "pm" || x.ops_role === "lead" || x.id === p.pm_id).map(x => [x.id, x.full_name || x.email]);
  drawerForm("Add a phase job to " + p.number, d, [
    h("p", {class:"muted small", style:"grid-column:1/-1;margin:0"}, "Creates job " + p.number + "-" + String(n).padStart(2, "0") + " under this program, with the same customer and department. It keeps its own budget, hours, billing and margin, and shows up combined on this page."),
    fld(d, "name", "Phase name", "text", {full:true, placeholder:"e.g. Phase 2 – North bowl remotes"}), fld(d, "po", "Customer PO number", "text"),
    fld(d, "pm", "PM for this phase", "select", {options:pms, blank:false}),
    fld(d, "contract", "PO amount (contract value, USD)", "number"), fld(d, "hours", "Labor hours budget", "number")],
    async () => {
      if (!(d.name || "").trim()) { toast("Name the phase."); return false; }
      const {data, error} = await sb.rpc("add_phase_job", {parent:p.id, phase_name:d.name.trim(), po:d.po || null, contract:Number(d.contract) || 0, hours:Number(d.hours) || 0, pm:d.pm || null});
      if (error) { toast(friendly(error)); return false; }
      toast("Added " + data.number); await Promise.all([reload("projects"), loadDir()]); render(); return true;
    });
}

// ---------------------------------------------------------------- summary by PM or customer
// One page per PM or customer: every active project's progress, schedule, next milestone, open issues,
// open requests and this week's update, one click into each project to update it.
function sumRow(p) {
  const c = calc(p), st = updateState(p), last = O.wu.filter(u => u.project_id === p.id).sort((a, b) => b.week_start.localeCompare(a.week_start))[0];
  const next = c.ms.find(m => !m.actual), iss = O.issues.filter(i => i.project_id === p.id && issOpen(i));
  const reqs = O.reqs.filter(r => r.project_id === p.id && reqOpen(r));
  const days = p.end_date ? dayDiff(TODAY, p.end_date) : null;
  const sched = c.lateDays ? "off_track" : last ? last.schedule_status : null;
  return {p, c, st, last, next, iss, late:iss.filter(issLate), reqs, days, sched};
}
function viewSummary() {
  const wrap = h("div", {class:"o-stack sum-page"});
  const S2 = O.sum, all = active().filter(p => p.phase !== "closed");
  const pms = [...new Set(all.map(p => p.pm_id).filter(Boolean))].sort((a, b) => personName(a).localeCompare(personName(b)));
  const custs = [...new Set(all.map(p => p.account_id).filter(Boolean))].sort((a, b) => (acctName(a) || "").localeCompare(acctName(b) || ""));
  if (!S2.id && role() === "pm") S2.id = S.me.id;
  const pick = S2.by === "pm" ? pms : custs, name = id => S2.by === "pm" ? personName(id) : acctName(id) || "Customer";
  const toolbar = h("div", {class:"toolbar no-print"}, h("h2", null, "Summary"),
    h("div", {class:"sections mp-modes", role:"group", "aria-label":"Summarize by"}, [["pm", "By PM"], ["customer", "By customer"]].map(([k, l]) =>
      h("button", {"aria-pressed":String(S2.by === k), onclick:() => { S2.by = k; S2.id = ""; render(); }}, l))),
    h("select", {class:"inp", style:"max-width:280px", "aria-label":S2.by === "pm" ? "Project manager" : "Customer", onchange: e => { S2.id = e.target.value; render(); }},
      h("option", {value:""}, S2.by === "pm" ? "Everyone (all PMs)" : "All customers"), pick.map(id => h("option", {value:id, selected:S2.id === id}, name(id) + " (" + all.filter(p => (S2.by === "pm" ? p.pm_id : p.account_id) === id).length + ")"))),
    S2.id ? h("button", {class:"btn small", onclick:() => window.print()}, "Print / PDF") : null);
  wrap.append(toolbar);
  if (!all.length) { wrap.append(h("div", {class:"panel"}, emptyState("No active projects", "Projects show here once handoffs are accepted."))); return wrap; }
  const money = role() !== "field";
  // overview: one line per PM or customer, click to drill in
  if (!S2.id) {
    const rows = pick.map(id => { const ps = all.filter(p => (S2.by === "pm" ? p.pm_id : p.account_id) === id).map(sumRow);
      return {id, ps, behind:ps.filter(r => r.sched === "off_track" || r.sched === "at_risk").length, iss:sum(ps, r => r.iss.length), late:sum(ps, r => r.late.length),
        reqs:sum(ps, r => r.reqs.length), missing:ps.filter(r => r.st.missing).length, total:sum(ps, r => r.c.total), avg:ps.length ? sum(ps, r => r.c.done) / ps.length : 0}; });
    const R = all.map(sumRow);
    wrap.append(h("div", {class:"o-tiles"}, tile("Active projects", String(all.length), plural(pick.length, S2.by === "pm" ? "PM" : "customer")),
      tile("Behind or at risk", String(R.filter(r => r.sched === "off_track" || r.sched === "at_risk").length), "", R.some(r => r.sched === "off_track") ? "bad" : ""),
      tile("Open issues", String(sum(R, r => r.iss.length)), sum(R, r => r.late.length) + " with an overdue next step", sum(R, r => r.late.length) ? "bad" : ""),
      tile("Updates missing", String(R.filter(r => r.st.missing).length), "this week", R.some(r => r.st.missing) ? "warn" : "")));
    wrap.append(panel(S2.by === "pm" ? "Everyone's projects" : "Customers", "Click a row for the full summary", h("div", {class:"tbl-wrap flat"}, h("table", null,
      h("thead", null, h("tr", null, h("th", null, S2.by === "pm" ? "Project manager" : "Customer"), h("th", {class:"num"}, "Projects"), money ? h("th", {class:"num"}, "Contract") : null,
        h("th", {class:"num"}, "Avg complete"), h("th", {class:"num"}, "Behind / at risk"), h("th", {class:"num"}, "Open issues"), h("th", {class:"num"}, "Requests open"), h("th", {class:"num"}, "Updates missing"))),
      h("tbody", null, rows.map(x => h("tr", {class:"click", tabindex:"0", onclick:() => { S2.id = x.id; render(); }, onkeydown: e => { if (e.key === "Enter") { S2.id = x.id; render(); } }},
        h("td", null, h("b", null, name(x.id))), h("td", {class:"num"}, String(x.ps.length)), money ? h("td", {class:"num"}, compact(x.total)) : null, h("td", {class:"num"}, pct(x.avg)),
        h("td", {class:"num" + (x.behind ? " warn-t" : "")}, x.behind ? String(x.behind) : "—"),
        h("td", {class:"num" + (x.late ? " bad-t" : "")}, x.iss ? x.iss + (x.late ? " (" + x.late + " overdue)" : "") : "—"),
        h("td", {class:"num"}, x.reqs ? String(x.reqs) : "—"), h("td", {class:"num" + (x.missing ? " warn-t" : "")}, x.missing ? String(x.missing) : "—"))))))));
    return wrap;
  }
  const R = all.filter(p => (S2.by === "pm" ? p.pm_id : p.account_id) === S2.id).map(sumRow)
    .sort((a, b) => (b.sched === "off_track") - (a.sched === "off_track") || b.late.length - a.late.length || (a.p.end_date || "9999").localeCompare(b.p.end_date || "9999"));
  const issues = R.flatMap(r => r.iss).sort(issSort), reqs = R.flatMap(r => r.reqs);
  const custReqs = S2.by === "customer" ? O.reqs.filter(r => r.account_id === S2.id && reqOpen(r) && !r.project_id) : [];
  wrap.append(h("div", {class:"sum-head"}, h("button", {class:"linkish back no-print", onclick:() => { S2.id = ""; render(); }}, S2.by === "pm" ? "← Everyone's projects" : "← All customers"),
    h("div", {class:"eyebrow"}, S2.by === "pm" ? "Project manager" : "Customer"), h("h2", null, name(S2.id)),
    h("div", {class:"muted small"}, "As of " + fmtDate(TODAY) + " · " + plural(R.length, "active project"))));
  wrap.append(h("div", {class:"o-tiles"},
    money ? tile("Contract value", compact(sum(R, r => r.c.total)), compact(sum(R, r => r.c.backlog)) + " left to earn") : null,
    tile("Average complete", pct(R.length ? sum(R, r => r.c.done) / R.length : 0), (n => n + (n === 1 ? " finishes" : " finish"))(R.filter(r => r.days != null && r.days >= 0 && r.days <= 30).length) + " in the next 30 days"),
    tile("Behind or at risk", String(R.filter(r => r.sched === "off_track" || r.sched === "at_risk").length), "from weekly updates and late milestones", R.some(r => r.sched === "off_track") ? "bad" : R.some(r => r.sched === "at_risk") ? "warn" : ""),
    tile("Open issues", String(issues.length), issues.filter(issLate).length + " with an overdue next step", issues.some(issLate) ? "bad" : ""),
    tile("Customer requests", String(reqs.length + custReqs.length), "open", reqs.concat(custReqs).some(r => r.status === "new") ? "warn" : ""),
    tile("This week's updates", (R.length - R.filter(r => r.st.missing || (!r.st.u && needsUpdate(r.p))).length) + " of " + R.filter(r => needsUpdate(r.p)).length, R.some(r => r.st.missing) ? plural(R.filter(r => r.st.missing).length, "missing") : "in", R.some(r => r.st.missing) ? "warn" : "")));
  wrap.append(panel("Projects", "Click a project to open and update it", h("div", {class:"tbl-wrap flat"}, h("table", {class:"sum-tbl"},
    h("thead", null, h("tr", null, h("th", null, "Project"), h("th", null, "Phase"), h("th", null, "Complete"), h("th", null, "Finish"), h("th", null, "Schedule"),
      h("th", null, "Next milestone"), h("th", null, "Open issues"), h("th", null, "Weekly update"), h("th", {class:"no-print"}, h("span", {class:"sr"}, "Actions")))),
    h("tbody", null, R.map(r => { const p = r.p, edit = canEdit(p);
      return h("tr", null,
        h("td", null, h("button", {class:"linkish", onclick:() => openProject(p.id)}, h("b", null, p.name)), h("div", {class:"muted small"}, p.number + " · " + (S2.by === "pm" ? acctName(p.account_id) || "" : personName(p.pm_id)))),
        h("td", null, phaseChip(p.phase)),
        h("td", {class:"nowrap"}, h("span", {class:"minibar inline"}, h("i", {class:"go", style:"width:" + Math.round(r.c.done * 100) + "%"})), " " + pct(r.c.done)),
        h("td", {class:"nowrap" + (r.days != null && r.days < 0 ? " bad-t" : "")}, p.end_date ? fmtDate(p.end_date) : "—", r.days != null ? h("div", {class:"muted small"}, r.days < 0 ? -r.days + " days past" : r.days + " days left") : null),
        h("td", null, r.sched ? stChip(r.sched) : h("span", {class:"muted"}, "No update yet"), r.c.lateDays ? h("div", {class:"bad-t small"}, r.c.late[0].name + " " + r.c.lateDays + "d late") : null),
        h("td", null, r.next ? [r.next.name, h("div", {class:"muted small" + (r.next.planned && r.next.planned < TODAY ? " bad-t" : "")}, r.next.planned ? fmtDate(r.next.planned) : "no date")] : h("span", {class:"muted"}, "—")),
        h("td", null, r.iss.length ? [h("b", {class:r.late.length ? "bad-t" : ""}, String(r.iss.length)), r.late.length ? h("span", {class:"bad-t small"}, " · " + r.late.length + " overdue") : null,
          h("div", {class:"muted small clamp1"}, r.iss.slice().sort(issSort)[0].title)] : h("span", {class:"muted"}, "—")),
        h("td", null, chip(r.st.cls, r.st.text)),
        h("td", {class:"no-print nowrap"}, edit && needsUpdate(p) ? h("button", {class:"btn small" + (r.st.u ? "" : " primary"), onclick:() => openUpdate(p, reportWeek())}, r.st.u ? "Edit update" : "Write update") : null,
          " ", canPlan(p) && featureOn("issues") ? h("button", {class:"btn small", onclick:() => openIssue(p, null)}, "+ Issue") : null));
    }))))));
  if (featureOn("issues")) wrap.append(panel("Open issues", plural(issues.length, "issue") + " across these projects", issueTable(issues, true)));
  if (featureOn("reqs") && (reqs.length || custReqs.length)) wrap.append(panel("Open customer requests", plural(reqs.length + custReqs.length, "request"),
    h("ul", {class:"sum-reqs"}, reqs.concat(custReqs).map(q => h("li", null, h("button", {class:"linkish", onclick:() => openRequest(q)}, reqRef(q) + " · " + q.title),
      h("span", {class:"muted small"}, " " + (proj(q.project_id).number || acctName(q.account_id) || "") + " · " + q.requester_name + " · " + reqAge(q)), " ", reqChip(q.status))))));
  return wrap;
}

// ---------------------------------------------------------------- issue log
// Problems to be solved on a project: date raised, issue, owner (RFIP person or someone outside),
// next step and when it's due; closing stamps the date. Shared ones show on the customer's pages.
const ISS_PRI = [["high", "High", "bad"], ["normal", "Normal", ""], ["low", "Low", ""]];
const issOpen = i => i.status !== "closed";
const issLate = i => issOpen(i) && !!i.next_step_due && i.next_step_due < TODAY;
const issOwner = i => i.owner_id ? personName(i.owner_id) : i.owner_name || "No owner";
const issuesOf = pid => O.issues.filter(i => i.project_id === pid);
const issSort = (a, b) => (issOpen(b) - issOpen(a)) || (issLate(b) - issLate(a)) || ((a.priority === "high" ? 0 : a.priority === "low" ? 2 : 1) - (b.priority === "high" ? 0 : b.priority === "low" ? 2 : 1))
  || (a.next_step_due || "9999").localeCompare(b.next_step_due || "9999") || a.opened_on.localeCompare(b.opened_on);
const issCanEdit = (p, i) => (p && p.id && canPlan(p)) || (i && i.owner_id === S.me.id);
function issueTable(list, showProject) {
  if (!list.length) return h("div", {class:"empty"}, "No issues here.");
  return h("div", {class:"tbl-wrap flat"}, h("table", {class:"exp-tbl iss-tbl"},
    h("thead", null, h("tr", null, h("th", null, "Opened"), showProject ? h("th", null, "Project") : null, h("th", null, "Issue"), h("th", null, "Owner"), h("th", null, "Next step"), h("th", null, "Status"))),
    h("tbody", null, list.map(i => {
      const p = byId(O.projects, i.project_id) || proj(i.project_id);
      const age = dayDiff(i.opened_on, issOpen(i) ? TODAY : i.closed_on || TODAY);
      return h("tr", {class:"click" + (issOpen(i) ? "" : " is-done"), tabindex:"0", onclick:() => openIssue(p, i), onkeydown: e => { if (e.key === "Enter") openIssue(p, i); }},
        h("td", {class:"mono nowrap"}, fmtDate(i.opened_on), h("div", {class:"muted small"}, "#" + i.ref)),
        showProject ? h("td", null, p.number || "—", h("div", {class:"muted small"}, p.name || "")) : null,
        h("td", null, i.priority === "high" && issOpen(i) ? chip("bad", "High") : null, " ", h("b", null, i.title),
          i.details ? h("div", {class:"muted small clamp2"}, i.details) : null, i.share_with_customer ? null : h("div", {class:"muted small"}, "Internal only")),
        h("td", null, issOwner(i), i.owner_name && !i.owner_id ? h("div", {class:"muted small"}, "outside RFIP") : null),
        h("td", null, issOpen(i) ? [i.next_step || h("span", {class:"muted"}, "No next step set"),
            i.next_step_due ? h("div", {class:"small mono" + (issLate(i) ? " bad-t" : "")}, (issLate(i) ? dayDiff(i.next_step_due, TODAY) + "d late · " : "by ") + fmtDate(i.next_step_due)) : null]
          : [i.resolution || h("span", {class:"muted"}, "—")]),
        h("td", {class:"nowrap"}, issOpen(i) ? [chip(issLate(i) ? "bad" : "warn", "Open"), h("div", {class:"muted small"}, age + (age === 1 ? " day" : " days"))]
          : [chip("go", "Closed"), h("div", {class:"muted small"}, fmtDate(i.closed_on) + " · " + age + "d")]));
    }))));
}
function issuePanel(p) {
  const all = issuesOf(p.id).sort(issSort), open = all.filter(issOpen), closed = all.filter(i => !issOpen(i));
  const late = open.filter(issLate).length;
  return panel("Issue log", open.length ? plural(open.length, "open issue") + (late ? " · " + late + " overdue" : "") : "No open issues",
    h("div", {class:"o-pad"},
      canPlan(p) ? h("div", {class:"o-actions", style:"border:0;padding:0 0 8px"}, h("button", {class:"btn small primary", onclick:() => openIssue(p, null)}, "+ Log an issue"),
        h("span", {class:"muted small"}, "Shared issues show on the customer's status page.")) : null,
      open.length ? issueTable(open, false) : h("div", {class:"empty"}, "Nothing open. Log problems to be solved here so they get an owner and a next step."),
      closed.length ? h("details", {class:"o-hist"}, h("summary", null, "Closed (" + closed.length + ")"), issueTable(closed, false)) : null));
}
function openIssue(p, it, preset) {
  const edit = issCanEdit(p, it), full = !!(p && p.id && canPlan(p));
  const d = it ? {...it, share:it.share_with_customer ? "yes" : "no"} : {opened_on:TODAY, priority:"normal", status:"open", share:"yes", ...(preset || {})};
  if (preset && preset.share_with_customer === false) d.share = "no";
  const before = it ? it.owner_id : null;
  const people = opsPeople().map(x => [x.id, x.full_name || x.email]);
  const fields = [
    fld(d, "title", "Issue", "text", {full:true, readonly:!full, placeholder:"e.g. Ceiling access blocked in IDF 3"}),
    fld(d, "details", "Details", "textarea", {full:true, readonly:!full}),
    fld(d, "opened_on", "Date raised", "date", {readonly:!full}),
    fld(d, "priority", "Priority", "select", {options:ISS_PRI.map(x => [x[0], x[1]]), blank:false, readonly:!full}),
    fld(d, "owner_id", "Owner at RFIP", "select", {options:people, blank:"Not RFIP / not set", readonly:!full}),
    fld(d, "owner_name", "…or owner outside RFIP", "text", {readonly:!full, placeholder:"e.g. AutoNation IT, GC, vendor"}),
    fld(d, "next_step", "Next step", "text", {full:true, readonly:!edit, placeholder:"e.g. GC to open ceiling Tuesday; we re-pull Wednesday"}),
    fld(d, "next_step_due", "Next step due", "date", {readonly:!edit}),
    fld(d, "status", "Status", "select", {options:[["open", "Open"], ["closed", "Closed"]], blank:false, readonly:!edit}),
    fld(d, "resolution", "How it was resolved (when closing)", "textarea", {full:true, readonly:!edit}),
    featureOn("clinks") ? fld(d, "share", "Customer sees it?", "select", {options:[["yes", "Yes, show on their status page"], ["no", "No, internal only"]], blank:false, readonly:!full}) : null,
    it && it.closed_on ? h("p", {class:"muted small", style:"grid-column:1/-1;margin:0"}, "Closed " + fmtDate(it.closed_on) + " · open " + dayDiff(it.opened_on, it.closed_on) + " days") : null,
    !full && edit ? h("p", {class:"muted small", style:"grid-column:1/-1;margin:0"}, "You own this issue, so you can update the next step and close it.") : null].filter(Boolean);
  drawerForm((it ? "Issue #" + it.ref : "Log an issue") + " · " + (p.number || ""), d, fields, async () => {
    if (!edit) return true;
    const t = k => nullify(((d[k] || "") + "").trim());
    let row;
    if (full) {
      if (!(d.title || "").trim()) { toast("Describe the issue."); return false; }
      row = {project_id:p.id, title:d.title.trim(), details:t("details"), opened_on:d.opened_on || TODAY, priority:d.priority || "normal",
        owner_id:nullify(d.owner_id), owner_name:d.owner_id ? null : t("owner_name"), next_step:t("next_step"), next_step_due:nullify(d.next_step_due),
        status:d.status || "open", resolution:t("resolution"), share_with_customer:d.share !== "no"};
      if (!it && d.request_id) row.request_id = d.request_id;
    } else row = {next_step:t("next_step"), next_step_due:nullify(d.next_step_due), status:d.status || "open", resolution:t("resolution")};
    if (row.status === "closed" && (!it || it.status !== "closed") && !row.resolution) { toast("Add a line on how it was resolved."); return false; }
    const res = await saveRow("project_issues", row, it && it.id);
    if (res && row.owner_id && row.owner_id !== S.me.id && row.owner_id !== before)
      tell([row.owner_id], "Issue on " + p.number + " assigned to you: " + row.title, (S.me.full_name || S.me.email) + " made you the owner of an issue on " + p.number + " " + p.name + ":\n\n" + row.title +
        (row.details ? "\n\n" + row.details : "") + (row.next_step ? "\n\nNext step: " + row.next_step + (row.next_step_due ? " (by " + fmtDate(row.next_step_due) + ")" : "") : ""), "#project=" + p.id);
    return res;
  }, it && canEdit(p) ? del("project_issues", it.id) : null);
}
function viewIssues() {
  const wrap = h("div", {class:"o-stack"});
  const v = O.issView, dp = O.issDept;
  const inDept = i => { const p = byId(O.projects, i.project_id) || proj(i.project_id); return !dp || p.department === dp; };
  const pool = O.issues.filter(inDept);
  const open = pool.filter(issOpen), late = open.filter(issLate);
  const closed30 = pool.filter(i => !issOpen(i) && i.closed_on >= addDays(TODAY, -30));
  const avgClose = closed30.length ? Math.round(sum(closed30, i => dayDiff(i.opened_on, i.closed_on)) / closed30.length) : null;
  const list = (v === "open" ? open : v === "late" ? late : v === "mine" ? open.filter(i => i.owner_id === S.me.id) : v === "high" ? open.filter(i => i.priority === "high")
    : v === "closed" ? closed30 : pool).slice().sort(issSort);
  const editable = O.projects.filter(p => p.phase !== "closed" && canPlan(p));
  wrap.append(h("div", {class:"toolbar"}, h("h2", null, "Issue log"),
    h("select", {class:"inp", style:"max-width:220px", "aria-label":"Show", onchange: e => { O.issView = e.target.value; render(); }},
      [["open", "Open"], ["late", "Next step overdue"], ["high", "High priority"], ["mine", "I own"], ["closed", "Closed, last 30 days"], ["all", "All"]].map(([k, t]) => h("option", {value:k, selected:v === k}, t))),
    role() !== "pm" && role() !== "field" ? h("select", {class:"inp", style:"max-width:180px", "aria-label":"Department", onchange: e => { O.issDept = e.target.value; render(); }},
      h("option", {value:""}, "All departments"), deptKeys().map(k => h("option", {value:k, selected:dp === k}, k))) : null,
    editable.length ? h("select", {class:"inp", style:"max-width:260px", "aria-label":"Log an issue on", onchange: e => { const p = byId(O.projects, e.target.value); e.target.value = ""; if (p) openIssue(p, null); }},
      h("option", {value:""}, "+ Log an issue on…"), editable.map(p => h("option", {value:p.id}, p.number + " · " + p.name))) : null));
  wrap.append(h("div", {class:"o-tiles"},
    tile("Open", String(open.length), plural(new Set(open.map(i => i.project_id)).size, "project")),
    tile("Next step overdue", String(late.length), "", late.length ? "bad" : ""),
    tile("High priority", String(open.filter(i => i.priority === "high").length), "", open.some(i => i.priority === "high") ? "warn" : ""),
    tile("Closed, last 30 days", String(closed30.length), avgClose == null ? "" : "avg " + avgClose + " days to close")));
  wrap.append(panel(({open:"Open issues", late:"Next step overdue", high:"High priority", mine:"Issues you own", closed:"Closed in the last 30 days", all:"All issues"})[v], plural(list.length, "issue"),
    list.length ? issueTable(list, true) : h("div", {class:"empty"}, O.issues.length ? "Nothing here." : "No issues logged yet. Log them on a project page (Issue log) or with + Log an issue on…")));
  return wrap;
}

// ---------------------------------------------------------------- customer requests
// Customers submit work from their dashboard link (customer.html?a=…); it lands here. They see the status
// and the "message to customer" on their dashboard; everything else stays internal.
const REQ_ST = [["new", "New", "bad", "Received"], ["reviewing", "Reviewing", "acc", "Under review"], ["quoted", "Quote sent", "warn", "Quote sent"],
  ["scheduled", "Scheduled", "go", "Scheduled"], ["done", "Done", "go", "Complete"], ["declined", "Declined / closed", "", "Closed"]];
const REQ_KIND = [["issue", "Issue on a project"], ["change", "Change to a project"], ["rfi", "RFI (question)"], ["new_work", "New project / install"], ["service", "Service call / repair"], ["survey", "Site survey / quote"], ["other", "Question / other"]];
const reqSt = s => REQ_ST.find(x => x[0] === s) || REQ_ST[0];
const reqChip = s => { const x = reqSt(s); return chip(x[2], x[1]); };
const reqOpen = r => !["done", "declined"].includes(r.status);
const canWorkReqs = () => ["admin", "lead", "pm"].includes(role());
const seesReqs = () => featureOn("reqs") && (["admin", "lead", "pm", "viewer"].includes(role()) || O.reqs.length > 0);
const newReqs = () => O.reqs.filter(r => r.status === "new").length;
const reqRef = r => "R-" + r.ref;
const reqAge = r => { const d = dayDiff((r.created_at || "").slice(0, 10), TODAY); return d <= 0 ? "today" : d === 1 ? "yesterday" : d + " days ago"; };
function viewRequests() {
  const wrap = h("div", {class:"o-stack"});
  const v = O.reqView, dp = O.reqDept;
  const pool = O.reqs.filter(r => !dp || (dp === "none" ? !r.department : r.department === dp));
  const list = pool.filter(r => v === "open" ? reqOpen(r) : v === "new" ? r.status === "new" : v === "mine" ? r.assigned_to === S.me.id && reqOpen(r) : true)
    .sort((a, b) => (b.urgent && reqOpen(b)) - (a.urgent && reqOpen(a)) || (a.status === "new" ? 0 : 1) - (b.status === "new" ? 0 : 1) || b.created_at.localeCompare(a.created_at));
  wrap.append(h("div", {class:"toolbar"}, h("h2", null, "Customer requests"),
    h("select", {class:"inp", style:"max-width:200px", "aria-label":"Show", onchange: e => { O.reqView = e.target.value; render(); }},
      [["open", "Open"], ["new", "New, not picked up"], ["mine", "Assigned to me"], ["all", "All, incl. closed"]].map(([k, t]) => h("option", {value:k, selected:v === k}, t))),
    h("select", {class:"inp", style:"max-width:200px", "aria-label":"Department", onchange: e => { O.reqDept = e.target.value; render(); }},
      h("option", {value:""}, "All departments"), deptKeys().map(k => h("option", {value:k, selected:dp === k}, k)), h("option", {value:"none", selected:dp === "none"}, "Not sure (unsorted)")),
    canWorkReqs() ? h("button", {class:"btn primary", onclick:() => openRequest(null)}, "+ Log a request") : null));
  const open = pool.filter(reqOpen);
  wrap.append(h("div", {class:"o-tiles"},
    tile("New", String(pool.filter(r => r.status === "new").length), "not picked up yet", pool.some(r => r.status === "new") ? "bad" : ""),
    tile("Urgent & open", String(open.filter(r => r.urgent).length), "", open.some(r => r.urgent) ? "bad" : ""),
    tile("Open", String(open.length), "reviewing, quoted or scheduled"),
    tile("Done, last 30 days", String(pool.filter(r => r.status === "done" && (r.updated_at || "").slice(0, 10) >= addDays(TODAY, -30)).length))));
  if (!O.reqs.length) {
    wrap.append(h("div", {class:"panel"}, emptyState("No customer requests yet",
      "Customers send requests from their dashboard link (Customer → Customer dashboard). Requests that come in by phone or email can be logged here with + Log a request.")));
    return wrap;
  }
  if (!list.length) { wrap.append(h("div", {class:"panel"}, emptyState("Nothing here", "Try another filter."))); return wrap; }
  wrap.append(h("div", {class:"tbl-wrap"}, h("table", {class:"exp-tbl req-tbl"},
    h("thead", null, h("tr", null, h("th", null, "Request"), h("th", null, "Customer and site"), h("th", null, "Type"), h("th", null, "Needed by"),
      h("th", null, "Assigned"), h("th", null, "Status"))),
    h("tbody", null, list.map(r => h("tr", {class:"click", tabindex:"0", onclick:() => openRequest(r), onkeydown: e => { if (e.key === "Enter") openRequest(r); }},
      h("td", null, h("div", null, h("b", {class:"mono"}, reqRef(r)), " ", r.title), h("div", {class:"muted small"}, "From " + r.requester_name + " · " + reqAge(r))),
      h("td", null, h("div", null, acctName(r.account_id) || "—"), h("div", {class:"muted small"}, [r.site, r.address].filter(Boolean).join(" · ") || "")),
      h("td", null, (REQ_KIND.find(x => x[0] === r.kind) || REQ_KIND[6])[1], h("div", {class:"muted small"}, r.department || "Dept not set")),
      h("td", {class:"mono nowrap"}, r.needed_by ? fmtDate(r.needed_by) : "—"),
      h("td", null, r.assigned_to ? personName(r.assigned_to) : h("span", {class:"muted"}, "Nobody yet")),
      h("td", null, r.urgent && reqOpen(r) ? chip("bad", "Urgent") : null, " ", reqChip(r.status))))))));
  return wrap;
}
function openRequest(r) {
  if (typeof r === "string") { const found = byId(O.reqs, r); if (!found) { toast("That request isn't available to you."); return; } r = found; }
  const edit = canWorkReqs() || (r && r.assigned_to === S.me.id), isNew = !r;
  const d = r ? {...r, urgent: r.urgent ? "yes" : ""} : {kind:"new_work", status:"reviewing", urgent:"", source:"internal"};
  const before = r ? r.assigned_to : null;
  const acctProjects = () => O.projects.filter(p => p.account_id === d.account_id).sort((a, b) => b.number.localeCompare(a.number)).map(p => [p.id, p.number + " · " + p.name]);
  const acctDeals = () => (S.deals || []).filter(x => x.account_id === d.account_id).map(x => [x.id, x.name]);
  const projBox = h("div", {style:"display:contents"}), dealBox = h("div", {style:"display:contents"});
  const drawLinks = () => {
    const ps = acctProjects(); if (d.project_id && !ps.some(x => x[0] === d.project_id)) ps.unshift([d.project_id, (proj(d.project_id).number || "Project") + " · " + (proj(d.project_id).name || "")]);
    projBox.replaceChildren(fld(d, "project_id", "Project", "select", {options:ps, blank:d.account_id ? "None" : "Pick a customer first", readonly:!edit}));
    const ds = acctDeals(); if (d.deal_id && !ds.some(x => x[0] === d.deal_id)) ds.unshift([d.deal_id, "Linked deal"]);
    dealBox.replaceChildren(S.deals ? fld(d, "deal_id", "Deal / quote", "select", {options:ds, blank:"None", readonly:!edit}) : h("div"));
  };
  drawLinks();
  const fromCustomer = r && r.source === "portal";
  const info = fromCustomer ? h("div", {class:"full", style:"grid-column:1/-1"},
    h("div", {class:"req-sent"},
      h("div", {class:"muted small"}, "Sent " + fmtDateTime(r.created_at) + " from " + (acctName(r.account_id) || "the customer") + "'s dashboard"),
      h("h3", {style:"margin:4px 0 6px"}, r.urgent ? chip("bad", "Urgent") : null, " ", r.title),
      h("div", {class:"small"}, (REQ_KIND.find(x => x[0] === r.kind) || REQ_KIND[6])[1] + " · " + (r.department || "Not sure which department") +
        (r.site || r.address ? " · " + [r.site, r.address].filter(Boolean).join(" · ") : "") + (r.needed_by ? " · Needed by " + fmtDate(r.needed_by) : "")),
      r.details ? h("p", {class:"pre", style:"white-space:pre-wrap;margin:8px 0"}, r.details) : null,
      h("div", {class:"small"}, h("b", null, r.requester_name), " · ", h("a", {href:"mailto:" + r.requester_email + "?subject=" + encodeURIComponent(reqRef(r) + ": " + r.title)}, r.requester_email),
        r.requester_phone ? [" · ", h("a", {href:"tel:" + r.requester_phone.replace(/[^\d+]/g, "")}, r.requester_phone)] : null))) : null;
  const fields = [info,
    !fromCustomer ? fld(d, "account_id", "Customer", "select", {options:(S.accounts || []).slice().sort((a, b) => a.name.localeCompare(b.name)).map(a => [a.id, a.name]), blank:"Pick a customer", full:true, readonly:!isNew, onchange: drawLinks}) : null,
    !fromCustomer ? fld(d, "title", "What they need", "text", {full:true, readonly:!edit, placeholder:"e.g. 12 new cameras at the Edmond store"}) : null,
    !fromCustomer ? fld(d, "kind", "Type", "select", {options:REQ_KIND, blank:false, readonly:!edit}) : null,
    !fromCustomer ? fld(d, "urgent", "Urgent?", "select", {options:[["yes", "Yes, urgent"]], blank:"No", readonly:!edit}) : null,
    !fromCustomer ? fld(d, "requester_name", "Customer contact", "text", {readonly:!edit}) : null,
    !fromCustomer ? fld(d, "requester_email", "Contact email", "email", {readonly:!edit}) : null,
    !fromCustomer ? fld(d, "requester_phone", "Contact phone", "tel", {readonly:!edit}) : null,
    !fromCustomer ? fld(d, "site", "Site or store", "text", {readonly:!edit}) : null,
    !fromCustomer ? fld(d, "address", "Site address", "text", {readonly:!edit}) : null,
    !fromCustomer ? fld(d, "needed_by", "Needed by", "date", {readonly:!edit}) : null,
    !fromCustomer ? fld(d, "details", "Details", "textarea", {full:true, readonly:!edit}) : null,
    h("div", {class:"section-h", style:"grid-column:1/-1;margin-top:8px"}, "RFIP's handling"),
    fld(d, "status", "Status", "select", {options:REQ_ST.map(x => [x[0], x[1] + (x[3] !== x[1] ? " (customer sees “" + x[3] + "”)" : "")]), blank:false, readonly:!edit}),
    fld(d, "assigned_to", "Assigned to", "select", {options:opsPeople().map(x => [x.id, x.full_name || x.email]), blank:"Nobody yet", readonly:!canWorkReqs()}),
    fld(d, "department", "Department", "select", {options:deptKeys(), blank:"Not sure", readonly:!edit}),
    projBox, dealBox,
    fld(d, "customer_note", "Message to the customer (shows on their dashboard)", "textarea", {full:true, readonly:!edit}),
    fld(d, "internal_note", "Internal notes (RFIP only)", "textarea", {full:true, readonly:!edit}),
    r && r.project_id && featureOn("issues") && byId(O.projects, r.project_id) && canPlan(byId(O.projects, r.project_id)) && ["issue", "change", "rfi"].includes(r.kind) ? h("div", {style:"grid-column:1/-1"},
      h("button", {class:"btn small", type:"button", onclick:() => { const pj = byId(O.projects, r.project_id); closeDrawer();
        openIssue(pj, null, {title:r.title, details:[r.details, "From " + reqRef(r) + " · " + r.requester_name].filter(Boolean).join("\n\n"), request_id:r.id, opened_on:(r.created_at || "").slice(0, 10) || TODAY,
          priority:r.urgent ? "high" : "normal"}); }},
        O.issues.some(i => i.request_id === r.id) ? "Add another issue-log entry" : "Add to " + byId(O.projects, r.project_id).number + "'s issue log"),
      O.issues.some(i => i.request_id === r.id) ? h("span", {class:"muted small", style:"margin-left:8px"}, "Already on the issue log") : null) : null,
    r && !r.deal_id && S.deals && core.openDeal && edit && (isAdmin() || S.me.sales_access !== false) ? h("div", {style:"grid-column:1/-1"}, h("button", {class:"btn small", type:"button", onclick:() => {
      closeDrawer(); core.openDeal(null, null, {stage:"lead", services:[], owner_id:S.me.id, gng:{scores:{}}, account_id:r.account_id, name:(r.site ? r.site + " – " : "") + r.title,
        source:"Customer request " + reqRef(r), description:[reqRef(r) + " from " + r.requester_name + " <" + r.requester_email + ">", r.details || ""].filter(Boolean).join("\n\n")});
      toast("After you save the deal, link it on " + reqRef(r) + ".");
    }}, "Start a deal from this request"), h("span", {class:"muted small", style:"margin-left:8px"}, "Then pick it under Deal / quote here.")) : null].filter(Boolean);
  const save = async () => {
    const txt = k => nullify((d[k] || "").trim ? (d[k] || "").trim() : d[k]);
    let row;
    if (!edit) return true;
    row = {status:d.status, assigned_to:nullify(d.assigned_to), department:nullify(d.department), project_id:nullify(d.project_id), deal_id:nullify(d.deal_id),
      customer_note:txt("customer_note"), internal_note:txt("internal_note")};
    if (!canWorkReqs()) delete row.assigned_to;
    if (!fromCustomer) {
      if (!d.account_id) { toast("Pick the customer."); return false; }
      if (!(d.title || "").trim()) { toast("Say what they need."); return false; }
      if (!(d.requester_name || "").trim()) { toast("Add the customer contact's name."); return false; }
      Object.assign(row, {title:d.title.trim(), kind:d.kind || "new_work", urgent:d.urgent === "yes", requester_name:d.requester_name.trim(), requester_email:(d.requester_email || "").trim(),
        requester_phone:txt("requester_phone"), site:txt("site"), address:txt("address"), needed_by:nullify(d.needed_by), details:txt("details")});
      if (isNew) Object.assign(row, {account_id:d.account_id, source:"internal"});
    }
    const res = await saveRow("customer_requests", row, r && r.id);
    if (res && row.assigned_to && row.assigned_to !== S.me.id && row.assigned_to !== before) {
      const x = res;
      tell([row.assigned_to], "Customer request " + reqRef(x) + " assigned to you: " + x.title, (S.me.full_name || S.me.email) + " assigned you a customer request from " +
        (acctName(x.account_id) || "a customer") + ":\n\n" + x.title + (x.details ? "\n\n" + x.details : "") + "\n\nContact: " + x.requester_name + (x.requester_email ? " · " + x.requester_email : "") +
        (x.requester_phone ? " · " + x.requester_phone : ""), "#request=" + x.id);
    }
    return res;
  };
  drawerForm(isNew ? "Log a customer request" : reqRef(r) + " · " + (acctName(r.account_id) || "Customer request"), d, fields, save,
    r && isAdmin() ? del("customer_requests", r.id) : null);
}
const VIEW_FN = {"ops-updates":viewUpdates, "ops-overview":viewOverview, "ops-projects":viewProjects, "ops-project":viewProject, "ops-handoffs":viewHandoffs, "ops-billing":viewBilling, "ops-manpower":viewManpower, "ops-tasks":viewTasks, "ops-expenses":viewExpenses, "ops-requests":viewRequests, "ops-issues":viewIssues, "ops-timeline":viewTimeline, "ops-summary":viewSummary, handoffs:viewHandoffs};
return {
  tables: Object.values(TABLES),
  load, changed,
  available: () => !O.missing && !!role(),
  departments: () => deptKeys().length ? deptKeys() : ["Tower", "DAS", "Network", "DataComm", "Security"],
  views: () => {
    const r = role();
    const mp = O.techs.length || role() === "admin" ? [["ops-manpower", r === "field" ? "Schedule" : "Manpower"]] : [];
    const tl = ["admin", "viewer", "lead", "pm"].includes(r) ? [["ops-timeline", "Timeline"]] : [];
    const sm = r === "field" ? [] : [["ops-summary", "Summary"]];
    const myOpen = O.items.filter(i => i.assignee_id === S.me.id && i.status !== "done").length, waiting = waitingOnMe().length;
    const tk = featureOn("items") ? [["ops-tasks", "My tasks" + (myOpen ? " (" + myOpen + ")" : "")]] : [];
    const ex = featureOn("exps") ? [["ops-expenses", "Expenses" + (waiting ? " (" + waiting + ")" : "")]] : [];
    const myIss = O.issues.filter(i => issOpen(i) && i.owner_id === S.me.id).length;
    const is = featureOn("issues") && (r !== "field" || O.issues.length) ? [["ops-issues", "Issues" + (myIss ? " (" + myIss + " yours)" : "")]] : [];
    const rq = seesReqs() ? [["ops-requests", "Requests" + (newReqs() ? " (" + newReqs() + " new)" : "")]] : [];
    if (r === "field") return [["ops-projects", "My projects"], ...tk, ...is, ...mp, ...ex, ...rq];
    if (r === "pm") return [["ops-projects", "My projects"], ...sm, ...rq, ...is, ...tk, ["ops-updates", "Weekly updates"], ...tl, ...mp, ...ex, ["ops-handoffs", "Handoffs"], ["ops-billing", "Billing"]];
    return [["ops-overview", "Overview"], ["ops-projects", "Projects"], ...sm, ...rq, ...is, ...tk, ["ops-updates", "Weekly updates"], ...tl, ...mp, ...ex, ["ops-handoffs", "Handoffs"], ["ops-billing", "Billing"]];
  },
  salesViews: () => O.missing ? [] : [["handoffs", "Handoffs"], ...(!role() && featureOn("exps") ? [["ops-expenses", "Expenses" + (waitingOnMe().length ? " (" + waitingOnMe().length + ")" : "")]] : [])],
  hiddenViews: () => ["ops-project"],
  parentView: v => v === "ops-project" ? "ops-projects" : null,
  owns: v => v in VIEW_FN,
  render: v => (VIEW_FN[v] || viewOverview)(),
  strip,
  openProject: id => { openProject(id); render(); },
  openRequest: id => { go("ops-requests"); openRequest(id); },
  startExpense: () => { if (featureOn("exps")) { go("ops-expenses"); startExpense(); } },
  openExpense: id => { go("ops-expenses"); openExpenseById(id); },
};
};
