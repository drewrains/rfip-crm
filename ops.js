/* RFIP Operations — the delivery side of the app: projects, the sales-to-ops
   handoff, budgets and labor, schedule, change orders, materials, field logs,
   crews, closeout, billing and safety. Plugs into app.js, which calls
   RFIP_OPS_INIT with its shared helpers. The database's row-level security
   decides what each person sees; these screens only arrange it. */
window.RFIP_OPS_INIT = core => {
"use strict";
const {h, sb, S, money, fmtDate, daysUntil, todayStr, run, toast, friendly, openDrawer, closeDrawer, fld, deleteButton,
  render, go, person, personName, activePeople, isAdmin, byId, acctName, emptyState, plural, nullify} = core;

// ---------------------------------------------------------------- data
const TABLES = {projects:"projects", handoffs:"handoffs", depts:"departments", costs:"cost_lines", labor:"labor_weeks", ms:"milestones",
  cos:"change_orders", mats:"materials", logs:"daily_logs", plan:"crew_plan", roster:"crew_roster", closeout:"closeout_items",
  bills:"billings", safety:"safety_events", techs:"techs", asg:"assignments", docs:"documents", wu:"weekly_updates"};
const KEY_OF = Object.fromEntries(Object.entries(TABLES).map(([k, t]) => [t, k]));
const O = {missing:false, detail:null, q:"", dept:"", pm:"", phase:"active", hand:true, mpMode:"week", mpDate:null, mpDept:""};
try { const m = localStorage.getItem("rfipops.mpMode"); if (m) O.mpMode = m; } catch (e) {}
for (const k of Object.keys(TABLES)) O[k] = [];
O.dir = []; O.docFolder = ""; O.wuWeek = null;
try { const d = localStorage.getItem("rfipops.detail"); if (d) O.detail = d; } catch (e) {}

async function fetchTable(key) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const {data, error} = await sb.from(TABLES[key]).select("*").range(from, from + 999);
    if (error) { if (error.code === "42P01" || /does not exist|schema cache/i.test(error.message || "")) O.missing = true; return out; }
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}
async function reload(key) { O[key] = await fetchTable(key); CALC.clear(); }
async function load() {
  await reload("depts");
  if (O.missing) return;
  await Promise.all(Object.keys(TABLES).filter(k => k !== "depts").map(reload).concat([loadDir()]));
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
  const budCost = hb * rate + nlBud, fcCost = projH * rate + nlFc;
  const bills = O.bills.filter(b => b.project_id === p.id);
  const billed = sum(bills.filter(b => b.kind === "billed"), b => b.amount);
  const earned = total * done;
  const ms = O.ms.filter(m => m.project_id === p.id).sort((a, b) => (a.planned || "").localeCompare(b.planned || "") || a.sort - b.sort);
  const late = ms.filter(m => !m.actual && m.planned && daysUntil(m.planned) < -5);
  const mats = O.mats.filter(m => m.project_id === p.id);
  const closeout = O.closeout.filter(c => c.project_id === p.id).sort((a, b) => a.sort - b.sort);
  const roster = scheduleRoster(p.id);
  const staffed = new Set(O.asg.filter(a => a.project_id === p.id && a.work_date >= TODAY && a.work_date <= addDays(TODAY, 14)).map(a => a.tech_id)).size;
  const r = {
    cos, coAppr, coPend, unpriced, total, done, lw, hu, hb, rate, projH, cl, nlBud, nlFc, nlAct, budCost, fcCost,
    estM: total ? (total - budCost) / total : 0, fcM: total ? (total - fcCost) / total : 0, fade: fcCost - budCost,
    bills, billed, earned, ready: Math.max(0, earned - billed), backlog: Math.max(0, total - earned), left: Math.max(0, total - billed),
    retH: billed * (Number(p.retainage_pct) || 0) / 100,
    earnH: done * hb, burn: hb ? hu / hb : 0, prod: hu > 0 && done > .05 ? (done * hb) / hu : null,
    ms, late, lateDays: late.length ? Math.max(...late.map(m => -daysUntil(m.planned))) : 0,
    mats, matOpen: mats.filter(m => m.status !== "received"), backordered: mats.filter(m => m.status === "backordered"),
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
  el.hidden = S.view === "ops-overview" || S.view === "ops-manpower";
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
        h("td", null, h("b", null, p.name), h("div", {class:"muted small"}, p.number + " · " + (acctName(p.account_id) || ""))),
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
  wrap.append(h("div", {class:"o-crm"}, h("span", {class:"k"}, "From the CRM"),
    h("span", null, "Sold by ", h("b", null, personName(p.sold_by || (deal && deal.owner_id)))),
    deal && deal.close_date ? h("span", null, "Won ", h("b", null, fmtDate(deal.close_date)), " at ", h("b", {class:"mono"}, compact(deal.value))) : null,
    p.sold_margin != null && money ? h("span", null, "Margin at handoff ", h("b", {class:"mono"}, Number(p.sold_margin).toFixed(0) + "%")) : null,
    ho && ho.accepted_at ? h("span", null, "Accepted ", h("b", null, fmtDate(ho.accepted_at.slice(0, 10))), ho.kickbacks ? " after " + plural(ho.kickbacks, "kick-back") : "") : null,
    deal ? h("button", {class:"linkish", onclick:() => core.openDeal(deal.id)}, "Open deal") : null,
    ho ? h("button", {class:"linkish", onclick:() => openHandoff(ho.id)}, "Handoff packet") : null));

  wrap.append(h("div", {class:"o-tiles"},
    money ? tile("Contract", compact(c.total), compact(p.contract_value) + " original" + (c.coAppr ? " + " + compact(c.coAppr) + " approved COs" : "")) : null,
    tile("Complete vs schedule", pct(c.done), c.elapsed == null ? "" : pct(c.elapsed) + " of schedule elapsed", c.elapsed != null && c.done < c.elapsed - .1 ? "warn" : ""),
    tile("Labor hours used", pct(c.burn), num(c.hu) + " of " + num(c.hb) + " budgeted", c.burn >= .8 && c.done < .8 ? "bad" : ""),
    money ? tile("Margin forecast", pct(c.fcM), (c.fcM < c.estM - .005 ? "Down from " : "Budget ") + pct(c.estM), c.fcM < c.estM - .02 ? "bad" : "") : null,
    money ? tile("Ready to bill", compact(c.ready), "Billed " + compact(c.billed) + " · " + compact(c.retH) + " retainage held") : null));

  if (opsView && role() !== "field" || O.wu.some(u => u.project_id === p.id)) wrap.append(updatePanel(p, c, edit));
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
  if (opsView) wrap.append(h("div", {class:"o-two even"}, coPanel(p, c, edit, money), matPanel(p, c, edit)));
  wrap.append(h("div", {class:"o-two even"}, opsView && role() !== "field" ? logPanel(p) : null, h("div", {class:"o-stack"}, rosterPanel(p, c, edit), closeoutPanel(p, c, edit))));
  if (opsView) wrap.append(docsPanel(p));
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
      const late = m.actual ? daysUntil(m.actual) - daysUntil(m.planned) : (m.planned && daysUntil(m.planned) < 0 ? -daysUntil(m.planned) : 0);
      const st = m.actual ? (late > 0 ? "late" : "done") : (m.progress ? "now" : late > 5 ? "overdue" : "");
      return h("li", {class: edit ? "click" : null, onclick: edit ? () => openMilestone(p, m) : null},
        h("span", {class:"dot " + st}),
        h("div", null, h("div", {class:"t"}, m.name), m.note ? h("small", null, m.note) : null,
          !m.actual && late > 5 ? h("small", {class:"bad-t"}, late + " days past plan") : null,
          m.progress && !m.actual ? h("div", {class:"prog"}, h("i", {style:"width:" + Math.min(100, m.progress) + "%"})) : null),
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
      c.cl.map(l => row(l.label, Number(l.budget), l.committed == null ? null : Number(l.committed), Number(l.actual), Number(l.forecast ?? l.budget), edit ? () => openCost(p, l) : null))),
    h("tfoot", null, h("tr", null, h("td", null, h("b", null, "Total cost")), h("td", {class:"num"}, money(c.budCost)), h("td"), h("td", {class:"num"}, money(laborAct + c.nlAct)), h("td", {class:"num"}, money(c.fcCost)),
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
const MAT_ST = [["to_order", "To order", "warn"], ["ordered", "Ordered", ""], ["partial", "Partial", "acc"], ["received", "Received", "go"], ["backordered", "Backordered", "bad"]];
function matPanel(p, c, edit) {
  return panel("Materials", plural(c.matOpen.length, "line") + " still open",
    c.mats.length ? h("div", {class:"tbl-wrap flat"}, h("table", null,
      h("thead", null, h("tr", null, h("th", null, "Item"), h("th", {class:"num"}, "Received"), h("th", null, "Status"))),
      h("tbody", null, c.mats.slice().sort((a, b) => MAT_ST.findIndex(s => s[0] === b.status) - MAT_ST.findIndex(s => s[0] === a.status)).map(m => { const st = MAT_ST.find(s => s[0] === m.status) || MAT_ST[1];
        return h("tr", {class: edit ? "click" : null, onclick: edit ? () => openMat(p, m) : null},
          h("td", {class:"wrap"}, m.item, m.note || m.eta ? h("div", {class:"muted small"}, [m.eta && m.status !== "received" ? "ETA " + fmtDate(m.eta) : null, m.note].filter(Boolean).join(" · ")) : null),
          h("td", {class:"num"}, num(m.received) + " / " + num(m.qty)), h("td", null, chip(st[2], st[1]))); }))))
      : h("div", {class:"empty"}, "No materials listed."),
    edit ? h("div", {class:"o-actions"}, h("button", {class:"btn small", onclick:() => openMat(p)}, "+ Material")) : null);
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
function openProgress(p) {
  const d = {pct_complete:Number(p.pct_complete), phase:p.phase, start_date:p.start_date, end_date:p.end_date, pm_id:p.pm_id, notes:p.notes || ""};
  const pms = activePeople().filter(x => x.ops_role === "pm" || x.ops_role === "lead" || x.id === p.pm_id).map(x => [x.id, x.full_name || x.email]);
  drawerForm("Update " + p.number, d, [
    fld(d, "pct_complete", "Percent complete (0–100)", "number"),
    fld(d, "phase", "Phase", "select", {options:PHASES.map(x => [x[0], x[1]]), blank:false}),
    fld(d, "start_date", "Start", "date"), fld(d, "end_date", "Substantial completion", "date"),
    fld(d, "pm_id", "Project manager", "select", {options:pms, blank:false, readonly: role() === "pm"}),
    fld(d, "notes", "Notes", "textarea", {full:true}),
    h("p", {class:"muted small", style:"grid-column:1/-1;margin:0"}, "Percent complete drives earned hours, earned revenue and the margin forecast. Update it at least weekly.")],
    () => { const v = Number(d.pct_complete); if (!(v >= 0 && v <= 100)) { toast("Percent complete must be between 0 and 100."); return false; }
      return saveRow("projects", {pct_complete:v, phase:d.phase, start_date:nullify(d.start_date), end_date:nullify(d.end_date), pm_id:d.pm_id, notes:nullify(d.notes)}, p.id); });
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
  const d = m ? {...m} : {name:"", planned:null, actual:null, progress:null, note:"", sort:(calc(p).ms.length + 1)};
  drawerForm(m ? "Milestone" : "New milestone", d, [
    fld(d, "name", "Milestone", "text", {full:true}), fld(d, "planned", "Planned date", "date"), fld(d, "actual", "Done on (blank = not done)", "date"),
    fld(d, "progress", "Progress % (while in progress)", "number"), fld(d, "note", "Note", "text", {full:true})],
    () => { if (!(d.name || "").trim()) { toast("Name the milestone."); return false; }
      return saveRow("milestones", {project_id:p.id, name:d.name.trim(), planned:nullify(d.planned), actual:nullify(d.actual), progress:nullify(d.progress), note:nullify(d.note), sort:d.sort || 0}, m && m.id); },
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
function openMat(p, m) {
  const d = m ? {...m} : {item:"", qty:1, received:0, status:"to_order", eta:null, note:""};
  drawerForm(m ? m.item : "New material line", d, [
    fld(d, "item", "Item", "text", {full:true}), fld(d, "qty", "Quantity", "number"), fld(d, "received", "Received", "number"),
    fld(d, "status", "Status", "select", {options:MAT_ST.map(s => [s[0], s[1]]), blank:false}), fld(d, "eta", "Expected", "date"), fld(d, "note", "Note", "text", {full:true})],
    () => { if (!(d.item || "").trim()) { toast("Name the item."); return false; }
      return saveRow("materials", {project_id:p.id, item:d.item.trim(), qty:Number(d.qty) || 0, received:Number(d.received) || 0, status:d.status, eta:nullify(d.eta), note:nullify(d.note)}, m && m.id); },
    m ? del("materials", m.id) : null);
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
  const draft = {department:ho.department, pm_id:ho.pm_id, packet:JSON.parse(JSON.stringify(ho.packet || {})), reason:""};
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
      if (await saveDraft({status:"review", kickback_reason:null})) { toast("Sent to " + draft.department + " for review"); closeDrawer(); }
    }}, "Submit to operations"));
    if (ops && ho.status !== "kicked_back") {
      const reasonBox = h("div", {class:"o-kick", hidden:true}, h("textarea", {class:"inp", id:"kick-reason", placeholder:"What's missing or unclear?", oninput: e => { draft.reason = e.target.value; }}),
        h("button", {class:"btn danger", onclick: async () => {
          if (!draft.reason.trim()) { toast("Say what's missing first."); return; }
          if (await saveDraft({status:"kicked_back", kickback_reason:draft.reason.trim()})) { toast("Kicked back to " + personName(d.owner_id)); closeDrawer(); }
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
        if (pid) { await load(); render(); closeDrawer(); if (typeof pid === "string") openProject(pid); }
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
  const facts = h("div", {class:"wu-facts"},
    h("div", null, h("span", {class:"k"}, "Last week's plan"), h("p", null, prev && prev.next_week || "—")),
    h("div", null, h("span", {class:"k"}, "This week"), h("p", null, [hrs ? num(hrs) + " labor hours" : "Hours not entered yet", plural(logs.length, "daily log"),
      c.lateDays ? c.late[0].name + " " + c.lateDays + " days late" : null, c.coPend ? compact(c.coPend) + " in change orders pending" : null, c.backordered.length ? plural(c.backordered.length, "backorder") : null].filter(Boolean).join(" · "))),
    h("div", null, h("span", {class:"k"}, "Forecast"), h("p", null, "Margin " + pct(c.fcM) + " vs " + pct(c.estM) + " budget · labor " + pct(c.burn) + " used at " + pct(c.done) + " complete")));
  const sel = (key, label) => fld(d, key, label, "select", {options:STATUS.map(s => [s[0], s[1]]), blank:false});
  const body = h("div", null, facts, h("div", {class:"form"},
    fld(d, "pct_complete", "Percent complete (0–100)", "number"), h("div"),
    sel("schedule_status", "Schedule"), sel("cost_status", "Cost"), sel("safety_status", "Safety"), h("div"),
    fld(d, "accomplished", "Done this week", "textarea", {full:true}),
    fld(d, "next_week", "Plan for next week", "textarea", {full:true}),
    fld(d, "needs", "Needs and decisions (crew, material, customer, from leadership)", "textarea", {full:true}),
    fld(d, "customer_notes", "Customer (relationship, requests, possible new work)", "textarea", {full:true})),
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
function docsPanel(p) {
  const folders = FOLDERS.filter(f => canReadFolder(p, f[0]));
  const docs = O.docs.filter(d => d.project_id === p.id && folders.some(f => f[0] === d.folder)).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const cur = O.docFolder && folders.some(f => f[0] === O.docFolder) ? O.docFolder : "";
  const shown = docs.filter(d => !cur || d.folder === cur);
  const box = h("div");
  const tabs = h("div", {class:"doc-tabs", role:"tablist"}, h("button", {role:"tab", "aria-selected":String(!cur), onclick:() => { O.docFolder = ""; render(); }}, "All ", h("small", null, String(docs.length))),
    folders.map(f => { const n = docs.filter(d => d.folder === f[0]).length;
      return h("button", {role:"tab", "aria-selected":String(cur === f[0]), class: n ? "" : "empty", onclick:() => { O.docFolder = f[0]; render(); }}, f[1], " ", h("small", null, String(n))); }));
  const imgs = shown.filter(isImg).slice(0, 12), files = shown.filter(d => !isImg(d) || shown.filter(isImg).indexOf(d) >= 12);
  const link = d => { const a = h("a", {href:"#", target:"_blank", rel:"noopener", "data-path":d.path, class:"doc-name", onclick: async ev => {
    if (a.getAttribute("href") === "#") { ev.preventDefault(); const [u] = await signedUrls([d.path]); if (u) { a.href = u; window.open(u, "_blank", "noopener"); } else toast("Couldn't open that file."); } }}, d.name); return a; };
  const thumbs = imgs.length ? h("div", {class:"doc-thumbs"}, imgs.map(d => h("figure", null, h("a", {href:"#", target:"_blank", rel:"noopener", "data-path":d.path, class:"thumb"}, h("img", {alt:d.name, "data-path":d.path, loading:"lazy"})),
    h("figcaption", null, d.note || d.name, h("small", null, personName(d.uploaded_by) + " · " + fmtDate(d.created_at.slice(0, 10))))))) : null;
  const list = files.length ? h("ul", {class:"doc-list"}, files.map(d => h("li", null, h("span", {class:"doc-ic " + fileIcon(d).toLowerCase()}, fileIcon(d)),
    h("div", {class:"doc-main"}, link(d), h("small", null, [!cur ? folderName(d.folder) : null, fmtSize(d.size_bytes), personName(d.uploaded_by), fmtDate(d.created_at.slice(0, 10)), d.note].filter(Boolean).join(" · "))),
    d.uploaded_by === S.me.id || canEdit(p) ? h("button", {class:"btn small", "aria-label":"Delete " + d.name, onclick: async e => {
      const b = e.currentTarget; if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Click again to delete"; setTimeout(() => { b.dataset.armed = ""; b.textContent = "Delete"; }, 3000); return; }
      const {error} = await sb.storage.from(BUCKET).remove([d.path]);
      if (error && !/not found/i.test(error.message || "")) { toast(friendly(error)); return; }
      if (await run(sb.from("documents").delete().eq("id", d.id), "Deleted")) { await reload("docs"); render(); }
    }}, "Delete") : null))) : null;
  box.append(tabs, thumbs || list ? h("div", null, thumbs, list) : h("div", {class:"empty"}, cur ? "Nothing in " + folderName(cur) + " yet." : "No documents yet."));
  // fill thumbnail and link addresses once the page is on screen
  setTimeout(async () => { const els = [...box.querySelectorAll("[data-path]")]; if (!els.length) return;
    const paths = [...new Set(els.map(e => e.dataset.path))]; const urls = await signedUrls(paths); const m = new Map(paths.map((x, i) => [x, urls[i]]));
    for (const el of els) { const u = m.get(el.dataset.path); if (!u) continue; if (el.tagName === "IMG") el.src = u; else el.href = u; } }, 0);
  const canUp = folders.some(f => canUploadTo(p, f[0]));
  return panel("Documents", plural(docs.length, "file") + (canUp ? " · photos are resized for the phone" : ""), h("div", {class:"o-pad"}, box),
    canUp ? h("div", {class:"o-actions"}, h("button", {class:"btn primary small", onclick:() => openUpload(p, cur)}, "Upload files")) : null);
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
  const status = h("p", {class:"muted small", style:"grid-column:1/-1;margin:0"}, "Up to 50 MB per file. Photos over 1 MB are resized to 1600 px. For long videos, share a link in the note instead.");
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
        const safe = f.name.replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, " ").slice(-120);
        const path = p.id + "/" + d.folder + "/" + Date.now() + "-" + Math.random().toString(36).slice(2, 6) + "-" + safe;
        const {error} = await sb.storage.from(BUCKET).upload(path, f, {contentType:f.type || "application/octet-stream", upsert:false});
        if (error) { failed.push(f0.name + " (" + friendly(error) + ")"); continue; }
        const row = {project_id:p.id, folder:d.folder, name:f.name, path, size_bytes:f.size, mime_type:f.type || null, note:nullify((d.note || "").trim()), closeout_item_id:nullify(d.closeout_item_id), uploaded_by:S.me.id};
        const {error:e2} = await sb.from("documents").insert(row);
        if (e2) { failed.push(f0.name + " (" + friendly(e2) + ")"); await sb.storage.from(BUCKET).remove([path]); continue; }
        done++;
      }
      if (done && d.closeout_item_id) await run(sb.from("closeout_items").update({status:"done", note:"File: " + files[0].name}).eq("id", d.closeout_item_id));
      btn.disabled = false;
      await Promise.all([reload("docs"), reload("closeout")]); render();
      if (failed.length) { status.textContent = "Couldn't upload: " + failed.join("; "); toast(done ? "Uploaded " + done + ", " + failed.length + " failed" : "Upload failed"); }
      else { closeDrawer(); toast("Uploaded " + plural(done, "file")); O.docFolder = d.folder; render(); }
    }}, "Upload")]});
}

// ---------------------------------------------------------------- routing
const VIEW_FN = {"ops-updates":viewUpdates, "ops-overview":viewOverview, "ops-projects":viewProjects, "ops-project":viewProject, "ops-handoffs":viewHandoffs, "ops-billing":viewBilling, "ops-manpower":viewManpower, handoffs:viewHandoffs};
return {
  tables: Object.values(TABLES),
  load, changed,
  available: () => !O.missing && !!role(),
  departments: () => deptKeys().length ? deptKeys() : ["Tower", "DAS", "Network", "DataComm", "Security"],
  views: () => {
    const r = role();
    const mp = O.techs.length || role() === "admin" ? [["ops-manpower", r === "field" ? "Schedule" : "Manpower"]] : [];
    if (r === "field") return [["ops-projects", "My projects"], ...mp];
    if (r === "pm") return [["ops-projects", "My projects"], ["ops-updates", "Weekly updates"], ...mp, ["ops-handoffs", "Handoffs"], ["ops-billing", "Billing"]];
    return [["ops-overview", "Overview"], ["ops-projects", "Projects"], ["ops-updates", "Weekly updates"], ...mp, ["ops-handoffs", "Handoffs"], ["ops-billing", "Billing"]];
  },
  salesViews: () => O.missing ? [] : [["handoffs", "Handoffs"]],
  hiddenViews: () => ["ops-project"],
  parentView: v => v === "ops-project" ? "ops-projects" : null,
  owns: v => v in VIEW_FN,
  render: v => (VIEW_FN[v] || viewOverview)(),
  strip,
};
};
