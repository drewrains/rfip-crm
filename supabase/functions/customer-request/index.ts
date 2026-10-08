// RFIP — tells RFIP when a customer submits a request from their dashboard (customer.html?a=…).
//
// Called by the public customer page with no RFIP sign-in, so the gateway JWT check is off for this
// function and the link token is the check: {k, id} only works with that customer's active dashboard
// link, once per request, within 30 minutes of it being submitted. Who gets the email is decided here
// (the department lead(s), the related project's PM, whoever shared the link; admins if none), never by
// the caller. The email goes out from the mailbox of whoever shared the link (Outlook tokens saved by the
// outlook function), with Reply-To set to the customer so answering it reaches them directly.
//
// Secrets (shared with the outlook function): MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET. Optional: APP_URL.
import { createClient } from "jsr:@supabase/supabase-js@2";

const env = (k: string) => (Deno.env.get(k) || "").trim();
const cors = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS"};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {...cors, "Content-Type": "application/json"}});
const configured = () => !!(env("MS_TENANT_ID") && env("MS_CLIENT_ID") && env("MS_CLIENT_SECRET"));
const SCOPES = "offline_access User.Read Mail.Send Calendars.ReadWrite";
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
// the caller can't be trusted to name the app's address, so only RFIP's own sites are used for the link
const appLink = (req: Request, hash: string) => {
  const o = req.headers.get("origin") || "";
  const base = env("APP_URL") || (/^https:\/\/(rfip-crm[a-z0-9-]*\.vercel\.app|crm\.rfip\.com)$/.test(o) ? o : "");
  return base ? base.replace(/\/$/, "") + "/" + hash : "";
};

const KIND_NAME: Record<string, string> = {issue: "Issue on a current project", change: "Change to a current project", new_work: "New project / install",
  service: "Service call / repair", survey: "Site survey / quote", other: "Question / other"};
async function customerRequest(req: Request, body: any) {
  const k = String(body.k || ""), id = String(body.id || "");
  if (!/^[0-9a-f]{48}$/.test(k) || !/^[0-9a-f-]{36}$/.test(id)) return json({sent: 0}, 400);
  if (!configured()) return json({sent: 0});
  const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {auth: {persistSession: false}});
  const {data: link} = await admin.from("account_links").select("account_id, created_by").eq("token", k).eq("active", true).maybeSingle();
  if (!link) return json({sent: 0}, 404);
  const since = new Date(Date.now() - 30 * 60e3).toISOString();
  // claim it first so a request is only ever announced once
  const {data: r} = await admin.from("customer_requests").update({notified_at: new Date().toISOString()})
    .eq("id", id).eq("account_id", link.account_id).eq("source", "portal").is("notified_at", null).gte("created_at", since)
    .select("*").maybeSingle();
  if (!r) return json({sent: 0});
  const [{data: acct}, {data: proj}] = await Promise.all([
    admin.from("accounts").select("name").eq("id", r.account_id).maybeSingle(),
    r.project_id ? admin.from("projects").select("number, name, pm_id").eq("id", r.project_id).maybeSingle() : Promise.resolve({data: null})]);
  let q = admin.from("profiles").select("id, email, full_name").eq("active", true).eq("ops_role", "lead");
  if (r.department) q = q.eq("department", r.department);
  const {data: leads} = await q;
  const extra = [link.created_by, (proj as any)?.pm_id].filter(Boolean) as string[];
  const {data: others} = extra.length ? await admin.from("profiles").select("id, email, full_name").in("id", extra).eq("active", true) : {data: []};
  let people = [...(leads || []), ...(others || [])];
  if (!people.length) people = (await admin.from("profiles").select("id, email, full_name").eq("active", true).eq("role", "admin")).data || [];
  const seen = new Set<string>(); const to = people.filter((p: any) => emailOk(p.email) && !seen.has(p.id) && seen.add(p.id));
  if (!to.length) return json({sent: 0});
  // send from the mailbox of whoever shared the link, else a recipient, else an admin
  const {data: toks} = await admin.from("ms_tokens").select("profile_id");
  const has = new Set((toks || []).map((t: any) => t.profile_id));
  let from = [link.created_by, ...to.map((p: any) => p.id)].find(x => x && has.has(x));
  if (!from) { const {data: ad} = await admin.from("profiles").select("id").eq("active", true).eq("role", "admin"); from = (ad || []).map((x: any) => x.id).find((x: string) => has.has(x)); }
  if (!from) return json({sent: 0, connected: false});
  const cust = acct?.name || "A customer";
  const ref = "R-" + r.ref;
  const line = (k2: string, v: string) => v ? `<tr><td style="padding:3px 12px 3px 0;color:#5b6876;vertical-align:top;white-space:nowrap">${esc(k2)}</td><td style="padding:3px 0">${v}</td></tr>` : "";
  const link2 = appLink(req, "#request=" + r.id);
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#16202b">
    <p><b>${esc(cust)}</b> sent a request from their RFIP customer dashboard${r.urgent ? ` and marked it <b style="color:#b4282e">URGENT</b>` : ""}.</p>
    <p style="font-size:16px;margin:12px 0"><b>${esc(ref)} · ${esc(r.title)}</b></p>
    <table style="border-collapse:collapse;font-size:14px">
      ${line("Type", esc(KIND_NAME[r.kind] || r.kind))}${line("Work", esc(r.department || "Not sure"))}
      ${line("Site", esc([r.site, r.address].filter(Boolean).join(" · ")))}${line("Needed by", esc(r.needed_by || ""))}
      ${line("Related job", proj ? esc((proj as any).number + " · " + (proj as any).name) : "")}
      ${line("From", esc(r.requester_name) + ` · <a href="mailto:${esc(r.requester_email)}">${esc(r.requester_email)}</a>` + (r.requester_phone ? " · " + esc(r.requester_phone) : ""))}
    </table>
    ${r.details ? `<p style="white-space:pre-wrap;background:#f3f5f7;border-radius:6px;padding:10px 12px">${esc(r.details)}</p>` : ""}
    ${link2 ? `<p><a href="${esc(link2)}" style="background:#c8102e;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none;display:inline-block">Open in RFIP</a></p>` : ""}
    <p style="color:#5b6876;font-size:12px">Reply to this email to answer ${esc(r.requester_name)} directly. Update the status in RFIP → Operations → Requests so ${esc(cust)} sees it on their dashboard.</p></div>`;
  const access = await tokenFor(admin, from);
  const res = await graphAs(access, "/me/sendMail", {method: "POST", body: JSON.stringify({saveToSentItems: false, message: {
    subject: (r.urgent ? "URGENT · " : "") + (r.kind === "issue" && proj ? "Issue on " + (proj as any).number : r.kind === "change" && proj ? "Change request on " + (proj as any).number : "New request")
      + " (" + ref + ") from " + cust + ": " + String(r.title).slice(0, 150),
    body: {contentType: "HTML", content: html}, importance: r.urgent ? "high" : "normal",
    replyTo: emailOk(r.requester_email) ? [{emailAddress: {address: r.requester_email, name: r.requester_name}}] : [],
    toRecipients: to.map((p: any) => ({emailAddress: {address: p.email, name: p.full_name || p.email}}))}})});
  if (!res.ok) {
    await admin.from("customer_requests").update({notified_at: null}).eq("id", r.id);
    return json({sent: 0, error: "Outlook didn't send it"}, 502);
  }
  return json({sent: to.length});
}

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", {headers: cors});
  if (req.method !== "POST") return json({error: "POST only"}, 405);
  let body: any = {}; try { body = await req.json(); } catch { /* empty */ }
  try { return await customerRequest(req, body); } catch (e) { return json({sent: 0, error: String((e as Error).message || e).slice(0, 300)}, 500); }
});
