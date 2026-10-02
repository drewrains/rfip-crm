/* RFIP Pipeline — CRM front end. Talks to Supabase; the database's row-level
   security decides what each person can see and change. */
(() => {
"use strict";

// ---------------------------------------------------------------- constants
const STAGES = [
  {id:"lead", name:"Lead", p:10, open:true},
  {id:"qualifying", name:"Qualifying", p:20, open:true},
  {id:"proposal", name:"Proposal / Bid", p:40, open:true},
  {id:"submitted", name:"Submitted", p:50, open:true},
  {id:"negotiation", name:"Negotiation", p:75, open:true},
  {id:"won", name:"Won", p:100, open:false},
  {id:"lost", name:"Lost", p:0, open:false},
  {id:"nobid", name:"No-bid", p:0, open:false},
];
const STAGE = Object.fromEntries(STAGES.map(s => [s.id, s]));
const SERVICES = ["DAS","ERRCS","Wi-Fi","Network","Structured cabling","Fiber","Tower","Security","AV","Managed services"];
const VERTICALS = ["Stadiums & venues","Collegiate athletics","Oil & energy","Data centers","Healthcare","Government","Enterprise","Retail & auto","Other"];
const ACCT_TYPES = ["Owner / end user","General contractor","Electrical contractor","Integrator / partner","Developer","Consultant / designer","Manufacturer / vendor","Carrier / neutral host"];
const SOURCES = ["Public RFP","Invited bid","Repeat client","Referral","GC / partner","Cold outreach","Inbound"];
const DEAL_FIELDS = ["name","account_id","contact_id","owner_id","stage","value","probability","bid_due","close_date","rfp_no","source","vertical","services","description","gng",
  "outcome_reason","winning_competitor","winning_price","outcome_notes"];
const WIN_REASONS = ["Relationship","Price","Technical solution","Self-perform crews / schedule","Local or diversity preference","GC / partner pull-through","Incumbent","Other"];
const LOSS_REASONS = ["Price","Relationship / incumbent","Technical or scope fit","Schedule or capacity","Bonding, licensing or prequalification","Late or incomplete submission","Project cancelled or delayed","Unknown","Other"];
const NOBID_REASONS = ["Not a fit for our services","Crew or PM capacity","Margin too low","Contract or risk terms","Timeline too short","Bonding, licensing or prequalification","Relationship favors another bidder","Other"];
const reasonsFor = stage => stage === "won" ? WIN_REASONS : stage === "nobid" ? NOBID_REASONS : LOSS_REASONS;
const NOTE_KINDS = [["note","Note"],["call","Call"],["meeting","Meeting"],["site_visit","Site visit"],["email","Email"]];
const DEAL_ROLES = [["sales_engineer","Sales engineer"],["estimator","Estimator"],["account_manager","Co–account manager"],["support","Support"]];
const JOB_ROLES = [["account_manager","Account manager"],["sales_engineer","Sales engineer"],["estimator","Estimator"],["manager","Manager"],["other","Other"]];
const dealRoleLabel = r => (DEAL_ROLES.find(x => x[0] === r) || DEAL_ROLES[3])[1];
const jobToDealRole = j => j === "sales_engineer" || j === "estimator" || j === "account_manager" ? j : "support";
const kindLabel = k => (NOTE_KINDS.find(x => x[0] === k) || NOTE_KINDS[0])[1];
const THIS_YEAR = new Date().getFullYear();
const DEFAULT_GNG = {threshold:{go:70, review:55}, criteria:[]};

// ---------------------------------------------------------------- setup
const cfg = window.RFIP_CONFIG || {};
const configured = cfg.supabaseUrl && !/YOUR-/.test(cfg.supabaseUrl) && cfg.supabaseAnonKey && !/YOUR-/.test(cfg.supabaseAnonKey);
const sb = configured ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
  auth: {persistSession:true, autoRefreshToken:true, detectSessionInUrl:true, flowType:"pkce"},
}) : null;

const S = {
  me:null, profiles:[], accounts:[], contacts:[], deals:[], members:[], tasks:[], targets:[], gng:DEFAULT_GNG, year:THIS_YEAR, dim:"owner",
  view:"dashboard", q:"", stageFilter:"open", ownerFilter:"", started:false,
};
try { const v = localStorage.getItem("rfipcrm.view"); if (v) S.view = v; } catch (e) {}

// ---------------------------------------------------------------- helpers
const $ = s => document.querySelector(s);
function h(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k === "text") n.textContent = v;
    else if (k === "value") n.value = v;
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) { if (k == null || k === false) continue; n.append(k instanceof Node ? k : document.createTextNode(String(k))); }
  return n;
}
const money = (v, compact) => {
  const n = Number(v) || 0; if (!n) return "—";
  if (compact && Math.abs(n) >= 1e6) return "$" + (n/1e6).toFixed(n >= 1e7 ? 1 : 2) + "M";
  if (compact && Math.abs(n) >= 1e4) return "$" + Math.round(n/1e3) + "K";
  return n.toLocaleString("en-US", {style:"currency", currency:"USD", maximumFractionDigits: n % 1 ? 2 : 0});
};
const todayStr = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0"); };
const daysUntil = s => { if (!s) return null; const [y,m,d] = s.split("-").map(Number); const t = new Date();
  return Math.round((Date.UTC(y,m-1,d) - Date.UTC(t.getFullYear(), t.getMonth(), t.getDate())) / 864e5); };
const fmtDate = s => { if (!s) return "—"; const [y,m,d] = s.split("-").map(Number);
  return new Date(y,m-1,d).toLocaleDateString("en-US", {month:"short", day:"numeric", year: y === new Date().getFullYear() ? undefined : "numeric"}); };
const dueChip = s => { const n = daysUntil(s); if (n == null) return null; let cls = "chip", t = fmtDate(s);
  if (n < 0) { cls += " bad"; t += " · " + (-n) + "d late"; } else if (n === 0) { cls += " warn"; t += " · today"; } else if (n <= 7) { cls += " warn"; t += " · " + n + "d"; }
  return h("span", {class:cls}, t); };
const byId = (list, id) => list.find(x => x.id === id);
const acctName = id => (byId(S.accounts, id) || {}).name || "";
const dealName = id => (byId(S.deals, id) || {}).name || "";
const person = id => byId(S.profiles, id);
const personName = id => { const p = person(id); return p ? (p.full_name || p.email) : "—"; };
const initials = id => personName(id).split(/\s+/).map(w => w[0]).filter(Boolean).slice(0,2).join("").toUpperCase();
const activePeople = () => S.profiles.filter(p => p.active).sort((a,b) => (a.full_name||a.email).localeCompare(b.full_name||b.email));
const prob = d => d.probability != null ? Number(d.probability) : (STAGE[d.stage] || STAGE.lead).p;
const plural = (n, w) => n + " " + w + (n === 1 ? "" : "s");
const isOpen = d => (STAGE[d.stage] || STAGE.lead).open;
const isAdmin = () => S.me && S.me.role === "admin";
function reportsOf(id) {
  const out = [], seen = new Set([id]); let frontier = [id];
  while (frontier.length) { const next = S.profiles.filter(p => p.active && frontier.includes(p.manager_id) && !seen.has(p.id));
    next.forEach(p => { seen.add(p.id); out.push(p); }); frontier = next.map(p => p.id); }
  return out;
}
const isManager = () => !!S.me && reportsOf(S.me.id).length > 0;
const myTeam = () => isAdmin() ? activePeople() : [S.me, ...reportsOf(S.me.id)].filter(Boolean);
const canManage = d => isAdmin() || (d && d.owner_id === S.me.id);
const membersOf = dealId => S.members.filter(m => m.deal_id === dealId).map(m => m.user_id);
const membersWithRole = (dealId, role) => S.members.filter(m => m.deal_id === dealId && (m.role || "support") === role).map(m => m.user_id);
const seNames = dealId => membersWithRole(dealId, "sales_engineer").map(personName).join(", ");
const fmtDateTime = x => new Date(x).toLocaleString("en-US", {month:"short", day:"numeric", year:"numeric", hour:"numeric", minute:"2-digit"});
const nullify = v => (v === "" || v === undefined) ? null : v;

function toast(msg) { const t = h("div", {class:"toast", role:"status"}, msg); document.body.append(t); setTimeout(() => t.remove(), 3000); }
function status(msg) { const n = $("#status"); n.textContent = msg || ""; n.hidden = !msg; }
function friendly(e) {
  const m = (e && (e.message || e.error_description)) || "Something went wrong.";
  if (e && e.code === "23505") return "That already exists (an account with the same name, for example).";
  if (e && e.code === "42501" || /row-level security|permission denied/i.test(m)) return "You don't have permission to do that.";
  return m;
}
async function run(promise, okMsg) {
  try {
    const {data, error} = await promise;
    if (error) { toast(friendly(error)); return null; }
    if (okMsg) toast(okMsg);
    return data == null ? true : data;
  } catch (e) { toast(friendly(e)); return null; }
}

function gngScore(d) {
  const c = S.gng.criteria || []; const sc = (d.gng && d.gng.scores) || {}; let tw = 0, got = 0, n = 0;
  for (const k of c) { const v = Number(sc[k.id]); if (v >= 1 && v <= 5) { tw += Number(k.weight) || 0; got += (v/5) * (Number(k.weight) || 0); n++; } }
  return {pct: tw ? Math.round(got/tw*100) : null, scored:n, total:c.length};
}
function gngChip(d) {
  const dec = d.gng && d.gng.decision;
  if (dec === "go") return h("span", {class:"chip go"}, "GO");
  if (dec === "nogo") return h("span", {class:"chip bad"}, "NO-GO");
  if (dec === "hold") return h("span", {class:"chip warn"}, "HOLD");
  const s = gngScore(d); if (s.pct == null) return null;
  const t = S.gng.threshold; const cls = s.pct >= t.go ? "go" : s.pct >= t.review ? "warn" : "bad";
  return h("span", {class:"chip " + cls, title:"Go/no-go score, not yet decided"}, s.pct + "%");
}

// ---------------------------------------------------------------- auth
function showSignin(err) {
  $("#app").hidden = true; $("#signin").hidden = false;
  $("#pwForm").hidden = cfg.passwordLogin === false;
  $("#msBlock").hidden = !cfg.microsoftLogin;
  if (cfg.passwordLogin === false) { const o = document.querySelector("#msBlock .or"); if (o) o.hidden = true; }
  const e = $("#signinError"); e.textContent = err || ""; e.hidden = !err;
}
$("#pwForm").addEventListener("submit", async ev => {
  ev.preventDefault();
  if (!sb) return;
  const btn = $("#pwSubmit"); btn.disabled = true; btn.textContent = "Signing in…";
  const {error} = await sb.auth.signInWithPassword({email: $("#pwEmail").value.trim().toLowerCase(), password: $("#pwPass").value});
  btn.disabled = false; btn.textContent = "Sign in";
  if (error) showSignin(/invalid login/i.test(error.message) ? "That email and password don't match. Ask an admin if you need a reset." : friendly(error));
  else $("#pwPass").value = "";
});
$("#changePw").addEventListener("click", () => {
  const p1 = h("input", {class:"inp", id:"np1", type:"password", autocomplete:"new-password"});
  const p2 = h("input", {class:"inp", id:"np2", type:"password", autocomplete:"new-password"});
  openDrawer({title:"Change password", body:h("div", {class:"form"},
      h("div", {class:"field full"}, h("label", {for:"np1"}, "New password (at least 10 characters)"), p1),
      h("div", {class:"field full"}, h("label", {for:"np2"}, "Type it again"), p2)),
    foot:[h("button", {class:"btn spacer", onclick:() => closeDrawer()}, "Cancel"), h("button", {class:"btn primary", onclick: async () => {
      if (p1.value.length < 10) { toast("Use at least 10 characters."); return; }
      if (p1.value !== p2.value) { toast("The two passwords don't match."); return; }
      if (await run(sb.auth.updateUser({password:p1.value}), "Password changed")) closeDrawer();
    }}, "Change password")]});
});
function authErrorFromUrl() {
  const p = new URLSearchParams(location.search + "&" + location.hash.replace(/^#/, ""));
  const d = p.get("error_description") || p.get("error");
  if (!d) return null;
  history.replaceState(null, "", location.pathname);
  if (/database error saving new user|limited to rfip/i.test(d)) return "Sign-in is limited to RFIP Microsoft accounts.";
  return "Sign-in didn't complete: " + d.replace(/\+/g, " ");
}
$("#msLogin").addEventListener("click", async () => {
  if (!sb) return;
  const {error} = await sb.auth.signInWithOAuth({provider:"azure", options:{scopes:"email", redirectTo: location.origin + location.pathname}});
  if (error) showSignin(friendly(error));
});
$("#signOut").addEventListener("click", async () => { await sb.auth.signOut(); location.reload(); });

async function boot() {
  if (!sb) { showSignin("This app isn't connected to its database yet. Add the Supabase URL and key to config.js."); return; }
  const urlErr = authErrorFromUrl();
  const {data:{session}} = await sb.auth.getSession();
  if (!session) { showSignin(urlErr); }
  else start(session);
  sb.auth.onAuthStateChange((ev, sess) => {
    if (ev === "SIGNED_IN" && sess && !S.started) start(sess);
    if (ev === "SIGNED_OUT") showSignin();
  });
}

async function start(session) {
  S.started = true;
  const {data:me, error} = await sb.from("profiles").select("*").eq("id", session.user.id).maybeSingle();
  if (error || !me) { S.started = false; showSignin("Your account isn't set up in the CRM. Ask an admin for access."); await sb.auth.signOut(); return; }
  if (!me.active) { S.started = false; showSignin("Your CRM access is turned off. Ask an admin to turn it back on."); await sb.auth.signOut(); return; }
  S.me = me;
  $("#meName").textContent = me.full_name || me.email;
  $("#changePw").hidden = !(session.user.app_metadata && (session.user.app_metadata.providers || [session.user.app_metadata.provider]).includes("email"));
  $("#signin").hidden = true; $("#app").hidden = false;
  await loadAll();
  subscribe();
  render();
}

// ---------------------------------------------------------------- data
async function fetchAll(table, order) {
  const out = []; const page = 1000;
  for (let from = 0; ; from += page) {
    let q = sb.from(table).select("*").range(from, from + page - 1);
    if (order) q = q.order(order);
    const {data, error} = await q;
    if (error) throw error;
    out.push(...data);
    if (data.length < page) break;
  }
  return out;
}
const TABLES = {profiles:"profiles", accounts:"accounts", contacts:"contacts", deals:"deals", members:"deal_members", tasks:"tasks", targets:"targets"};
async function loadTable(key) {
  const ORDER = {members:"deal_id", targets:"year"};
  try { S[key] = await fetchAll(TABLES[key], ORDER[key] || "created_at"); status(""); }
  catch (e) { status("Couldn't load " + key + ": " + friendly(e)); }
}
async function loadAll() {
  await Promise.all(Object.keys(TABLES).map(loadTable).concat([loadGng()]));
  const me = byId(S.profiles, S.me.id); if (me) S.me = me;
}
async function loadGng() {
  const {data} = await sb.from("gng_config").select("config").maybeSingle();
  S.gng = (data && data.config) || DEFAULT_GNG;
}
const pending = new Set(); let reloadTimer = null;
function scheduleReload(key) {
  pending.add(key);
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    const keys = [...pending]; pending.clear();
    await Promise.all(keys.map(loadTable));
    render(); refreshDrawer();
  }, 250);
}
function subscribe() {
  const map = {deals:"deals", deal_members:"members", tasks:"tasks", accounts:"accounts", contacts:"contacts", deal_notes:"notes"};
  sb.channel("crm-changes")
    .on("postgres_changes", {event:"*", schema:"public"}, p => {
      const key = map[p.table];
      if (key === "notes") { if (openNotes && p.new && p.new.deal_id === openNotes.dealId) openNotes.reload(); return; }
      if (key) { scheduleReload(key); if (key === "members") scheduleReload("deals"); }
    })
    .subscribe();
  // people, settings and anything missed while the tab slept
  let last = Date.now();
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "visible" && Date.now() - last > 60000) { last = Date.now(); await loadAll(); render(); }
  });
}

// ---------------------------------------------------------------- render shell
const VIEWS = () => [["dashboard","Dashboard"],["pipeline","Pipeline"],["deals","Deals"],["accounts","Accounts"],["contacts","Contacts"],["tasks","Tasks"],["settings","Go/no-go & import"]]
  .concat(isAdmin() || isManager() ? [["scorecard","Scorecard"]] : []).concat(isAdmin() ? [["team","Team"]] : []);
let renderQueued = false;
function render() { if (renderQueued) return; renderQueued = true; requestAnimationFrame(() => { renderQueued = false; renderNow(); }); }
function renderNow() {
  if (!S.me) return;
  const views = VIEWS(); if (!views.some(v => v[0] === S.view)) S.view = "dashboard";
  $("#tabs").replaceChildren(...views.map(([id, name]) => h("button", {"aria-current": S.view === id ? "page" : null,
    onclick: () => { S.view = id; S.q = ""; try { localStorage.setItem("rfipcrm.view", id); } catch (e) {} renderNow(); }}, name)));
  renderStrip();
  const keep = document.activeElement && document.activeElement.id;
  const fn = {dashboard:viewDashboard, pipeline:viewPipeline, deals:viewDeals, accounts:viewAccounts, contacts:viewContacts, tasks:viewTasks, settings:viewSettings, team:viewTeam, scorecard:viewScorecard}[S.view];
  $("#view").replaceChildren(fn());
  if (keep) { const k = document.getElementById(keep); if (k && k.tagName === "INPUT" && k.type === "search") { k.focus(); try { k.setSelectionRange(k.value.length, k.value.length); } catch (e) {} } }
}
function metric(k, v, s, alert) { return h("div", {class:"metric" + (alert ? " alert" : "")}, h("div", {class:"k"}, k), h("div", {class:"v"}, v), h("div", {class:"s"}, s)); }
function stats(deals) {
  const yr = String(new Date().getFullYear());
  const open = deals.filter(isOpen);
  const pipe = open.reduce((a, d) => a + (Number(d.value) || 0), 0);
  const wtd = open.reduce((a, d) => a + (Number(d.value) || 0) * prob(d) / 100, 0);
  const closedYr = deals.filter(d => (d.close_date || "").startsWith(yr));
  const won = closedYr.filter(d => d.stage === "won");
  const lost = closedYr.filter(d => d.stage === "lost");
  return {open, pipe, wtd, won, wonV: won.reduce((a, d) => a + (Number(d.value) || 0), 0),
    winRate: won.length + lost.length ? Math.round(won.length / (won.length + lost.length) * 100) : null,
    due: open.filter(d => { const n = daysUntil(d.bid_due); return n != null && n >= 0 && n <= 14; }),
    pendingGng: open.filter(d => !(d.gng && d.gng.decision) && ["lead","qualifying"].includes(d.stage))};
}
function renderStrip() {
  const st = stats(S.deals); const yr = new Date().getFullYear();
  const overdue = S.tasks.filter(t => !t.done && daysUntil(t.due) < 0 && (isAdmin() ? true : t.assignee_id === S.me.id)).length;
  $("#strip").replaceChildren(
    metric(isAdmin() ? "Open pipeline" : isManager() ? "Team open pipeline" : "My open pipeline", money(st.pipe, true), plural(st.open.length, "open deal")),
    metric("Weighted", money(st.wtd, true), "value × stage probability"),
    metric("Bids due ≤14 days", String(st.due.length), "by bid due date"),
    metric("Awaiting go/no-go", String(st.pendingGng.length), "lead & qualifying"),
    metric("Won " + yr, money(st.wonV, true), plural(st.won.length, "deal") + (st.winRate != null ? " · " + st.winRate + "% win rate" : "")),
    metric("Overdue tasks", String(overdue), isAdmin() ? "across the team" : "assigned to you", overdue > 0));
}
function emptyState(title, text, btn) { return h("div", {class:"empty"}, h("b", null, title), h("div", null, text), btn ? h("div", {style:"margin-top:12px"}, btn) : null); }

// ---------------------------------------------------------------- dashboard
function bars(rows, fmt) {
  const max = Math.max(1, ...rows.map(r => r.v));
  if (!rows.length) return h("div", {class:"muted"}, "Nothing to show yet.");
  return h("div", {class:"bars"}, rows.flatMap(r => [
    h("div", {class:"lbl"}, r.onclick ? h("button", {class:"linkish", onclick:r.onclick}, r.label) : r.label),
    h("div", {class:"track", title: r.label + ": " + fmt(r.v) + (r.n != null ? " · " + r.n + " deals" : "")}, h("div", {class:"fill", style:"width:" + (r.v / max * 100) + "%"})),
    h("div", {class:"val"}, fmt(r.v), r.n != null ? h("small", null, " · " + r.n) : null)]));
}
function closedIn(deals, year) { return deals.filter(d => !isOpen(d) && (d.close_date || "").startsWith(String(year))); }
function yearResults(deals, year) {
  const c = closedIn(deals, year);
  const won = c.filter(d => d.stage === "won"), lost = c.filter(d => d.stage === "lost"), nobid = c.filter(d => d.stage === "nobid");
  const wonV = won.reduce((a, d) => a + (Number(d.value) || 0), 0);
  return {won, lost, nobid, wonV, rate: won.length + lost.length ? Math.round(won.length / (won.length + lost.length) * 100) : null,
    avg: won.length ? wonV / won.length : 0};
}
function delta(cur, prev, fmt, suffix) {
  if (prev == null || cur == null) return "";
  const d = cur - prev; if (!d) return "same as " + suffix;
  return (d > 0 ? "▲ " : "▼ ") + fmt(Math.abs(d)) + " vs " + suffix;
}
function targetFor(userId, year) { return S.targets.find(t => t.year === year && (t.user_id || null) === (userId || null)); }
function progressRow(label, actual, target) {
  const pct = target ? Math.round(actual / target * 100) : 0;
  return [h("div", {class:"lbl"}, label),
    h("div", {class:"track", title: money(actual) + " of " + money(target)}, h("div", {class:"fill", style:"width:" + Math.min(100, pct) + "%"})),
    h("div", {class:"val"}, money(actual, true), h("small", null, " / " + money(target, true) + " · " + pct + "%"))];
}
const DIMS = [["owner","Account manager"],["se","Sales engineer"],["vertical","Vertical"],["service","Service line"],["source","Source"],["acct_type","Account type"]];
function dimKeys(d, dim) {
  if (dim === "owner") return [personName(d.owner_id)];
  if (dim === "se") { const se = membersWithRole(d.id, "sales_engineer"); return se.length ? se.map(personName) : ["No sales engineer"]; }
  if (dim === "vertical") return [d.vertical || "Unassigned"];
  if (dim === "service") return d.services && d.services.length ? d.services : ["Unassigned"];
  if (dim === "source") return [d.source || "Unassigned"];
  const a = byId(S.accounts, d.account_id); return [(a && a.type) || "Unassigned"];
}
function viewDashboard() {
  const wrap = h("div");
  const yearsSet = new Set([THIS_YEAR]); for (const d of S.deals) if (d.close_date) yearsSet.add(Number(d.close_date.slice(0, 4)));
  const years = [...yearsSet].sort((a, b) => b - a);
  const deals = S.ownerFilter ? S.deals.filter(d => d.owner_id === S.ownerFilter || membersOf(d.id).includes(S.ownerFilter)) : S.deals;
  wrap.append(h("div", {class:"toolbar"}, h("h2", null, isAdmin() ? "Company dashboard" : isManager() ? "Team dashboard" : "My dashboard"),
    h("select", {"aria-label":"Year", id:"dash-year", onchange: e => { S.year = Number(e.target.value); render(); }}, years.map(y => h("option", {value:String(y), selected:S.year === y}, String(y)))),
    isAdmin() || isManager() ? h("select", {"aria-label":"Rep", id:"dash-rep", onchange: e => { S.ownerFilter = e.target.value; render(); }},
      h("option", {value:""}, isAdmin() ? "Everyone" : "My whole team"), myTeam().map(p => h("option", {value:p.id, selected:S.ownerFilter === p.id}, p.full_name || p.email))) : null));
  if (!isAdmin()) wrap.append(h("p", {class:"muted", style:"margin:-6px 0 12px"}, isManager()
    ? "Deals you and the people who report to you own or are shared on."
    : "Deals you own or that have been shared with you."));
  if (!S.deals.length) { wrap.append(h("div", {class:"panel"}, emptyState("No deals yet", "Create a deal or import a spreadsheet to fill the dashboard.", h("button", {class:"btn primary", onclick:() => openDeal()}, "+ New deal")))); return wrap; }
  const st = stats(deals);
  const Y = S.year, cur = yearResults(deals, Y), prev = yearResults(deals, Y - 1);
  const hasPrev = closedIn(deals, Y - 1).length > 0, py = String(Y - 1);
  const grid = h("div", {class:"dash"});

  // results for the year
  const tScope = S.ownerFilter || (isAdmin() ? null : S.me.id);
  const tRows = [];
  const tMain = targetFor(tScope, Y);
  if (tMain && Number(tMain.won_value)) {
    const actual = tScope ? yearResults(S.deals.filter(d => d.owner_id === tScope), Y).wonV : cur.wonV;
    tRows.push(progressRow(tScope ? personName(tScope) + " target" : "Company target", actual, Number(tMain.won_value)));
  }
  if ((isAdmin() || isManager()) && !S.ownerFilter) for (const p of (isAdmin() ? activePeople() : reportsOf(S.me.id))) { const t = targetFor(p.id, Y);
    if (t && Number(t.won_value)) tRows.push(progressRow(p.full_name || p.email, yearResults(S.deals.filter(d => d.owner_id === p.id), Y).wonV, Number(t.won_value))); }
  grid.append(h("div", {class:"panel wide"}, h("h3", null, Y + " results"),
    h("p", {class:"hint"}, "Deals with a close or award date in " + Y + (hasPrev ? ", compared with " + py : "") + ". Win rate counts won against lost; no-bids are left out."),
    h("div", {class:"strip mini", style:"margin:0 0 12px"},
      metric("Won", money(cur.wonV, true), hasPrev ? delta(cur.wonV, prev.wonV, v => money(v, true), py) : plural(cur.won.length, "deal")),
      metric("Deals won", String(cur.won.length), hasPrev ? delta(cur.won.length, prev.won.length, String, py) : "of " + plural(cur.won.length + cur.lost.length, "decided bid")),
      metric("Win rate", cur.rate == null ? "—" : cur.rate + "%", hasPrev && prev.rate != null && cur.rate != null ? delta(cur.rate, prev.rate, v => v + " pts", py) : cur.lost.length + " lost"),
      metric("Average win", money(cur.avg, true), hasPrev ? delta(Math.round(cur.avg), Math.round(prev.avg), v => money(v, true), py) : "per won deal"),
      metric("No-bids", String(cur.nobid.length), "passed on")),
    tRows.length ? h("div", null, h("div", {class:"lab", style:"margin-bottom:6px"}, "Targets (won revenue)"), h("div", {class:"bars"}, tRows.flat()))
      : (isAdmin() ? h("p", {class:"muted", style:"font-size:12px;margin:0"}, "Set " + Y + " targets in the Team tab to track progress here.") : null)));

  // win rate by dimension
  const closed = closedIn(deals, Y); const gmap = {};
  for (const d of closed) for (const k of dimKeys(d, S.dim)) { const g = gmap[k] = gmap[k] || {won:0, lost:0, nobid:0, v:0}; g[d.stage]++; if (d.stage === "won") g.v += Number(d.value) || 0; }
  const grows = Object.entries(gmap).sort((a, b) => b[1].v - a[1].v || b[1].won - a[1].won);
  grid.append(h("div", {class:"panel wide"}, h("div", {class:"toolbar", style:"margin-bottom:4px"}, h("h3", {style:"margin:0 auto 0 0"}, "Where we win in " + Y),
      h("select", {"aria-label":"Group by", id:"dash-dim", onchange: e => { S.dim = e.target.value; render(); }}, DIMS.map(([v, t]) => h("option", {value:v, selected:S.dim === v}, "By " + t.toLowerCase())))),
    grows.length ? h("div", {class:"tbl-wrap", style:"border:0"}, h("table", null,
      h("thead", null, h("tr", null, h("th", null, (DIMS.find(x => x[0] === S.dim) || [])[1]), ...["Won","Lost","No-bid","Win rate","Won value"].map(t => h("th", {class:"num"}, t)))),
      h("tbody", null, grows.map(([k, g]) => h("tr", null, h("td", {style:"font-weight:600"}, k), h("td", {class:"num"}, String(g.won)), h("td", {class:"num"}, String(g.lost)),
        h("td", {class:"num"}, String(g.nobid)), h("td", {class:"num"}, g.won + g.lost ? Math.round(g.won / (g.won + g.lost) * 100) + "%" : "—"), h("td", {class:"num"}, money(g.v)))))))
      : h("div", {class:"muted"}, "No deals closed in " + Y + " yet. As deals are marked won, lost or no-bid, this fills in.")));

  // why we lose / pass / who beats us
  const tally = (list, f) => { const m = {}; for (const d of list) { const k = f(d); if (k) m[k] = (m[k] || 0) + 1; } return Object.entries(m).map(([label, v]) => ({label, v})).sort((a, b) => b.v - a.v); };
  grid.append(h("div", {class:"panel"}, h("h3", null, "Why we lost"), h("p", {class:"hint"}, Y + " · number of deals"), bars(tally(cur.lost, d => d.outcome_reason || "Not recorded"), String)));
  grid.append(h("div", {class:"panel"}, h("h3", null, "Who beat us"), h("p", {class:"hint"}, Y + " · deals lost to each competitor"), bars(tally(cur.lost, d => d.winning_competitor && d.winning_competitor.trim()), String)));
  grid.append(h("div", {class:"panel"}, h("h3", null, "Why we passed"), h("p", {class:"hint"}, Y + " · no-bid reasons"), bars(tally(cur.nobid, d => d.outcome_reason || "Not recorded"), String)));

  // go/no-go vs results
  const t = S.gng.threshold; const buckets = [["Scored GO (" + t.go + "%+)", s => s != null && s >= t.go], ["Scored review (" + t.review + "–" + (t.go - 1) + "%)", s => s != null && s >= t.review && s < t.go],
    ["Scored below " + t.review + "%", s => s != null && s < t.review], ["Not scored", s => s == null]];
  const decidedAll = deals.filter(d => d.stage === "won" || d.stage === "lost");
  grid.append(h("div", {class:"panel wide"}, h("h3", null, "Is go/no-go predicting wins?"),
    h("p", {class:"hint"}, "All won and lost deals to date, grouped by their go/no-go score. If high scores win more often, the criteria are working; if not, adjust the weights."),
    h("div", {class:"tbl-wrap", style:"border:0"}, h("table", null,
      h("thead", null, h("tr", null, h("th", null, "Score"), ...["Won","Lost","Win rate"].map(x => h("th", {class:"num"}, x)))),
      h("tbody", null, buckets.map(([label, test]) => { const ds = decidedAll.filter(d => test(gngScore(d).pct)); const w = ds.filter(d => d.stage === "won").length;
        return h("tr", null, h("td", null, label), h("td", {class:"num"}, String(w)), h("td", {class:"num"}, String(ds.length - w)), h("td", {class:"num"}, ds.length ? Math.round(w / ds.length * 100) + "%" : "—")); }))))));

  // current open pipeline
  if ((isAdmin() || isManager()) && !S.ownerFilter) {
    const reps = myTeam().map(p => { const own = S.deals.filter(d => d.owner_id === p.id); const s = stats(own);
      const od = S.tasks.filter(t => !t.done && t.assignee_id === p.id && daysUntil(t.due) < 0).length; return {p, own, s, od}; })
      .filter(r => r.own.length || r.od).sort((a, b) => b.s.pipe - a.s.pipe);
    grid.append(h("div", {class:"panel wide"}, h("h3", null, "Open pipeline by rep"), h("p", {class:"hint"}, "Deals each person owns today. Pick a name to see their deals, including ones shared with them."),
      reps.length ? h("div", {class:"tbl-wrap", style:"border:0"}, h("table", null,
        h("thead", null, h("tr", null, h("th", null, "Rep"), ...["Open deals","Pipeline","Weighted","Won " + THIS_YEAR,"Overdue tasks"].map(t => h("th", {class:"num"}, t)))),
        h("tbody", null, reps.map(r => h("tr", {class:"click", tabindex:"0", onclick:() => { S.ownerFilter = r.p.id; render(); }},
          h("td", {style:"font-weight:600"}, r.p.full_name || r.p.email),
          h("td", {class:"num"}, String(r.s.open.length)), h("td", {class:"num"}, money(r.s.pipe)), h("td", {class:"num"}, money(r.s.wtd)), h("td", {class:"num"}, money(r.s.wonV)),
          h("td", {class:"num", style: r.od ? "color:var(--bad)" : null}, String(r.od)))))))
      : h("div", {class:"muted"}, "No deals are assigned yet.")));
  }
  const byStage = STAGES.filter(s => s.open).map(s => { const ds = deals.filter(d => d.stage === s.id);
    return {label:s.name, v: ds.reduce((a, d) => a + (Number(d.value) || 0), 0), n: ds.length, onclick:() => { S.view = "deals"; S.stageFilter = s.id; renderNow(); }}; });
  grid.append(h("div", {class:"panel"}, h("h3", null, "Open pipeline by stage"), h("p", {class:"hint"}, "Dollar value · number of deals"), bars(byStage, v => money(v, true))));
  const vmap = {}; for (const d of st.open) { const k = d.vertical || "Unassigned"; vmap[k] = vmap[k] || {v:0, n:0}; vmap[k].v += Number(d.value) || 0; vmap[k].n++; }
  grid.append(h("div", {class:"panel"}, h("h3", null, "Open pipeline by vertical"), h("p", {class:"hint"}, "Dollar value · number of deals"),
    bars(Object.entries(vmap).map(([label, o]) => ({label, v:o.v, n:o.n})).sort((a, b) => b.v - a.v), v => money(v, true))));
  const upcoming = st.open.filter(d => { const n = daysUntil(d.bid_due); return n != null && n >= -7 && n <= 30; }).sort((a, b) => a.bid_due.localeCompare(b.bid_due));
  grid.append(h("div", {class:"panel"}, h("h3", null, "Bids due in the next 30 days"),
    upcoming.length ? upcoming.map(d => h("div", {class:"list-row"}, h("button", {class:"linkish", onclick:() => openDeal(d.id)}, d.name), h("span", {class:"chips"}, h("span", {class:"muted", style:"font-size:12px"}, personName(d.owner_id)), dueChip(d.bid_due))))
      : h("div", {class:"muted"}, "No bids due in the next 30 days.")));
  grid.append(h("div", {class:"panel"}, h("h3", null, "Waiting on a go/no-go"),
    st.pendingGng.length ? st.pendingGng.map(d => h("div", {class:"list-row"}, h("button", {class:"linkish", onclick:() => openDeal(d.id, "g")}, d.name), h("span", {class:"chips"}, h("span", {class:"muted", style:"font-size:12px"}, personName(d.owner_id)), gngChip(d) || h("span", {class:"chip"}, "not scored"))))
      : h("div", {class:"muted"}, "Every early-stage deal has a decision.")));
  wrap.append(grid);
  return wrap;
}

// ---------------------------------------------------------------- scorecard (admins)
const ACT = {days:30, rows:null, loading:false, loadedFor:0};
async function loadActivity(days) {
  ACT.loading = true;
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const out = [];
  for (let from = 0; ; from += 1000) {
    const {data, error} = await sb.from("deal_notes").select("author_id,kind,created_at").eq("system", false).gte("created_at", since).range(from, from + 999);
    if (error) { status("Couldn't load activity: " + friendly(error)); break; }
    out.push(...data); if (data.length < 1000) break;
  }
  ACT.rows = out; ACT.loadedFor = days; ACT.loading = false; render();
}
function miniBar(pct) {
  return h("div", {class:"minibar", title: pct + "% of target"}, h("i", {style:"width:" + Math.min(100, pct) + "%" + (pct >= 100 ? ";background:var(--go)" : "")}));
}
function viewScorecard() {
  const wrap = h("div");
  if (!ACT.loading && ACT.loadedFor !== ACT.days) loadActivity(ACT.days);
  const Y = S.year;
  const yearsSet = new Set([THIS_YEAR]); for (const d of S.deals) if (d.close_date) yearsSet.add(Number(d.close_date.slice(0, 4)));
  wrap.append(h("div", {class:"toolbar"}, h("h2", null, isAdmin() ? "Team scorecard" : "My team scorecard"),
    h("select", {"aria-label":"Year", id:"sc-year", onchange: e => { S.year = Number(e.target.value); render(); }}, [...yearsSet].sort((a, b) => b - a).map(y => h("option", {value:String(y), selected:Y === y}, String(y)))),
    h("select", {"aria-label":"Activity window", id:"sc-days", onchange: e => { ACT.days = Number(e.target.value); render(); }},
      [7, 30, 90].map(n => h("option", {value:String(n), selected:ACT.days === n}, "Activity: last " + n + " days")))));
  wrap.append(h("p", {class:"muted", style:"margin:-6px 0 12px"}, "Results count deals each person owns, closed in " + Y + ". Pipeline and bids are as of today. Activity is notes they logged. Pick a name to open their dashboard."));
  const people = myTeam();
  const rows = people.map(p => {
    const own = S.deals.filter(d => d.owner_id === p.id);
    const yr = yearResults(own, Y), st = stats(own);
    const t = targetFor(p.id, Y), target = t ? Number(t.won_value) : 0;
    const bidsDue = st.open.filter(d => { const n = daysUntil(d.bid_due); return n != null && n >= 0 && n <= 30; }).length;
    const shared = S.members.filter(m => m.user_id === p.id).length;
    const acts = (ACT.rows || []).filter(n => n.author_id === p.id);
    const k = kind => acts.filter(n => n.kind === kind).length;
    const lastNote = acts.reduce((m, n) => n.created_at > m ? n.created_at : m, "");
    const lastDeal = own.reduce((m, d) => (d.updated_at || "") > m ? d.updated_at : m, "");
    const last = [lastNote, lastDeal].sort().pop();
    const overdue = S.tasks.filter(x => !x.done && x.assignee_id === p.id && daysUntil(x.due) < 0).length;
    return {p, yr, st, target, bidsDue, shared, acts, k, last, overdue};
  }).sort((a, b) => b.yr.wonV - a.yr.wonV || b.st.pipe - a.st.pipe);
  const tot = rows.reduce((a, r) => ({won:a.won + r.yr.wonV, w:a.w + r.yr.won.length, l:a.l + r.yr.lost.length, open:a.open + r.st.open.length, pipe:a.pipe + r.st.pipe, wtd:a.wtd + r.st.wtd,
    due:a.due + r.bidsDue, gng:a.gng + r.st.pendingGng.length, act:a.act + r.acts.length, od:a.od + r.overdue}), {won:0, w:0, l:0, open:0, pipe:0, wtd:0, due:0, gng:0, act:0, od:0});
  const teamTarget = isAdmin() ? Number((targetFor(null, Y) || {}).won_value || 0) : rows.reduce((a, r) => a + r.target, 0);
  const cell = (v, attrs) => h("td", Object.assign({class:"num"}, attrs || {}), v);
  const actCell = r => ACT.rows == null ? cell("…") : h("td", {class:"num", title: NOTE_KINDS.map(([v, l]) => l + ": " + r.k(v)).join(" · ")},
    String(r.acts.length), h("div", {class:"muted", style:"font-size:11px;white-space:nowrap"}, plural(r.k("call"), "call") + " · " + plural(r.k("meeting"), "meeting") + " · " + plural(r.k("site_visit"), "visit")));
  wrap.append(h("div", {class:"tbl-wrap"}, h("table", {class:"scorecard"},
    h("thead", null,
      h("tr", null, h("th", null, ""), h("th", {colspan:"4", class:"grp"}, Y + " results"), h("th", {colspan:"5", class:"grp"}, "Pipeline today"), h("th", {colspan:"3", class:"grp"}, "Activity")),
      h("tr", null, h("th", null, "Person"), ...["Target","Won","Won / lost","Win rate","Open deals","Pipeline","Weighted","Bids due 30d","Need go/no-go","Notes logged","Overdue tasks","Last active"].map(t => h("th", {class:"num"}, t)))),
    h("tbody", null, rows.map(r => {
      const pct = r.target ? Math.round(r.yr.wonV / r.target * 100) : null;
      return h("tr", {class:"click", tabindex:"0", onclick:() => { S.ownerFilter = r.p.id; S.view = "dashboard"; renderNow(); }, onkeydown: e => { if (e.key === "Enter") { S.ownerFilter = r.p.id; S.view = "dashboard"; renderNow(); } }},
        h("td", null, h("div", {style:"font-weight:600;white-space:nowrap"}, r.p.full_name || r.p.email), h("div", {class:"muted", style:"font-size:12px"}, [(JOB_ROLES.find(x => x[0] === r.p.job_role) || [, reportsOf(r.p.id).length ? "Manager" : "Rep"])[1], r.p.role === "admin" ? "admin" : null].filter(Boolean).join(" · "), r.shared ? " · on " + plural(r.shared, "other deal") + " as team" : "")),
        cell(r.target ? money(r.target, true) : "—"),
        h("td", {class:"num"}, money(r.yr.wonV, true), pct != null ? h("div", null, miniBar(pct), h("div", {class:"muted", style:"font-size:11px"}, pct + "% of target")) : null),
        cell(r.yr.won.length + " / " + r.yr.lost.length),
        cell(r.yr.rate == null ? "—" : r.yr.rate + "%"),
        cell(String(r.st.open.length)), cell(money(r.st.pipe, true)), cell(money(r.st.wtd, true)),
        cell(String(r.bidsDue)),
        cell(String(r.st.pendingGng.length), r.st.pendingGng.length ? {style:"color:var(--warn)"} : null),
        actCell(r),
        cell(String(r.overdue), r.overdue ? {style:"color:var(--bad)"} : null),
        cell(r.last ? fmtDate(r.last.slice(0, 10)) : "—", r.last && daysUntil(r.last.slice(0, 10)) < -14 ? {style:"color:var(--warn)", title:"No activity in over two weeks"} : null));
    })),
    h("tfoot", null, h("tr", {style:"font-weight:600"}, h("td", null, "Team"),
      cell(teamTarget ? money(teamTarget, true) : "—"),
      h("td", {class:"num"}, money(tot.won, true), teamTarget ? h("div", {class:"muted", style:"font-size:11px"}, Math.round(tot.won / teamTarget * 100) + "% of " + (isAdmin() ? "company" : "team") + " target") : null),
      cell(tot.w + " / " + tot.l), cell(tot.w + tot.l ? Math.round(tot.w / (tot.w + tot.l) * 100) + "%" : "—"),
      cell(String(tot.open)), cell(money(tot.pipe, true)), cell(money(tot.wtd, true)), cell(String(tot.due)), cell(String(tot.gng)),
      cell(ACT.rows == null ? "…" : String(tot.act)), cell(String(tot.od)), cell(""))))));
  if (!rows.length) wrap.append(h("div", {class:"panel"}, emptyState("No one on the team yet", "Create logins in Supabase; people appear here after their first sign-in.")));

  // sales engineering: deals each person supports as a sales engineer
  const teamIds = new Set(people.map(p => p.id));
  const seRows = people.map(p => {
    const ids = new Set(S.members.filter(m => m.user_id === p.id && m.role === "sales_engineer").map(m => m.deal_id));
    const ds = S.deals.filter(d => ids.has(d.id));
    return {p, ds, open:ds.filter(isOpen), yr:yearResults(ds, Y)};
  }).filter(r => r.ds.length || r.p.job_role === "sales_engineer").sort((a, b) => b.open.length - a.open.length);
  const noSE = S.deals.filter(d => isOpen(d) && ["proposal","submitted","negotiation"].includes(d.stage) && teamIds.has(d.owner_id) && !membersWithRole(d.id, "sales_engineer").length);
  wrap.append(h("div", {class:"panel", style:"margin-top:16px"}, h("h3", null, "Sales engineering"),
    h("p", {class:"hint"}, "Deals each person is on as a sales engineer. Results count deals closed in " + Y + "; open deals are as of today."),
    seRows.length ? h("div", {class:"tbl-wrap", style:"border:0"}, h("table", null,
      h("thead", null, h("tr", null, h("th", null, "Sales engineer"), ...["Open deals","Open pipeline","Bids due 30d","Won / lost","Win rate","Won value"].map(t => h("th", {class:"num"}, t)))),
      h("tbody", null, seRows.map(r => h("tr", null, h("td", {style:"font-weight:600"}, r.p.full_name || r.p.email),
        cell(String(r.open.length)), cell(money(r.open.reduce((a, d) => a + (Number(d.value) || 0), 0), true)),
        cell(String(r.open.filter(d => { const n = daysUntil(d.bid_due); return n != null && n >= 0 && n <= 30; }).length)),
        cell(r.yr.won.length + " / " + r.yr.lost.length), cell(r.yr.rate == null ? "—" : r.yr.rate + "%"), cell(money(r.yr.wonV, true)))))))
      : h("div", {class:"muted"}, "No sales engineers assigned yet. Add them on each deal's Deal team tab, and set job roles in Team."),
    noSE.length ? h("div", {style:"margin-top:12px"}, h("div", {class:"lab", style:"margin-bottom:4px;color:var(--warn)"}, plural(noSE.length, "deal") + " in proposal or later with no sales engineer"),
      h("div", null, noSE.map(d => h("div", {class:"list-row"}, h("button", {class:"linkish", onclick:() => openDeal(d.id, "p")}, d.name), h("span", {class:"muted", style:"font-size:12px"}, personName(d.owner_id) + " · " + STAGE[d.stage].name))))) : null));
  return wrap;
}

// ---------------------------------------------------------------- deals
function filterDeals(list) {
  const q = S.q.trim().toLowerCase();
  return list.filter(d => {
    if (S.ownerFilter && d.owner_id !== S.ownerFilter && !membersOf(d.id).includes(S.ownerFilter)) return false;
    if (!q) return true;
    return [d.name, acctName(d.account_id), d.rfp_no, personName(d.owner_id), (d.services || []).join(" "), d.vertical].join(" ").toLowerCase().includes(q);
  });
}
function dealToolbar(title, extra) {
  return h("div", {class:"toolbar"}, h("h2", null, title),
    h("input", {type:"search", id:"q-" + S.view, placeholder:"Search deals, accounts, RFP #", value:S.q, "aria-label":"Search", oninput: e => { S.q = e.target.value; render(); }}),
    h("select", {"aria-label":"Person", id:"own-" + S.view, onchange: e => { S.ownerFilter = e.target.value; render(); }},
      h("option", {value:""}, "Everyone"), activePeople().map(p => h("option", {value:p.id, selected:S.ownerFilter === p.id}, p.full_name || p.email))),
    extra || null);
}
function viewPipeline() {
  const wrap = h("div");
  wrap.append(dealToolbar("Pipeline"));
  if (!S.deals.length) { wrap.append(h("div", {class:"panel"}, emptyState("No deals yet", "Add your first pursuit, or import a spreadsheet from Go/no-go & import.", h("button", {class:"btn primary", onclick:() => openDeal()}, "+ New deal")))); return wrap; }
  const deals = filterDeals(S.deals);
  const board = h("div", {class:"board"});
  for (const s of STAGES.filter(s => s.open || s.id === "won")) {
    const ds = deals.filter(d => d.stage === s.id).sort((a, b) => (a.bid_due || "9999").localeCompare(b.bid_due || "9999"));
    const tot = ds.reduce((a, d) => a + (Number(d.value) || 0), 0);
    const col = h("div", {class:"col"}, h("div", {class:"col-h"}, h("b", null, s.name), h("span", null, ds.length + " · " + money(tot, true))), ds.map(dealCard));
    col.addEventListener("dragover", e => { e.preventDefault(); col.classList.add("drop"); });
    col.addEventListener("dragleave", () => col.classList.remove("drop"));
    col.addEventListener("drop", e => { e.preventDefault(); col.classList.remove("drop"); moveStage(e.dataTransfer.getData("text/plain"), s.id); });
    board.append(col);
  }
  wrap.append(h("div", {class:"board-scroll"}, board));
  wrap.append(h("div", {class:"closed-row"}, h("span", null, "Closed out:"),
    STAGES.filter(s => !s.open && s.id !== "won").map(s => h("button", {class:"btn small", onclick:() => { S.view = "deals"; S.stageFilter = s.id; renderNow(); }}, s.name + ": " + deals.filter(d => d.stage === s.id).length))));
  return wrap;
}
function dealCard(d) {
  const shared = membersOf(d.id).length;
  const c = h("button", {class:"card", draggable:"true", onclick:() => openDeal(d.id)},
    h("div", {class:"t"}, d.name || "Untitled deal"),
    h("div", {class:"a"}, [acctName(d.account_id), d.rfp_no].filter(Boolean).join(" · ") || "No account"),
    h("div", {class:"row"}, h("span", {class:"mono"}, money(d.value)), h("span", {class:"chips"}, gngChip(d), d.bid_due ? dueChip(d.bid_due) : null)),
    h("div", {class:"row muted"}, h("span", null, personName(d.owner_id) + (seNames(d.id) ? " · SE: " + seNames(d.id) : shared ? " +" + shared : "")), h("span", null, (d.services || []).slice(0, 3).join(", "))));
  c.addEventListener("dragstart", e => e.dataTransfer.setData("text/plain", d.id));
  return c;
}
async function moveStage(id, stage) {
  const d = byId(S.deals, id); if (!d || d.stage === stage) return;
  if (!STAGE[stage].open) { openCloseOut(d, stage); return; }
  const patch = {stage, probability:null};
  const before = {...d}; Object.assign(d, patch); render();
  const ok = await run(sb.from("deals").update(patch).eq("id", id), "Moved to " + STAGE[stage].name);
  if (!ok) { Object.assign(d, before); render(); }
}
function viewDeals() {
  const wrap = h("div");
  const sf = h("select", {"aria-label":"Stage", id:"stagef", onchange: e => { S.stageFilter = e.target.value; render(); }},
    [["open","Open deals"],["all","All stages"], ...STAGES.map(s => [s.id, s.name])].map(([v, t]) => h("option", {value:v, selected:S.stageFilter === v}, t)));
  wrap.append(dealToolbar("Deals", sf));
  const ds = filterDeals(S.deals).filter(d => S.stageFilter === "all" ? true : S.stageFilter === "open" ? isOpen(d) : d.stage === S.stageFilter)
    .sort((a, b) => (a.bid_due || "9999").localeCompare(b.bid_due || "9999"));
  if (!ds.length) { wrap.append(h("div", {class:"tbl-wrap"}, emptyState(S.deals.length ? "No deals match these filters" : "No deals yet", S.deals.length ? "Clear the search or change the filters." : "Add a deal to start tracking your pipeline."))); return wrap; }
  const tot = ds.reduce((a, d) => a + (Number(d.value) || 0), 0);
  wrap.append(h("div", {class:"tbl-wrap"}, h("table", null,
    h("thead", null, h("tr", null, ["Deal","Account","Stage","Go/no-go"].map(t => h("th", null, t)), h("th", {class:"num"}, "Value"), h("th", {class:"num"}, "Prob."), h("th", null, "Bid due"), h("th", null, "Account manager"), h("th", null, "Sales engineer"))),
    h("tbody", null, ds.map(d => h("tr", {class:"click", tabindex:"0", onclick:() => openDeal(d.id), onkeydown: e => { if (e.key === "Enter") openDeal(d.id); }},
      h("td", null, h("div", {style:"font-weight:600"}, d.name), h("div", {class:"muted", style:"font-size:12px"}, (d.services || []).join(", "))),
      h("td", null, acctName(d.account_id) || "—"),
      h("td", null, h("span", {class:"chip" + (d.stage === "won" ? " go" : d.stage === "lost" || d.stage === "nobid" ? " bad" : " acc")}, (STAGE[d.stage] || STAGE.lead).name),
        !isOpen(d) && d.outcome_reason ? h("div", {class:"muted", style:"font-size:12px;margin-top:2px"}, d.outcome_reason) : null),
      h("td", null, gngChip(d) || h("span", {class:"muted"}, "—")),
      h("td", {class:"num"}, money(d.value)), h("td", {class:"num"}, prob(d) + "%"),
      h("td", null, d.bid_due ? dueChip(d.bid_due) : "—"),
      h("td", null, personName(d.owner_id)),
      h("td", null, seNames(d.id) || h("span", {class:"muted"}, "—"))))),
    h("tfoot", null, h("tr", null, h("td", {colspan:"4", class:"muted"}, plural(ds.length, "deal")), h("td", {class:"num"}, money(tot)), h("td", {colspan:"4"}))))));
  return wrap;
}

// ---------------------------------------------------------------- accounts & contacts
function viewAccounts() {
  const wrap = h("div");
  wrap.append(h("div", {class:"toolbar"}, h("h2", null, "Accounts"),
    h("input", {type:"search", id:"q-acc", placeholder:"Search accounts", value:S.q, oninput: e => { S.q = e.target.value; render(); }}),
    h("button", {class:"btn primary", onclick:() => openAccount()}, "+ Account")));
  const q = S.q.trim().toLowerCase();
  const list = S.accounts.filter(a => !q || [a.name, a.type, a.vertical, a.city].join(" ").toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name));
  if (!list.length) { wrap.append(h("div", {class:"tbl-wrap"}, emptyState(S.accounts.length ? "No accounts match" : "No accounts yet", "Owners, GCs, integrators and partners you sell to or through."))); return wrap; }
  wrap.append(h("div", {class:"tbl-wrap"}, h("table", null,
    h("thead", null, h("tr", null, h("th", null, "Account"), h("th", null, "Type"), h("th", null, "Vertical"), h("th", null, "Location"), h("th", {class:"num"}, "Your open deals"), h("th", {class:"num"}, "Open value"))),
    h("tbody", null, list.map(a => { const op = S.deals.filter(d => d.account_id === a.id && isOpen(d));
      return h("tr", {class:"click", tabindex:"0", onclick:() => openAccount(a.id), onkeydown: e => { if (e.key === "Enter") openAccount(a.id); }},
        h("td", {style:"font-weight:600"}, a.name), h("td", null, a.type || "—"), h("td", null, a.vertical || "—"), h("td", null, [a.city, a.state].filter(Boolean).join(", ") || "—"),
        h("td", {class:"num"}, String(op.length)), h("td", {class:"num"}, money(op.reduce((x, d) => x + (Number(d.value) || 0), 0)))); })))));
  return wrap;
}
function viewContacts() {
  const wrap = h("div");
  wrap.append(h("div", {class:"toolbar"}, h("h2", null, "Contacts"),
    h("input", {type:"search", id:"q-con", placeholder:"Search contacts", value:S.q, oninput: e => { S.q = e.target.value; render(); }}),
    h("button", {class:"btn primary", onclick:() => openContact()}, "+ Contact")));
  const q = S.q.trim().toLowerCase();
  const list = S.contacts.filter(c => !q || [c.name, c.title, acctName(c.account_id), c.email].join(" ").toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name));
  if (!list.length) { wrap.append(h("div", {class:"tbl-wrap"}, emptyState(S.contacts.length ? "No contacts match" : "No contacts yet", "People at your accounts: procurement, PMs, IT directors, GC estimators."))); return wrap; }
  wrap.append(h("div", {class:"tbl-wrap"}, h("table", null,
    h("thead", null, h("tr", null, ["Name","Title","Account","Email","Phone"].map(t => h("th", null, t)))),
    h("tbody", null, list.map(c => h("tr", {class:"click", tabindex:"0", onclick:() => openContact(c.id), onkeydown: e => { if (e.key === "Enter") openContact(c.id); }},
      h("td", {style:"font-weight:600"}, c.name), h("td", null, c.title || "—"), h("td", null, acctName(c.account_id) || "—"),
      h("td", {class:"mono", style:"font-size:12.5px"}, c.email ? h("a", {href:"mailto:" + c.email, onclick: e => e.stopPropagation()}, c.email) : "—"),
      h("td", {class:"mono", style:"font-size:12.5px"}, c.phone ? h("a", {href:"tel:" + c.phone, onclick: e => e.stopPropagation()}, c.phone) : "—")))))));
  return wrap;
}

// ---------------------------------------------------------------- tasks
function taskRow(t) {
  return h("div", {class:"task" + (t.done ? " done" : "")},
    h("input", {type:"checkbox", checked:!!t.done, "aria-label":"Mark done", onchange: e => toggleTask(t, e.target.checked)}),
    h("div", {class:"body"},
      h("button", {class:"linkish title", style:"color:inherit;font-weight:500", onclick:() => openTask(t.id)}, t.title),
      h("div", {class:"meta"}, t.due ? (t.done ? h("span", null, fmtDate(t.due)) : dueChip(t.due)) : h("span", null, "No date"),
        t.assignee_id ? h("span", null, personName(t.assignee_id)) : null,
        t.deal_id ? h("button", {class:"linkish", onclick:() => openDeal(t.deal_id)}, dealName(t.deal_id) || "Deal") : null)));
}
async function toggleTask(t, done) {
  t.done = done; render(); refreshDrawer();
  await run(sb.from("tasks").update({done, done_at: done ? new Date().toISOString() : null}).eq("id", t.id));
}
function viewTasks() {
  const wrap = h("div");
  wrap.append(h("div", {class:"toolbar"}, h("h2", null, "Tasks & follow-ups"),
    h("select", {"aria-label":"Assignee", id:"own-t", onchange: e => { S.ownerFilter = e.target.value; render(); }},
      h("option", {value:""}, "Everyone"), activePeople().map(p => h("option", {value:p.id, selected:S.ownerFilter === p.id}, p.full_name || p.email))),
    h("button", {class:"btn primary", onclick:() => openTask()}, "+ Task")));
  const ts = S.tasks.filter(t => !S.ownerFilter || t.assignee_id === S.ownerFilter);
  if (!ts.length) { wrap.append(h("div", {class:"panel"}, emptyState("No tasks yet", "Follow-ups, walkthroughs, question deadlines and submittals. Add them here or from a deal."))); return wrap; }
  const open = ts.filter(t => !t.done).sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));
  const groups = [["Overdue", open.filter(t => daysUntil(t.due) < 0)], ["Today", open.filter(t => daysUntil(t.due) === 0)],
    ["Next 7 days", open.filter(t => { const n = daysUntil(t.due); return n > 0 && n <= 7; })],
    ["Later", open.filter(t => { const n = daysUntil(t.due); return n == null || n > 7; })],
    ["Done recently", ts.filter(t => t.done).sort((a, b) => (b.done_at || "").localeCompare(a.done_at || "")).slice(0, 15)]];
  wrap.append(h("div", {class:"task-groups"}, groups.filter(g => g[1].length).map(([name, list]) => h("div", {class:"tg"}, h("h3", null, name, h("span", null, String(list.length))), list.map(taskRow)))));
  return wrap;
}

// ---------------------------------------------------------------- drawer
let drawerClose = null, drawerRefresh = null, openNotes = null;
function openDrawer({title, tabs, body, foot, start}) {
  closeDrawer();
  const layer = $("#layer");
  const bodyBox = h("div", {class:"d-body"});
  let active = tabs ? (start && tabs.some(t => t[0] === start) ? start : tabs[0][0]) : null;
  const tabBar = tabs ? h("div", {class:"d-tabs", role:"tablist"}) : null;
  function show() {
    if (tabs) {
      tabBar.replaceChildren(...tabs.map(([id, name]) => h("button", {role:"tab", "aria-selected": String(id === active), onclick:() => { active = id; show(); }}, name)));
      bodyBox.replaceChildren(tabs.find(t => t[0] === active)[2]());
    } else bodyBox.replaceChildren(body);
  }
  const dr = h("aside", {class:"drawer", role:"dialog", "aria-modal":"true", "aria-label":title},
    h("div", {class:"d-head"}, h("h2", null, title), h("button", {class:"btn small", onclick:() => closeDrawer()}, "Close")),
    tabBar, bodyBox, foot ? h("div", {class:"d-foot"}, foot) : null);
  show();
  layer.replaceChildren(h("div", {class:"scrim", onclick:() => closeDrawer()}), dr);
  const esc = e => { if (e.key === "Escape") closeDrawer(); };
  document.addEventListener("keydown", esc);
  drawerClose = () => { document.removeEventListener("keydown", esc); layer.replaceChildren(); drawerClose = null; drawerRefresh = null; openNotes = null; };
  drawerRefresh = () => { if (tabs && active !== "d" && active !== "g") show(); };
  const f = dr.querySelector("input,select,textarea"); if (f) setTimeout(() => f.focus(), 30);
}
function closeDrawer() { if (drawerClose) drawerClose(); }
function refreshDrawer() { if (drawerRefresh) drawerRefresh(); }

function fld(draft, key, label, type, opts = {}) {
  let input; const ro = !!opts.readonly;
  if (type === "select") {
    input = h("select", {id:"f-" + key, disabled:ro, onchange: e => { draft[key] = e.target.value || null; opts.onchange && opts.onchange(); }},
      opts.blank !== false ? h("option", {value:""}, opts.blank || "—") : null,
      (opts.options || []).map(o => { const [v, t] = Array.isArray(o) ? o : [o, o]; return h("option", {value:v, selected:(draft[key] || "") === v}, t); }));
  } else if (type === "textarea") {
    input = h("textarea", {id:"f-" + key, readonly:ro, oninput: e => { draft[key] = e.target.value; }}); input.value = draft[key] || "";
  } else if (type === "chips") {
    const cur = new Set(draft[key] || []);
    input = h("div", {class:"pick", role:"group", "aria-label":label}, (opts.options || []).map(o => h("button", {type:"button", "aria-pressed": String(cur.has(o)), disabled:ro,
      onclick: e => { cur.has(o) ? cur.delete(o) : cur.add(o); draft[key] = [...cur]; e.currentTarget.setAttribute("aria-pressed", String(cur.has(o))); }}, o)));
  } else {
    input = h("input", {id:"f-" + key, type: type || "text", readonly:ro, step: type === "number" ? "any" : null, placeholder: opts.placeholder || null,
      oninput: e => { draft[key] = type === "number" ? (e.target.value === "" ? null : Number(e.target.value)) : e.target.value; }});
    input.value = draft[key] == null ? "" : draft[key];
  }
  return h("div", {class:"field" + (opts.full ? " full" : "")}, h("label", {for: type === "chips" ? null : "f-" + key}, label), input);
}
const acctOptions = () => S.accounts.slice().sort((a, b) => a.name.localeCompare(b.name)).map(a => [a.id, a.name]);
const contactOptions = acctId => S.contacts.filter(c => !acctId || c.account_id === acctId || !c.account_id).sort((a, b) => a.name.localeCompare(b.name)).map(c => [c.id, c.name + (c.title ? " · " + c.title : "")]);
const peopleOptions = () => activePeople().map(p => [p.id, p.full_name || p.email]);
function deleteButton(onConfirm) {
  const del = h("button", {class:"btn danger spacer", onclick:() => {
    if (del.dataset.armed) onConfirm();
    else { del.dataset.armed = "1"; del.textContent = "Click again to delete"; setTimeout(() => { del.dataset.armed = ""; del.textContent = "Delete"; }, 3000); }
  }}, "Delete");
  return del;
}

// ---------------------------------------------------------------- close-out (won / lost / no-bid)
function outcomeFields(draft) {
  const st = draft.stage;
  if (!st || STAGE[st].open) return null;
  if (draft.outcome_reason && !reasonsFor(st).includes(draft.outcome_reason)) draft.outcome_reason = null;
  const req = st !== "won";
  return h("div", {style:"grid-column:1/-1"},
    h("div", {class:"section-h", style:"margin:8px 0"}, st === "won" ? "Why we won" : st === "lost" ? "Why we lost" : "Why we didn't bid"),
    h("div", {class:"form"},
      fld(draft, "outcome_reason", (st === "won" ? "Main reason" : "Reason") + (req ? " (required)" : ""), "select", {options:reasonsFor(st), blank:"Choose a reason", full: st !== "lost"}),
      st === "lost" ? fld(draft, "winning_competitor", "Who won it", "text", {placeholder:"Company, if known"}) : null,
      st === "lost" ? fld(draft, "winning_price", "Their price (USD), if known", "number") : null,
      fld(draft, "outcome_notes", st === "won" ? "What made the difference" : "What would we do differently next time", "textarea", {full:true})));
}
function needsReason(d) { return (d.stage === "lost" || d.stage === "nobid") && !(d.outcome_reason || "").trim(); }
function openCloseOut(d, stage) {
  const draft = {stage, outcome_reason:null, winning_competitor:d.winning_competitor || null, winning_price:d.winning_price ?? null,
    outcome_notes:d.outcome_notes || "", close_date:d.close_date || todayStr()};
  openDrawer({title:"Mark " + STAGE[stage].name.toLowerCase(),
    body:h("div", null, h("p", {class:"muted", style:"margin-top:0"}, d.name),
      h("div", {class:"form"}, fld(draft, "close_date", stage === "won" ? "Award date" : "Close date", "date"), outcomeFields(draft))),
    foot:[h("button", {class:"btn spacer", onclick:() => closeDrawer()}, "Cancel"), h("button", {class:"btn primary", onclick: async () => {
      if (needsReason(draft)) { toast("Pick a reason first."); return; }
      const patch = {stage, probability:null, close_date:draft.close_date || todayStr(), outcome_reason:nullify(draft.outcome_reason),
        winning_competitor:nullify((draft.winning_competitor || "").trim()), winning_price:nullify(draft.winning_price), outcome_notes:nullify((draft.outcome_notes || "").trim())};
      const res = await run(sb.from("deals").update(patch).eq("id", d.id).select().single(), "Marked " + STAGE[stage].name.toLowerCase());
      if (res) { Object.assign(d, res); render(); closeDrawer(); }
    }}, "Save")]});
}

// ---------------------------------------------------------------- deal drawer
function openDeal(id, startTab) {
  const src = id ? byId(S.deals, id) : null;
  if (id && !src) { toast("That deal isn't available to you."); return; }
  const draft = JSON.parse(JSON.stringify(src || {stage:"lead", services:[], owner_id:S.me.id, gng:{scores:{}}}));
  draft.gng = draft.gng || {scores:{}}; draft.gng.scores = draft.gng.scores || {};
  const manage = !src || canManage(src);

  const details = () => {
    const contactBox = h("div", {style:"display:contents"});
    const drawContacts = () => contactBox.replaceChildren(fld(draft, "contact_id", "Primary contact", "select", {options:contactOptions(draft.account_id)}));
    drawContacts();
    const outcomeBox = h("div", {style:"display:contents"});
    const drawOutcome = () => outcomeBox.replaceChildren(...[outcomeFields(draft)].filter(Boolean));
    drawOutcome();
    return h("div", {class:"form"},
      fld(draft, "name", "Deal name", "text", {full:true, placeholder:"e.g. Camping World Stadium CNS"}),
      fld(draft, "account_id", "Account", "select", {options:acctOptions(), blank:"Choose an account", onchange:drawContacts}),
      contactBox,
      fld(draft, "stage", "Stage", "select", {options:STAGES.map(s => [s.id, s.name]), blank:false, onchange:() => drawOutcome()}),
      fld(draft, "owner_id", "Account manager", "select", {options:peopleOptions(), blank:false, readonly: src ? !manage : !isAdmin()}),
      fld(draft, "value", "Value (USD)", "number"),
      fld(draft, "probability", "Probability % (blank = stage default)", "number"),
      fld(draft, "bid_due", "Bid / proposal due", "date"),
      fld(draft, "close_date", "Expected close / award", "date"),
      fld(draft, "rfp_no", "RFP / bid #", "text"),
      fld(draft, "source", "Source", "select", {options:SOURCES}),
      fld(draft, "vertical", "Vertical", "select", {options:VERTICALS, full:true}),
      fld(draft, "services", "Service lines", "chips", {options:SERVICES, full:true}),
      fld(draft, "description", "Scope summary", "textarea", {full:true}),
      outcomeBox);
  };

  const gng = () => {
    const box = h("div");
    const draw = () => {
      const s = gngScore(draft); const t = S.gng.threshold;
      const color = s.pct == null ? "var(--muted)" : s.pct >= t.go ? "var(--go)" : s.pct >= t.review ? "var(--warn)" : "var(--bad)";
      const rec = s.pct == null ? "Score each criterion 1–5" : s.pct >= t.go ? "Recommendation: GO" : s.pct >= t.review ? "Recommendation: discuss before committing" : "Recommendation: NO-GO";
      box.replaceChildren(
        h("div", {class:"gauge"}, h("div", {class:"big", style:"color:" + color}, s.pct == null ? "—" : s.pct + "%"),
          h("div", {style:"flex:1;min-width:160px"}, h("div", {style:"font-weight:600;margin-bottom:6px"}, rec),
            h("div", {class:"gbar"}, h("i", {style:"width:" + (s.pct || 0) + "%;background:" + color})),
            h("div", {class:"muted", style:"font-size:12px;margin-top:4px"}, s.scored + " of " + s.total + " criteria scored · Go at " + t.go + "%, review at " + t.review + "%"))),
        h("div", null, (S.gng.criteria || []).map(c => { const v = Number(draft.gng.scores[c.id]) || 0;
          return h("div", {class:"crit"}, h("div", null, h("div", null, c.name), h("div", {class:"w"}, "Weight " + c.weight)),
            h("div", {class:"score", role:"group", "aria-label":c.name}, [1,2,3,4,5].map(n => h("button", {type:"button", "aria-pressed": String(v === n),
              onclick:() => { draft.gng.scores[c.id] = v === n ? null : n; draw(); }}, String(n))))); })),
        h("div", {class:"form", style:"margin-top:14px"},
          fld(draft.gng, "decision", "Decision", "select", {options:[["go","Go"],["nogo","No-go"],["hold","Hold / need info"]], blank:"Not decided"}),
          fld(draft.gng, "decided_on", "Decided on", "date"),
          fld(draft.gng, "rationale", "Rationale", "textarea", {full:true})),
        h("p", {class:"muted", style:"font-size:12px;margin-top:10px"}, "Saved with the deal. Use Save below."));
    };
    draw(); return box;
  };

  const people = () => {
    const box = h("div");
    if (!src) { box.append(h("div", {class:"muted"}, "Save the deal first, then add the sales engineer and anyone else working it.")); return box; }
    const cur = byId(S.deals, src.id) || src;
    const rows = S.members.filter(m => m.deal_id === cur.id);
    const manage = canManage(cur);
    const avatar = uid => h("div", {class:"av"}, initials(uid));
    box.append(h("p", {class:"hint muted", style:"margin-top:0"}, "Only the people on this deal, their managers, and admins can see it and its notes and tasks."));
    box.append(h("div", {class:"person"}, avatar(cur.owner_id), h("div", {class:"who"}, personName(cur.owner_id), h("small", null, ((person(cur.owner_id) || {}).email || "") + " · Account manager (owner)"))));
    for (const m of rows) {
      const uid = m.user_id;
      const roleCtl = manage ? h("select", {class:"inp", style:"max-width:190px", "aria-label":"Role for " + personName(uid), onchange: async e => {
          const role = e.target.value;
          if (await run(sb.from("deal_members").update({role}).eq("deal_id", cur.id).eq("user_id", uid), personName(uid) + " is now " + dealRoleLabel(role).toLowerCase())) { m.role = role; render(); }
        }}, DEAL_ROLES.map(([v, t]) => h("option", {value:v, selected:(m.role || "support") === v}, t)))
        : h("span", {class:"chip"}, dealRoleLabel(m.role));
      box.append(h("div", {class:"person"}, avatar(uid),
        h("div", {class:"who"}, personName(uid), h("small", null, (person(uid) || {}).email || "")), roleCtl,
        manage || uid === S.me.id ? h("button", {class:"btn small", onclick: async () => {
          const ok = await run(sb.from("deal_members").delete().eq("deal_id", cur.id).eq("user_id", uid), uid === S.me.id ? "You left this deal" : "Removed");
          if (ok) { S.members = S.members.filter(x => !(x.deal_id === cur.id && x.user_id === uid)); render(); if (uid === S.me.id && !isAdmin() && !isManager()) closeDrawer(); else drawerRefresh(); }
        }}, uid === S.me.id && !manage ? "Leave" : "Remove") : null));
    }
    if (manage) {
      const taken = new Set([cur.owner_id, ...rows.map(m => m.user_id)]);
      const avail = activePeople().filter(p => !taken.has(p.id));
      const roleSel = h("select", {class:"inp", id:"addRole", "aria-label":"Role", style:"max-width:190px"}, DEAL_ROLES.map(([v, t]) => h("option", {value:v}, t)));
      const sel = h("select", {class:"inp", id:"addMember", "aria-label":"Person to add", onchange: e => { const p = person(e.target.value); if (p) roleSel.value = jobToDealRole(p.job_role); }},
        h("option", {value:""}, avail.length ? "Choose a person" : "Everyone is already on this deal"),
        avail.map(p => h("option", {value:p.id}, (p.full_name || p.email) + (p.job_role ? " · " + (JOB_ROLES.find(x => x[0] === p.job_role) || [,""])[1] : ""))));
      box.append(h("div", {class:"section-h", style:"margin-top:16px"}, "Add to the deal team"),
        h("div", {style:"display:flex;gap:8px;flex-wrap:wrap"}, sel, roleSel, h("button", {class:"btn primary", onclick: async () => {
          if (!sel.value) return;
          const row = {deal_id:cur.id, user_id:sel.value, added_by:S.me.id, role:roleSel.value};
          if (await run(sb.from("deal_members").insert(row), personName(sel.value) + " added as " + dealRoleLabel(row.role).toLowerCase())) { S.members.push(row); render(); drawerRefresh(); }
        }}, "Add")),
        h("p", {class:"muted", style:"font-size:12px"}, "To change the account manager, use the Details tab. People appear in this list after they've signed in to the CRM once."));
    } else box.append(h("p", {class:"muted", style:"font-size:13px;margin-top:12px"}, "Ask " + personName(cur.owner_id) + " or an admin to change who's on this deal."));
    return box;
  };

  const notes = () => {
    const box = h("div");
    if (!src) { box.append(h("div", {class:"muted"}, "Save the deal first to add notes.")); return box; }
    const ta = h("textarea", {class:"inp", id:"f-newnote", placeholder:"Call notes, walkthrough findings, competitor intel…"});
    const kindSel = h("select", {class:"inp", id:"f-notekind", "aria-label":"Type", style:"max-width:170px"}, NOTE_KINDS.map(([v, t]) => h("option", {value:v}, t)));
    const list = h("div", {style:"margin-top:14px"}, h("div", {class:"muted"}, "Loading notes…"));
    const load = async () => {
      const {data, error} = await sb.from("deal_notes").select("*").eq("deal_id", src.id).order("created_at", {ascending:false}).limit(300);
      if (error) { list.replaceChildren(h("div", {class:"muted"}, friendly(error))); return; }
      list.replaceChildren(...(data.length ? data.map(n => h("div", {class:"note"},
        h("div", {class:"m"}, fmtDateTime(n.created_at) + " · " + (n.author_id ? personName(n.author_id) : "System") + (n.kind && n.kind !== "note" ? " · " + kindLabel(n.kind) : "")),
        h("p", {class: n.system ? "muted" : null}, n.body))) : [h("div", {class:"muted"}, "No notes yet.")]));
    };
    openNotes = {dealId:src.id, reload:load};
    load();
    box.append(ta, h("div", {style:"margin-top:8px;display:flex;justify-content:flex-end;gap:8px"}, kindSel, h("button", {class:"btn", onclick: async () => {
      const body = ta.value.trim(); if (!body) return;
      if (await run(sb.from("deal_notes").insert({deal_id:src.id, body, author_id:S.me.id, kind:kindSel.value}), "Note added")) { ta.value = ""; kindSel.value = "note"; load(); }
    }}, "Add note")), list);
    return box;
  };

  const tasks = () => {
    const box = h("div");
    if (!src) { box.append(h("div", {class:"muted"}, "Save the deal first to add tasks.")); return box; }
    const ts = S.tasks.filter(t => t.deal_id === src.id).sort((a, b) => (a.done - b.done) || (a.due || "9999").localeCompare(b.due || "9999"));
    box.append(h("div", {style:"margin-bottom:10px"}, h("button", {class:"btn", onclick:() => openTask(null, {deal_id:src.id, assignee_id:S.me.id})}, "+ Task for this deal")));
    box.append(ts.length ? h("div", null, ts.map(taskRow)) : h("div", {class:"muted"}, "No tasks on this deal."));
    return box;
  };

  const foot = [];
  if (src && canManage(src)) foot.push(deleteButton(async () => { if (await run(sb.from("deals").delete().eq("id", src.id), "Deal deleted")) { S.deals = S.deals.filter(d => d.id !== src.id); render(); closeDrawer(); } }));
  foot.push(h("button", {class:"btn" + (src && canManage(src) ? "" : " spacer"), onclick:() => closeDrawer()}, "Cancel"));
  foot.push(h("button", {class:"btn primary", onclick: async e => {
    if (!(draft.name || "").trim()) { toast("Give the deal a name."); return; }
    if (needsReason(draft)) { toast("Pick a reason for marking it " + STAGE[draft.stage].name.toLowerCase() + " (Details tab)."); return; }
    if (!STAGE[draft.stage].open && !draft.close_date) draft.close_date = todayStr();
    const payload = {};
    for (const k of DEAL_FIELDS) payload[k] = k === "services" ? (draft.services || []) : k === "gng" ? draft.gng : nullify(draft[k]);
    payload.name = payload.name.trim();
    if (src && !canManage(src)) delete payload.owner_id;
    e.currentTarget.disabled = true;
    const res = src ? await run(sb.from("deals").update(payload).eq("id", src.id).select().single(), "Deal saved")
                    : await run(sb.from("deals").insert(payload).select().single(), "Deal created");
    e.currentTarget.disabled = false;
    if (!res) return;
    const i = S.deals.findIndex(d => d.id === res.id); if (i >= 0) S.deals[i] = res; else S.deals.push(res);
    render(); closeDrawer();
    if (!src) setTimeout(() => openDeal(res.id, "p"), 200);
  }}, src ? "Save" : "Create deal"));

  openDrawer({title: src ? src.name : "New deal", start:startTab,
    tabs:[["d","Details",details],["g","Go/no-go",gng],["p","Deal team",people],["n","Notes",notes],["t","Tasks",tasks]], foot});
}

// ---------------------------------------------------------------- account / contact / task drawers
function simpleDrawer(table, key, id, defaults, title, fields, extra, moreTabs) {
  const src = id ? byId(S[key], id) : null; if (id && !src) return;
  const draft = JSON.parse(JSON.stringify(src || defaults || {}));
  const body = h("div", null, h("div", {class:"form"}, fields(draft)), extra ? extra(src) : null);
  const foot = [];
  if (src) foot.push(deleteButton(async () => { if (await run(sb.from(table).delete().eq("id", src.id), "Deleted")) { S[key] = S[key].filter(x => x.id !== src.id); render(); closeDrawer(); } }));
  foot.push(h("button", {class:"btn" + (src ? "" : " spacer"), onclick:() => closeDrawer()}, "Cancel"));
  foot.push(h("button", {class:"btn primary", onclick: async e => {
    const req = table === "tasks" ? "title" : "name";
    if (!(draft[req] || "").trim()) { toast("Add a " + req + " first."); return; }
    const payload = {}; for (const [k, v] of Object.entries(draft)) if (!["id","created_at","updated_at","created_by"].includes(k)) payload[k] = nullify(typeof v === "string" ? v.trim() : v);
    e.currentTarget.disabled = true;
    const res = src ? await run(sb.from(table).update(payload).eq("id", src.id).select().single(), "Saved")
                    : await run(sb.from(table).insert(payload).select().single(), "Added");
    e.currentTarget.disabled = false;
    if (!res) return;
    const i = S[key].findIndex(x => x.id === res.id); if (i >= 0) S[key][i] = res; else S[key].push(res);
    render(); closeDrawer();
  }}, src ? "Save" : "Add"));
  const dTitle = src ? (src.name || src.title) : "New " + title.toLowerCase();
  if (src && moreTabs) openDrawer({title:dTitle, tabs:[["d","Details",() => body], ...moreTabs(src)], foot});
  else openDrawer({title:dTitle, body, foot});
}
function openAccount(id) {
  simpleDrawer("accounts", "accounts", id, {}, "Account", d => [
    fld(d, "name", "Account name", "text", {full:true}),
    fld(d, "type", "Type", "select", {options:ACCT_TYPES}),
    fld(d, "vertical", "Vertical", "select", {options:VERTICALS}),
    fld(d, "city", "City", "text"), fld(d, "state", "State", "text"),
    fld(d, "website", "Website", "text", {full:true}),
    fld(d, "notes", "Notes", "textarea", {full:true})],
  src => { if (!src) return null;
    const cs = S.contacts.filter(x => x.account_id === src.id);
    return h("div", null, h("div", {class:"section-h", style:"margin-top:20px"}, "Contacts"),
      cs.length ? cs.map(c => h("div", {class:"list-row"}, h("button", {class:"linkish", onclick:() => openContact(c.id)}, c.name), h("span", {class:"muted"}, c.title || ""))) : h("div", {class:"muted"}, "None."),
      h("div", {style:"margin-top:10px"}, h("button", {class:"btn small", onclick:() => openContact(null, {account_id:src.id})}, "+ Contact at this account"))); },
  src => [["h", "History", () => accountHistory(src)]]);
}
function accountHistory(src) {
  const box = h("div", null, h("div", {class:"muted"}, "Loading history…"));
  (async () => {
    const {data:tr} = await sb.rpc("account_track_record", {a:src.id});
    const t = tr || {};
    const ds = S.deals.filter(d => d.account_id === src.id)
      .sort((a, b) => (b.close_date || (b.created_at || "").slice(0, 10)).localeCompare(a.close_date || (a.created_at || "").slice(0, 10)));
    let notes = [];
    if (ds.length) {
      const r = await sb.from("deal_notes").select("*").in("deal_id", ds.map(d => d.id)).eq("system", false).order("created_at", {ascending:false}).limit(60);
      notes = r.data || [];
    }
    const decided = (t.won || 0) + (t.lost || 0);
    const hidden = (t.total || 0) - ds.length;
    const reasons = t.loss_reasons ? Object.entries(t.loss_reasons).map(([label, v]) => ({label, v})).sort((a, b) => b.v - a.v) : [];
    box.replaceChildren(...[
      h("div", {class:"strip mini"},
        metric("Deals", String(t.total ?? ds.length), (t.open || 0) + " open"),
        metric("Won", String(t.won || 0), t.won_value != null ? money(t.won_value, true) + " total" : "dollar totals: admins"),
        metric("Win rate", decided ? Math.round(t.won / decided * 100) + "%" : "—", (t.lost || 0) + " lost · " + (t.nobid || 0) + " no-bid"),
        metric("Last activity", t.last_activity ? fmtDate(t.last_activity.slice(0, 10)) : "—", t.first_deal ? "first deal " + fmtDate(t.first_deal.slice(0, 10)) : "")),
      reasons.length ? h("div", null, h("div", {class:"section-h"}, "Why we've lost here"), bars(reasons, v => String(v))) : null,
      h("div", {class:"section-h"}, isAdmin() ? "Every deal" : "Deals you're on"),
      ds.length ? h("div", null, ds.map(d => h("div", {class:"list-row"},
        h("div", {style:"min-width:0"}, h("button", {class:"linkish", onclick:() => openDeal(d.id)}, d.name),
          d.outcome_reason ? h("div", {class:"muted", style:"font-size:12px"}, d.outcome_reason + (d.winning_competitor ? " · went to " + d.winning_competitor : "")) : null),
        h("span", {class:"chips"}, d.close_date && !isOpen(d) ? h("span", {class:"muted", style:"font-size:12px"}, fmtDate(d.close_date)) : null,
          h("span", {class:"mono muted", style:"font-size:12px"}, money(d.value, true)),
          h("span", {class:"chip " + (d.stage === "won" ? "go" : d.stage === "lost" || d.stage === "nobid" ? "bad" : "acc")}, STAGE[d.stage].name)))))
        : h("div", {class:"muted"}, "No deals you can see."),
      hidden > 0 ? h("p", {class:"muted", style:"font-size:12px"}, plural(hidden, "other deal") + " with this account " + (hidden === 1 ? "isn't" : "aren't") + " shared with you. They're counted in the numbers above.") : null,
      h("div", {class:"section-h"}, "Recent activity"),
      notes.length ? h("div", null, notes.map(n => h("div", {class:"note"},
        h("div", {class:"m"}, fmtDateTime(n.created_at) + " · " + (n.author_id ? personName(n.author_id) : "") + " · " + kindLabel(n.kind) + " · " + dealName(n.deal_id)),
        h("p", null, n.body)))) : h("div", {class:"muted"}, "No notes yet.")].filter(Boolean));
  })();
  return box;
}
function openContact(id, defaults) {
  simpleDrawer("contacts", "contacts", id, defaults || {}, "Contact", d => [
    fld(d, "name", "Name", "text", {full:true}),
    fld(d, "title", "Title", "text"),
    fld(d, "account_id", "Account", "select", {options:acctOptions()}),
    fld(d, "email", "Email", "email"), fld(d, "phone", "Phone", "tel"),
    fld(d, "notes", "Notes", "textarea", {full:true})]);
}
function openTask(id, defaults) {
  simpleDrawer("tasks", "tasks", id, Object.assign({done:false, assignee_id:S.me.id}, defaults || {}), "Task", d => [
    fld(d, "title", "Task", "text", {full:true}),
    fld(d, "due", "Due", "date"),
    fld(d, "assignee_id", "Assigned to", "select", {options:peopleOptions()}),
    fld(d, "deal_id", "Deal", "select", {options: S.deals.filter(x => isOpen(x) || x.id === d.deal_id).sort((a, b) => a.name.localeCompare(b.name)).map(x => [x.id, x.name]), full:true}),
    fld(d, "notes", "Notes", "textarea", {full:true})]);
}
$("#newDeal").addEventListener("click", () => openDeal());

// ---------------------------------------------------------------- team (admins)
function viewTeam() {
  const wrap = h("div");
  wrap.append(h("div", {class:"toolbar"}, h("h2", null, "Team")),
    h("p", {class:"muted", style:"margin:-6px 0 12px"}, "Everyone with a CRM login. Admins see every deal. A manager (anyone with people reporting to them) sees their team's deals, tasks and targets, plus a team dashboard and scorecard. Turning someone off blocks their access right away; their deals stay put so you can reassign them."));
  const list = S.profiles.slice().sort((a, b) => (b.active - a.active) || (a.full_name || a.email).localeCompare(b.full_name || b.email));
  wrap.append(h("div", {class:"tbl-wrap"}, h("table", null,
    h("thead", null, h("tr", null, h("th", null, "Name"), h("th", null, "Email"), h("th", null, "Access level"), h("th", null, "Job role"), h("th", null, "Reports to"), h("th", null, "Access"), h("th", {class:"num"}, "Deals owned"), h("th"))),
    h("tbody", null, list.map(p => {
      const d = {full_name:p.full_name, role:p.role, active:p.active, manager_id:p.manager_id || null, job_role:p.job_role || null};
      const owned = S.deals.filter(x => x.owner_id === p.id).length;
      return h("tr", null,
        h("td", null, h("input", {class:"inp", id:"tn-" + p.id, value:p.full_name || "", "aria-label":"Name", oninput: e => { d.full_name = e.target.value; }})),
        h("td", {class:"mono", style:"font-size:12.5px"}, p.email),
        h("td", null, h("select", {class:"inp", "aria-label":"Role", onchange: e => { d.role = e.target.value; }}, h("option", {value:"rep", selected:p.role === "rep"}, "Rep"), h("option", {value:"admin", selected:p.role === "admin"}, "Admin"))),
        h("td", null, h("select", {class:"inp", "aria-label":"Job role", onchange: e => { d.job_role = e.target.value || null; }},
          h("option", {value:""}, "—"), JOB_ROLES.map(([v, t]) => h("option", {value:v, selected:p.job_role === v}, t)))),
        h("td", null, h("select", {class:"inp", "aria-label":"Reports to", onchange: e => { d.manager_id = e.target.value || null; }},
          h("option", {value:""}, "No one (sees own deals)"), activePeople().filter(x => x.id !== p.id).map(x => h("option", {value:x.id, selected:p.manager_id === x.id}, x.full_name || x.email)))),
        h("td", null, h("select", {class:"inp", "aria-label":"Access", onchange: e => { d.active = e.target.value === "on"; }}, h("option", {value:"on", selected:p.active}, "Active"), h("option", {value:"off", selected:!p.active}, "Turned off"))),
        h("td", {class:"num"}, owned ? h("button", {class:"linkish", onclick:() => { S.view = "deals"; S.stageFilter = "all"; S.ownerFilter = p.id; renderNow(); }}, String(owned)) : "0"),
        h("td", null, h("button", {class:"btn small", onclick: async () => {
          const res = await run(sb.from("profiles").update(d).eq("id", p.id).select().single(), "Saved");
          if (res) { Object.assign(p, res); if (p.id === S.me.id) S.me = p; render(); }
        }}, "Save")));
    })))));
  wrap.append(targetsPanel());
  return wrap;
}
function targetsPanel() {
  const box = h("div", {class:"panel", style:"margin-top:16px"});
  let year = S.year >= THIS_YEAR ? S.year : THIS_YEAR;
  const draw = () => {
    const vals = {};
    const row = (key, label) => { const t = targetFor(key === "company" ? null : key, year); vals[key] = t ? Number(t.won_value) : 0;
      const inp = h("input", {class:"inp mono", id:"tg-" + key, type:"number", min:"0", step:"1000", value: vals[key] ? String(vals[key]) : "", placeholder:"0", "aria-label":label + " target",
        oninput: e => { vals[key] = Number(e.target.value) || 0; }});
      return h("div", {class:"field"}, h("label", {for:"tg-" + key}, label), inp); };
    box.replaceChildren(
      h("div", {class:"toolbar", style:"margin-bottom:4px"}, h("h3", {style:"margin:0 auto 0 0"}, "Won-revenue targets"),
        h("select", {"aria-label":"Target year", id:"tg-year", onchange: e => { year = Number(e.target.value); draw(); }},
          [THIS_YEAR, THIS_YEAR + 1].map(y => h("option", {value:String(y), selected:year === y}, String(y))))),
      h("p", {class:"hint"}, "Set each January. Progress shows on the dashboard. Reps see their own target and the company target; only admins see everyone's."),
      h("div", {class:"form"}, row("company", "Company"), activePeople().map(p => row(p.id, p.full_name || p.email))),
      h("div", {style:"margin-top:12px;display:flex;justify-content:flex-end"}, h("button", {class:"btn primary", onclick: async e => {
        e.currentTarget.disabled = true; let ok = true;
        for (const [key, v] of Object.entries(vals)) {
          const uid = key === "company" ? null : key; const t = targetFor(uid, year);
          if (t && Number(t.won_value) !== v) ok = !!(await run(sb.from("targets").update({won_value:v, updated_at:new Date().toISOString()}).eq("id", t.id))) && ok;
          else if (!t && v > 0) ok = !!(await run(sb.from("targets").insert({year, user_id:uid, won_value:v}))) && ok;
        }
        await loadTable("targets"); e.currentTarget.disabled = false;
        if (ok) toast(year + " targets saved"); render();
      }}, "Save targets")));
  };
  draw(); return box;
}

// ---------------------------------------------------------------- settings, import, export
function viewSettings() {
  const wrap = h("div");
  wrap.append(h("div", {class:"toolbar"}, h("h2", null, "Go/no-go & import")));
  const g = JSON.parse(JSON.stringify(S.gng)); const admin = isAdmin();
  const critBox = h("div");
  const drawCrit = () => critBox.replaceChildren(
    h("div", {class:"crit-edit lab"}, h("span", null, "Criterion"), h("span", null, "Weight"), h("span")),
    ...g.criteria.map((c, i) => h("div", {class:"crit-edit"},
      h("input", {value:c.name, "aria-label":"Criterion " + (i + 1), readonly:!admin, oninput: e => { c.name = e.target.value; }}),
      h("input", {type:"number", min:"0", value:c.weight, "aria-label":"Weight", class:"mono", readonly:!admin, oninput: e => { c.weight = Number(e.target.value) || 0; }}),
      admin ? h("button", {class:"btn small", "aria-label":"Remove", onclick:() => { g.criteria.splice(i, 1); drawCrit(); }}, "×") : h("span"))));
  drawCrit();
  wrap.append(h("div", {class:"settings"},
    h("div", {class:"panel"}, h("h3", null, "Go/no-go criteria"),
      h("p", {class:"hint"}, admin ? "Edit the criteria and weights the team scores each pursuit on. Every deal's score updates when you save." : "Set by an admin. Score deals on the Go/no-go tab of each deal."),
      critBox,
      admin ? h("div", {class:"toolbar", style:"margin:10px 0 0"}, h("button", {class:"btn small", onclick:() => { g.criteria.push({id:"c" + Date.now().toString(36), name:"New criterion", weight:10}); drawCrit(); }}, "+ Criterion")) : null,
      h("div", {class:"form", style:"margin-top:10px"}, fld(g.threshold, "go", "Go at or above %", "number", {readonly:!admin}), fld(g.threshold, "review", "Review at or above %", "number", {readonly:!admin})),
      admin ? h("div", {style:"margin-top:12px;display:flex;justify-content:flex-end"}, h("button", {class:"btn primary", onclick: async () => {
        g.criteria = g.criteria.filter(c => c.name.trim());
        if (await run(sb.from("gng_config").update({config:g, updated_at:new Date().toISOString()}).eq("id", true), "Criteria saved")) { S.gng = g; render(); }
      }}, "Save criteria")) : null),
    importPanel(), exportPanel()));
  return wrap;
}
function parseCSV(text) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (q) { if (c === '"') { if (text[i+1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i+1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; }
    else f += c; }
  if (f !== "" || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ""));
}
const IMPORT_TARGETS = {
  deals:[["name","Deal name",["deal","opportunity","project","name","pursuit"]],["account","Account / company",["account","company","customer","client"]],["stage","Stage",["stage","status"]],["value","Value",["value","amount","price","contract","bid amount","total"]],["owner","Account manager (name or email)",["account manager","owner","rep","salesperson","assigned"]],["se","Sales engineer (name or email)",["sales engineer","engineer","se"]],["bid_due","Bid due",["bid due","due","proposal due","due date"]],["close_date","Close date",["close","award"]],["rfp_no","RFP #",["rfp","bid #","bid no","solicitation"]],["vertical","Vertical",["vertical","market","industry"]],["description","Scope / notes",["scope","description","notes"]],["outcome_reason","Win/loss reason",["reason","loss reason","lost reason"]]],
  accounts:[["name","Account name",["account","company","name","organization"]],["type","Type",["type","category"]],["vertical","Vertical",["vertical","industry","market"]],["city","City",["city"]],["state","State",["state"]],["website","Website",["website","url","web"]],["notes","Notes",["notes"]]],
  contacts:[["name","Full name",["full name","name","contact"]],["first","First name",["first"]],["last","Last name",["last"]],["title","Title",["title","position","role"]],["account","Account / company",["company","account","organization"]],["email","Email",["email","e-mail"]],["phone","Phone",["phone","mobile","cell","office"]],["notes","Notes",["notes"]]],
};
function guessMap(type, headers) {
  const used = new Set(), map = {}; const lh = headers.map(x => x.toLowerCase().trim());
  for (const [key, , keys] of IMPORT_TARGETS[type]) {
    let idx = -1;
    for (const k of keys) { idx = lh.findIndex((x, i) => !used.has(i) && x === k); if (idx >= 0) break; }
    if (idx < 0) for (const k of keys) { idx = lh.findIndex((x, i) => !used.has(i) && x.includes(k)); if (idx >= 0) break; }
    if (idx >= 0) { used.add(idx); map[key] = idx; }
  }
  return map;
}
function normStage(s) { s = (s || "").toLowerCase(); if (!s) return "lead";
  if (/won|award|booked/.test(s)) return "won"; if (/lost/.test(s)) return "lost"; if (/no.?bid|pass|declin/.test(s)) return "nobid";
  if (/nego|contract|verbal/.test(s)) return "negotiation"; if (/submit|sent|delivered/.test(s)) return "submitted";
  if (/propos|bid|quot|estimat|pricing/.test(s)) return "proposal"; if (/qualif|discover|go.?no/.test(s)) return "qualifying"; return "lead"; }
function normDate(s) { s = (s || "").trim(); if (!s) return null; if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/); if (m) { let y = Number(m[3]); if (y < 100) y += 2000; return y + "-" + String(m[1]).padStart(2, "0") + "-" + String(m[2]).padStart(2, "0"); }
  const n = Number(s); if (n > 20000 && n < 80000) return new Date(Date.UTC(1899, 11, 30) + n * 864e5).toISOString().slice(0, 10);
  return null; }
function importPanel() {
  const st = {type:"deals", rows:null, headers:null, map:{}, busy:false};
  const box = h("div");
  const draw = () => {
    const kids = [h("div", {class:"form"},
      h("div", {class:"field"}, h("label", {for:"imp-type"}, "Import"), h("select", {id:"imp-type", onchange: e => { st.type = e.target.value; if (st.headers) st.map = guessMap(st.type, st.headers); draw(); }},
        [["deals","Deals"],["accounts","Accounts"],["contacts","Contacts"]].map(([v, t]) => h("option", {value:v, selected:st.type === v}, t)))),
      h("div", {class:"field"}, h("label", {for:"imp-file"}, "CSV file"), h("input", {id:"imp-file", type:"file", accept:".csv,text/csv", onchange: e => {
        const f = e.target.files[0]; if (!f) return; const r = new FileReader();
        r.onload = () => { const rows = parseCSV(String(r.result)); if (rows.length < 2) { toast("That file has no data rows."); return; } st.headers = rows[0]; st.rows = rows.slice(1); st.map = guessMap(st.type, st.headers); draw(); };
        r.readAsText(f); }})))];
    if (st.rows) {
      kids.push(h("div", {class:"section-h", style:"margin-top:14px"}, "Match columns · " + st.rows.length + " rows"));
      kids.push(h("div", {class:"form"}, IMPORT_TARGETS[st.type].map(([key, label]) => h("div", {class:"field"}, h("label", {for:"map-" + key}, label),
        h("select", {id:"map-" + key, onchange: e => { if (e.target.value === "") delete st.map[key]; else st.map[key] = Number(e.target.value); }},
          h("option", {value:""}, "— skip —"), st.headers.map((hd, i) => h("option", {value:String(i), selected:st.map[key] === i}, hd || ("Column " + (i + 1)))))))));
      if (st.type === "deals") kids.push(h("p", {class:"muted", style:"font-size:12px"}, "Owners are matched by name or email to people who have signed in. Unmatched rows are assigned to you" + (isAdmin() ? "; reassign them later." : ".")));
      kids.push(h("div", {style:"margin-top:12px;display:flex;justify-content:flex-end;gap:8px;align-items:center"}, h("span", {class:"muted", id:"imp-prog", style:"font-size:13px"}),
        h("button", {class:"btn primary", disabled:st.busy, onclick:() => runImport(st, draw)}, "Import " + st.rows.length + " " + st.type)));
    }
    box.replaceChildren(...kids);
  };
  draw();
  return h("div", {class:"panel"}, h("h3", null, "Import from Excel or your old CRM"),
    h("p", {class:"hint"}, "Save the sheet or export as CSV, pick it here, and check the column matches. Accounts named in deal or contact rows are created if they don't exist."), box);
}
async function ensureAccounts(names) {
  const have = new Map(S.accounts.map(a => [a.name.trim().toLowerCase(), a.id]));
  const missing = [...new Set(names.map(n => (n || "").trim()).filter(n => n && !have.has(n.toLowerCase())))];
  const seen = new Set(); const toAdd = missing.filter(n => { const k = n.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  for (let i = 0; i < toAdd.length; i += 200) {
    const {data, error} = await sb.from("accounts").insert(toAdd.slice(i, i + 200).map(name => ({name}))).select("id,name");
    if (error) throw error;
    for (const a of data) have.set(a.name.trim().toLowerCase(), a.id);
  }
  await loadTable("accounts");
  return have;
}
async function runImport(st, draw) {
  st.busy = true; draw();
  const prog = msg => { const n = document.getElementById("imp-prog"); if (n) n.textContent = msg; };
  const get = (r, k) => st.map[k] != null ? (r[st.map[k]] || "").trim() : "";
  let n = 0, skipped = 0;
  try {
    let rows = []; const seFor = [];
    if (st.type === "accounts") {
      const have = new Set(S.accounts.map(a => a.name.trim().toLowerCase()));
      for (const r of st.rows) { const name = get(r, "name"); if (!name || have.has(name.toLowerCase())) { skipped++; continue; } have.add(name.toLowerCase());
        rows.push({name, type:get(r, "type") || null, vertical:get(r, "vertical") || null, city:get(r, "city") || null, state:get(r, "state") || null, website:get(r, "website") || null, notes:get(r, "notes") || null}); }
    } else {
      prog("Matching accounts…");
      const acc = await ensureAccounts(st.rows.map(r => get(r, "account")));
      const aid = r => acc.get(get(r, "account").toLowerCase()) || null;
      if (st.type === "contacts") {
        for (const r of st.rows) { const name = get(r, "name") || [get(r, "first"), get(r, "last")].filter(Boolean).join(" "); if (!name) { skipped++; continue; }
          rows.push({name, title:get(r, "title") || null, account_id:aid(r), email:get(r, "email") || null, phone:get(r, "phone") || null, notes:get(r, "notes") || null}); }
      } else {
        const findPerson = v => { v = (v || "").toLowerCase().trim(); if (!v) return null;
          const p = S.profiles.find(p => p.active && ((p.email || "").toLowerCase() === v || (p.full_name || "").toLowerCase() === v)); return p ? p.id : null; };
        const findOwner = v => { v = (v || "").toLowerCase().trim(); if (!v) return S.me.id;
          const p = S.profiles.find(p => p.active && ((p.email || "").toLowerCase() === v || (p.full_name || "").toLowerCase() === v));
          return p ? (isAdmin() || p.id === S.me.id ? p.id : S.me.id) : S.me.id; };
        for (const r of st.rows) { const name = get(r, "name"); if (!name) { skipped++; continue; }
          const v = Number(get(r, "value").replace(/[$,\s]/g, ""));
          const stg = normStage(get(r, "stage"));
          rows.push({name, account_id:aid(r), owner_id:findOwner(get(r, "owner")), stage:stg, outcome_reason: get(r, "outcome_reason") || (stg === "lost" ? "Unknown" : stg === "nobid" ? "Other" : null), value: isFinite(v) && v ? v : null,
            bid_due:normDate(get(r, "bid_due")), close_date:normDate(get(r, "close_date")), rfp_no:get(r, "rfp_no") || null,
            vertical: VERTICALS.find(x => x.toLowerCase() === get(r, "vertical").toLowerCase()) || null, description:get(r, "description") || null, services:[], gng:{scores:{}}});
          seFor.push(findPerson(get(r, "se"))); }
      }
    }
    for (let i = 0; i < rows.length; i += 200) {
      const {data:made, error} = await sb.from(st.type).insert(rows.slice(i, i + 200)).select("id,owner_id");
      if (error) throw error;
      if (st.type === "deals" && made) {
        const mem = made.map((d, j) => ({deal_id:d.id, user_id:seFor[i + j], role:"sales_engineer", added_by:S.me.id})).filter(m => m.user_id && m.user_id !== made.find(x => x.id === m.deal_id).owner_id);
        if (mem.length) { const r2 = await sb.from("deal_members").insert(mem); if (r2.error) toast("Sales engineers couldn't be added: " + friendly(r2.error)); }
      }
      n += Math.min(200, rows.length - i); prog(n + " imported…");
    }
    toast("Imported " + n + " " + st.type + (skipped ? " · skipped " + skipped + " (blank or already there)" : ""));
    st.rows = null; st.headers = null;
    await loadAll(); render();
  } catch (e) { toast("Import stopped after " + n + " rows: " + friendly(e)); }
  st.busy = false; draw();
}
function csvEsc(v) { v = v == null ? "" : String(v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
function exportPanel() {
  const dl = type => {
    let head, rows;
    if (type === "deals") { head = ["Deal","Account","Stage","Value","Probability","Bid due","Close date","Account manager","Sales engineer","Deal team","RFP #","Vertical","Services","Go/no-go score","Decision","Outcome reason","Won by","Their price","Outcome notes"];
      rows = S.deals.map(d => [d.name, acctName(d.account_id), STAGE[d.stage].name, d.value, prob(d), d.bid_due, d.close_date, personName(d.owner_id), seNames(d.id), S.members.filter(m => m.deal_id === d.id).map(m => personName(m.user_id) + " (" + dealRoleLabel(m.role) + ")").join("; "), d.rfp_no, d.vertical, (d.services || []).join("; "), gngScore(d).pct, (d.gng && d.gng.decision) || "", d.outcome_reason, d.winning_competitor, d.winning_price, d.outcome_notes]); }
    else if (type === "accounts") { head = ["Account","Type","Vertical","City","State","Website"]; rows = S.accounts.map(a => [a.name, a.type, a.vertical, a.city, a.state, a.website]); }
    else if (type === "contacts") { head = ["Name","Title","Account","Email","Phone"]; rows = S.contacts.map(c => [c.name, c.title, acctName(c.account_id), c.email, c.phone]); }
    else { head = ["Task","Due","Assigned to","Deal","Done"]; rows = S.tasks.map(t => [t.title, t.due, personName(t.assignee_id), dealName(t.deal_id), t.done ? "yes" : ""]); }
    const csv = "﻿" + [head, ...rows].map(r => r.map(csvEsc).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], {type:"text/csv"}));
    const a = h("a", {href:url, download:"rfip-" + type + "-" + todayStr() + ".csv"}); document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  return h("div", {class:"panel"}, h("h3", null, "Export"), h("p", {class:"hint"}, "CSV files that open in Excel. Exports include only what you can see" + (isAdmin() ? " (as an admin, that's everything)." : ".")),
    h("div", {style:"display:flex;gap:8px;flex-wrap:wrap"}, ["deals","accounts","contacts","tasks"].map(t => h("button", {class:"btn", onclick:() => dl(t)}, "Export " + t))));
}

boot();
})();
