// RFIP — Outlook email and calendar, sent as the person doing the work.
//
// Each person's Microsoft sign-in grants Mail.Send, Calendars.ReadWrite and offline_access (delegated).
// Right after sign-in the app hands this function the Microsoft refresh token; it's kept in
// public.ms_tokens, which only this function (service role) can read. Invites and alert emails then
// go out from that person's own mailbox and calendar, so replies come back to them.
//
// Secrets (shared with the sharepoint function): MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET.
// Optional: APP_URL, the CRM address used in links (default: the address the request came from).
//
// Calls (POST, signed-in user's token):
//   {action:"save_token", refresh_token}     right after Microsoft sign-in
//   {action:"status"}                        is Outlook connected for me?
//   {action:"meeting_save", id?, deal_id | project_id, kind, subject, start, end, all_day, time_zone,
//          location, notes, online, attendees:[{email, name}]}   create or update an Outlook event + invite
//   {action:"meeting_cancel", id, comment?}  cancel the event and tell attendees (organizer or admin)
//   {action:"notify", to:[profile ids], subject, text, link?}    alert email to RFIP people
//   {action:"new_project", project_id}       new-project setup email to NEW_PROJECTS_EMAIL (default newprojects@rfip.com)
import { createClient } from "jsr:@supabase/supabase-js@2";

const env = (k: string) => (Deno.env.get(k) || "").trim();
const cors = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS"};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {...cors, "Content-Type": "application/json"}});
const configured = () => !!(env("MS_TENANT_ID") && env("MS_CLIENT_ID") && env("MS_CLIENT_SECRET"));
const SCOPES = "offline_access User.Read Mail.Send Calendars.ReadWrite";
const KINDS = ["site_walk", "pre_bid", "bid_due", "kickoff", "handoff", "field", "meeting"];
const esc = (s: string) => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]!));
const emailOk = (e: string) => /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[a-z]{2,}$/i.test(e || "");
class Refused extends Error { constructor(msg: string, public status = 403) { super(msg); } }

// trade a refresh token for an access token; Microsoft hands back a new refresh token each time
async function exchange(refresh: string) {
  const r = await fetch(`https://login.microsoftonline.com/${env("MS_TENANT_ID")}/oauth2/v2.0/token`, {method: "POST",
    body: new URLSearchParams({client_id: env("MS_CLIENT_ID"), client_secret: env("MS_CLIENT_SECRET"), grant_type: "refresh_token",
      refresh_token: refresh, scope: SCOPES})});
  const j = await r.json();
  if (!r.ok) throw new Refused("Outlook needs you to sign in again with Microsoft (" + (j.error_description || j.error || r.status).toString().split("\r")[0] + ")", 401);
  return j as {access_token: string, refresh_token?: string, scope?: string};
}
async function graphAs(access: string, path: string, init: RequestInit = {}) {
  const r = await fetch("https://graph.microsoft.com/v1.0" + path, {...init,
    headers: {Authorization: "Bearer " + access, "Content-Type": "application/json", ...(init.headers || {})}});
  const text = await r.text(); let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = {raw: text}; }
  return {ok: r.ok, status: r.status, body};
}
// an access token for this person, refreshing (and re-saving) their stored token
async function tokenFor(admin: any, profileId: string) {
  const {data} = await admin.from("ms_tokens").select("refresh_token").eq("profile_id", profileId).maybeSingle();
  if (!data) throw new Refused("Outlook isn't connected for you yet. Sign out and sign back in with Microsoft.", 409);
  const t = await exchange(data.refresh_token);
  if (t.refresh_token && t.refresh_token !== data.refresh_token)
    await admin.from("ms_tokens").update({refresh_token: t.refresh_token, scopes: t.scope || null, updated_at: new Date().toISOString()}).eq("profile_id", profileId);
  return t.access_token;
}
const appLink = (req: Request, hash: string) => {
  const base = env("APP_URL") || req.headers.get("origin") || "";
  return base ? base.replace(/\/$/, "") + "/" + hash : "";
};

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", {headers: cors});
  if (req.method !== "POST") return json({error: "POST only"}, 405);
  const auth = req.headers.get("Authorization") || "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") || req.headers.get("apikey") || "";
  const asUser = createClient(env("SUPABASE_URL"), anon, {global: {headers: {Authorization: auth}}, auth: {persistSession: false}});
  const {data: u} = await asUser.auth.getUser(auth.replace(/^Bearer\s+/i, ""));
  if (!u?.user) return json({error: "Sign in first"}, 401);
  const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {auth: {persistSession: false}});
  const {data: me} = await admin.from("profiles").select("id, email, full_name, role, active").eq("id", u.user.id).maybeSingle();
  if (!me || !me.active) return json({error: "Your RFIP access isn't active"}, 403);
  let body: any = {}; try { body = await req.json(); } catch { /* empty */ }
  if (!configured()) return json({connected: false, error: "Microsoft isn't set up for this app yet"});

  try {
    if (body.action === "save_token") {
      if (!body.refresh_token) throw new Refused("refresh_token is required", 400);
      const t = await exchange(body.refresh_token);
      const who = await graphAs(t.access_token, "/me?$select=mail,userPrincipalName");
      const addr = String(who.body.mail || who.body.userPrincipalName || "").toLowerCase();
      if (!who.ok || addr !== String(me.email).toLowerCase()) throw new Refused("That Microsoft account doesn't match your RFIP login", 403);
      await admin.from("ms_tokens").upsert({profile_id: me.id, refresh_token: t.refresh_token || body.refresh_token, scopes: t.scope || null,
        updated_at: new Date().toISOString()}, {onConflict: "profile_id"});
      return json({connected: true});
    }

    if (body.action === "status") {
      const {data} = await admin.from("ms_tokens").select("updated_at").eq("profile_id", me.id).maybeSingle();
      return json({connected: !!data});
    }

    if (body.action === "meeting_save") {
      let dealId = body.deal_id || null, projectId = body.project_id || null;
      if (body.id) {   // an existing meeting stays on its own deal or project
        const {data: cur} = await admin.from("meetings").select("deal_id, project_id").eq("id", body.id).maybeSingle();
        if (cur) { dealId = cur.deal_id; projectId = cur.project_id; }
      }
      if (!dealId && !projectId) throw new Refused("deal_id or project_id is required", 400);
      if (dealId) { const {data: ok} = await asUser.rpc("can_see_deal", {d: dealId}); if (!ok) throw new Refused("That deal isn't available to you"); }
      if (projectId) { const {data: ok} = await asUser.rpc("ops_can_see", {p: projectId}); if (!ok) throw new Refused("That project isn't available to you"); }
      const kind = KINDS.includes(body.kind) ? body.kind : "meeting";
      const subject = String(body.subject || "").trim().slice(0, 250);
      if (!subject) throw new Refused("Add a subject", 400);
      const start = new Date(body.start), end = new Date(body.end);
      if (isNaN(+start) || isNaN(+end) || end < start) throw new Refused("Check the start and end time", 400);
      const allDay = !!body.all_day, tz = String(body.time_zone || "UTC");
      const attendees = (Array.isArray(body.attendees) ? body.attendees : []).filter((a: any) => emailOk(a?.email))
        .map((a: any) => ({email: String(a.email).trim().toLowerCase(), name: String(a.name || "").slice(0, 120)}))
        .filter((a: any, i: number, all: any[]) => all.findIndex(b => b.email === a.email) === i && a.email !== String(me.email).toLowerCase()).slice(0, 50);

      let row: any = null;
      if (body.id) {
        const {data} = await admin.from("meetings").select("*").eq("id", body.id).maybeSingle();
        if (!data) throw new Refused("That meeting is gone", 404);
        if (data.organizer_id !== me.id) throw new Refused("Only " + (data.organizer_id ? "the organizer" : "an organizer") + " can change this meeting");
        row = data;
      }
      // what the meeting is about, for the invite body
      let about = "", link = "";
      if (dealId) {
        const {data: d} = await admin.from("deals").select("name, accounts(name)").eq("id", dealId).maybeSingle();
        about = [d?.accounts?.name, d?.name].filter(Boolean).join(" – "); link = appLink(req, "#deal=" + dealId);
      } else {
        const {data: p} = await admin.from("projects").select("number, name, accounts(name)").eq("id", projectId).maybeSingle();
        about = [p?.number, p?.accounts?.name, p?.name].filter(Boolean).join(" – "); link = appLink(req, "#project=" + projectId);
      }
      const day = (d: Date) => d.toISOString().slice(0, 10) + "T00:00:00";
      const event: any = {
        subject,
        body: {contentType: "HTML", content: (body.notes ? `<p>${esc(body.notes).replace(/\n/g, "<br>")}</p>` : "") +
          `<p style="color:#5b6876">${esc(about)}${link ? ` · <a href="${esc(link)}">Open in RFIP</a>` : ""}</p>`},
        start: allDay ? {dateTime: String(body.start).slice(0, 10) + "T00:00:00", timeZone: tz} : {dateTime: start.toISOString().replace("Z", ""), timeZone: "UTC"},
        end: allDay ? {dateTime: day(new Date(Date.parse(String(body.end).slice(0, 10) + "T00:00:00Z") + 864e5)), timeZone: tz} : {dateTime: end.toISOString().replace("Z", ""), timeZone: "UTC"},
        isAllDay: allDay,
        location: body.location ? {displayName: String(body.location).slice(0, 250)} : undefined,
        attendees: attendees.map((a: any) => ({emailAddress: {address: a.email, name: a.name || a.email}, type: "required"})),
        showAs: kind === "bid_due" ? "free" : "busy",
        categories: ["RFIP"],
      };
      if (body.online && !row?.online) { event.isOnlineMeeting = true; event.onlineMeetingProvider = "teamsForBusiness"; }
      const access = await tokenFor(admin, me.id);
      const r = row?.ms_event_id
        ? await graphAs(access, `/me/events/${encodeURIComponent(row.ms_event_id)}`, {method: "PATCH", body: JSON.stringify(event)})
        : await graphAs(access, "/me/events", {method: "POST", body: JSON.stringify(event)});
      if (!r.ok) throw new Error("Outlook didn't take the meeting (" + (r.body.error?.message || r.status) + ")");
      // an update doesn't always echo the Teams link back, so look it up when it's missing
      if ((r.body.isOnlineMeeting || row?.online) && !r.body.onlineMeeting?.joinUrl && r.body.id) {
        const g = await graphAs(access, `/me/events/${encodeURIComponent(r.body.id)}?$select=onlineMeeting`);
        if (g.ok && g.body.onlineMeeting) r.body.onlineMeeting = g.body.onlineMeeting;
      }
      const rec = {deal_id: dealId, project_id: projectId, kind, subject, starts_at: allDay ? String(body.start).slice(0, 10) + "T12:00:00Z" : start.toISOString(),
        ends_at: allDay ? String(body.end).slice(0, 10) + "T12:00:00Z" : end.toISOString(), all_day: allDay, location: body.location || null,
        notes: body.notes || null, online: !!(r.body.isOnlineMeeting || row?.online), attendees, organizer_id: me.id,
        ms_event_id: r.body.id, web_link: r.body.webLink || null, status: "scheduled", updated_at: new Date().toISOString(),
        join_url: r.body.onlineMeeting?.joinUrl || row?.join_url || null};
      const put = (x: any) => row ? admin.from("meetings").update(x).eq("id", row.id).select().single() : admin.from("meetings").insert(x).select().single();
      let saved = await put(rec);
      // the join_url column comes from outlook_teams.sql; until that runs, save without it
      if (saved.error && /join_url/.test(saved.error.message || "")) { const {join_url: _, ...rest} = rec; saved = await put(rest); }
      if (saved.error) throw new Error("The invite went out but the app couldn't record it (" + saved.error.message + ")");
      return json({meeting: saved.data, join_url: r.body.onlineMeeting?.joinUrl || null});
    }

    if (body.action === "meeting_cancel") {
      const {data: m} = await admin.from("meetings").select("*").eq("id", body.id).maybeSingle();
      if (!m) throw new Refused("That meeting is gone", 404);
      if (m.organizer_id !== me.id && me.role !== "admin") throw new Refused("Only the organizer can cancel this meeting");
      if (m.ms_event_id) {
        const access = await tokenFor(admin, m.organizer_id);
        const r = await graphAs(access, `/me/events/${encodeURIComponent(m.ms_event_id)}/cancel`, {method: "POST",
          body: JSON.stringify({comment: String(body.comment || "This meeting has been cancelled.").slice(0, 500)})});
        if (!r.ok && r.status !== 404) throw new Error("Outlook didn't cancel it (" + (r.body.error?.message || r.status) + ")");
      }
      await admin.from("meetings").update({status: "cancelled", updated_at: new Date().toISOString()}).eq("id", m.id);
      return json({cancelled: true});
    }

    if (body.action === "notify") {
      const ids = (Array.isArray(body.to) ? body.to : []).filter((x: any) => typeof x === "string" && x !== me.id).slice(0, 25);
      if (!ids.length) return json({sent: 0});
      const {data: people} = await admin.from("profiles").select("email, full_name").in("id", ids).eq("active", true);
      const to = (people || []).filter((p: any) => emailOk(p.email));
      if (!to.length) return json({sent: 0});
      const {data: hasToken} = await admin.from("ms_tokens").select("profile_id").eq("profile_id", me.id).maybeSingle();
      if (!hasToken) return json({sent: 0, connected: false});
      const link = body.link ? appLink(req, String(body.link)) : "";
      const html = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#16202b">
        <p>${esc(String(body.text || "")).replace(/\n/g, "<br>")}</p>
        ${link ? `<p><a href="${esc(link)}" style="background:#c8102e;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none;display:inline-block">Open in RFIP</a></p>` : ""}
        <p style="color:#5b6876;font-size:12px">Sent from RFIP by ${esc(me.full_name || me.email)}.</p></div>`;
      const access = await tokenFor(admin, me.id);
      const r = await graphAs(access, "/me/sendMail", {method: "POST", body: JSON.stringify({saveToSentItems: true, message: {
        subject: String(body.subject || "RFIP").slice(0, 250), body: {contentType: "HTML", content: html},
        toRecipients: to.map((p: any) => ({emailAddress: {address: p.email, name: p.full_name || p.email}}))}})});
      if (!r.ok) throw new Error("Outlook didn't send it (" + (r.body.error?.message || r.status) + ")");
      return json({sent: to.length});
    }

    if (body.action === "new_project") {
      // a won deal just became a project: tell the office mailbox so it can be set up internally
      const pid = String(body.project_id || "");
      const {data: ok} = await asUser.rpc("ops_can_see", {p: pid});
      if (!ok) throw new Refused("That project isn't available to you");
      const {data: p} = await admin.from("projects").select("*, accounts(name)").eq("id", pid).maybeSingle();
      if (!p) throw new Refused("That project is gone", 404);
      const {data: ho} = await admin.from("handoffs").select("packet, submitted_by").eq("project_id", pid).maybeSingle();
      const {data: deal} = p.deal_id ? await admin.from("deals").select("name, owner_id").eq("id", p.deal_id).maybeSingle() : {data: null};
      const ids = [p.pm_id, deal?.owner_id, p.sold_by, ho?.submitted_by].filter(Boolean);
      const {data: ppl} = ids.length ? await admin.from("profiles").select("id, full_name, email").in("id", ids) : {data: []};
      const nm = (id: string) => { const x = (ppl || []).find((q: any) => q.id === id); return x ? (x.full_name || x.email) : ""; };
      const pk: any = ho?.packet || {};
      const usd = (v: any) => v == null || v === "" ? "" : Number(v).toLocaleString("en-US", {style: "currency", currency: "USD", maximumFractionDigits: 0});
      const yes = (v: any) => v ? "Yes" : "No";
      const rows: [string, string][] = [
        ["Project", [p.number, p.name].filter(Boolean).join(" ")], ["Customer", p.accounts?.name || ""], ["Department", p.department || ""],
        ["Project manager", nm(p.pm_id)], ["Sold by", nm(deal?.owner_id || p.sold_by)], ["Contract value", usd(p.contract_value ?? pk.contract_value)],
        ["Signed contract / PO", yes(pk.contract_signed)], ["Schedule of values", yes(pk.sov_attached)],
        ["Retainage", p.retainage_pct != null ? p.retainage_pct + "%" : (pk.retainage_pct != null && pk.retainage_pct !== "" ? pk.retainage_pct + "%" : "")],
        ["Pay app due", (p.pay_app_day || pk.pay_app_day) ? "Day " + (p.pay_app_day || pk.pay_app_day) + " of the month" : ""],
        ["Billing terms", pk.billing_terms || ""], ["Bonds and insurance", pk.bonds_insurance || ""],
        ["Planned start", p.start_date || pk.start_date || ""], ["Substantial completion", p.end_date || pk.end_date || ""],
        ["Customer PM", pk.customer_pm || ""], ["Site contact", pk.site_contact || ""], ["Billing contact", pk.billing_contact || ""], ["GC or prime", pk.gc_name || ""],
        ["Labor hours", pk.labor_hours != null ? String(pk.labor_hours) : ""], ["Material", usd(pk.material)], ["Subcontract", usd(pk.subcontract)], ["Equipment", usd(pk.equipment)],
        ["Scope", pk.scope || ""], ["Exclusions", pk.exclusions || ""],
      ];
      const link = appLink(req, "#project=" + pid);
      const td = "padding:5px 12px 5px 0;vertical-align:top;border-bottom:1px solid #e6e9ee";
      const html = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#16202b">
        <p>${esc(me.full_name || me.email)} accepted the handoff, so this won deal is now a project and needs internal setup.</p>
        <table style="border-collapse:collapse;font-size:14px">${rows.filter(r => r[1]).map(([k, v]) =>
          `<tr><td style="${td};color:#5b6876;white-space:nowrap">${esc(k)}</td><td style="${td}">${esc(v).replace(/\n/g, "<br>")}</td></tr>`).join("")}</table>
        <p>${link ? `<a href="${esc(link)}" style="background:#c8102e;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none;display:inline-block">Open in RFIP</a>` : ""}
        ${p.sharepoint_url ? ` &nbsp;<a href="${esc(p.sharepoint_url)}">Project files</a>` : ""}</p>
        <p style="color:#5b6876;font-size:12px">Sent from RFIP by ${esc(me.full_name || me.email)}.</p></div>`;
      const to = env("NEW_PROJECTS_EMAIL") || "newprojects@rfip.com";
      const {data: hasToken} = await admin.from("ms_tokens").select("profile_id").eq("profile_id", me.id).maybeSingle();
      if (!hasToken) return json({sent: 0, connected: false, to});
      const access = await tokenFor(admin, me.id);
      const r = await graphAs(access, "/me/sendMail", {method: "POST", body: JSON.stringify({saveToSentItems: true, message: {
        subject: "New project: " + [p.number, p.name].filter(Boolean).join(" ") + (p.accounts?.name ? " – " + p.accounts.name : ""),
        body: {contentType: "HTML", content: html}, toRecipients: [{emailAddress: {address: to}}]}})});
      if (!r.ok) throw new Error("Outlook didn't send it (" + (r.body.error?.message || r.status) + ")");
      return json({sent: 1, to});
    }

    return json({error: "Unknown action"}, 400);
  } catch (e) {
    if (e instanceof Refused) return json({error: e.message, connected: e.status === 409 || e.status === 401 ? false : undefined}, e.status);
    return json({error: String((e as Error).message || e).slice(0, 500)}, 500);
  }
});
