// RFIP — creates a deal's SharePoint folder (Sales + Operations sub-folders) and
// saves its link on the deal and its project.
//
// Secrets (Supabase → Edge Functions → Secrets):
//   MS_TENANT_ID      Directory (tenant) ID of the RFIP Microsoft 365 tenant
//   MS_CLIENT_ID      Application (client) ID of the "RFIP" app registration
//   MS_CLIENT_SECRET  A client secret value for that app
//   SP_SITE_URL       e.g. https://rfip.sharepoint.com/sites/Sales
//   SP_LIBRARY        document library name (optional, default "Documents")
//   SP_ROOT_FOLDER    folder inside the library for deals (optional, default "Deals")
//
// Calls (POST, signed-in user's token):
//   {action:"create", deal_id}  create (or re-link) the folder for one deal the caller can see
//   {action:"backfill"}         admins only: create folders for every deal that has none
//   {action:"status"}           is SharePoint connected?
import { createClient } from "jsr:@supabase/supabase-js@2";

const SALES = ["01 RFP and Bid Docs", "02 Site Walk and Photos", "03 Drawings and Specs", "04 Estimate and Pricing", "05 Proposal",
  "06 Contract and PO", "07 Correspondence"];
const OPS = ["01 Handoff Packet", "02 Submittals", "03 Drawings and As-Builts", "04 Change Orders", "05 Field Photos and Daily Reports",
  "06 Test Results", "07 Pay Apps", "08 Closeout", "09 Safety"];

const env = (k: string) => (Deno.env.get(k) || "").trim();
const cors = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS"};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {...cors, "Content-Type": "application/json"}});
const configured = () => !!(env("MS_TENANT_ID") && env("MS_CLIENT_ID") && env("MS_CLIENT_SECRET") && env("SP_SITE_URL"));
// SharePoint won't take " * : < > ? / \ | or names ending in a dot or space
const safe = (s: string) => s.replace(/["*:<>?/\\|#%]+/g, "-").replace(/\s+/g, " ").replace(/[. ]+$/, "").trim().slice(0, 120) || "Untitled";

let token: {v: string, exp: number} | null = null;
async function graphToken() {
  if (token && token.exp > Date.now() + 60_000) return token.v;
  const r = await fetch(`https://login.microsoftonline.com/${env("MS_TENANT_ID")}/oauth2/v2.0/token`, {method: "POST",
    body: new URLSearchParams({client_id: env("MS_CLIENT_ID"), client_secret: env("MS_CLIENT_SECRET"), grant_type: "client_credentials",
      scope: "https://graph.microsoft.com/.default"})});
  const j = await r.json();
  if (!r.ok) throw new Error("Microsoft sign-in for the app failed: " + (j.error_description || j.error || r.status));
  token = {v: j.access_token, exp: Date.now() + (j.expires_in || 3000) * 1000};
  return token.v;
}
async function graph(path: string, init: RequestInit = {}) {
  const r = await fetch("https://graph.microsoft.com/v1.0" + path, {...init,
    headers: {Authorization: "Bearer " + await graphToken(), "Content-Type": "application/json", ...(init.headers || {})}});
  const text = await r.text(); const body = text ? JSON.parse(text) : {};
  return {ok: r.ok, status: r.status, body};
}
let driveCache: string | null = null;
async function driveId() {
  if (driveCache) return driveCache;
  const u = new URL(env("SP_SITE_URL"));
  const site = await graph(`/sites/${u.hostname}:${u.pathname.replace(/\/$/, "")}`);
  if (!site.ok) throw new Error("Couldn't find the SharePoint site " + env("SP_SITE_URL") + " (" + (site.body.error?.message || site.status) + ")");
  const drives = await graph(`/sites/${site.body.id}/drives`);
  if (!drives.ok) throw new Error("Couldn't read the site's document libraries (" + (drives.body.error?.message || drives.status) + ")");
  const want = (env("SP_LIBRARY") || "Documents").toLowerCase();
  const d = drives.body.value.find((x: any) => x.name.toLowerCase() === want) || drives.body.value.find((x: any) => /^(documents|shared documents)$/i.test(x.name));
  if (!d) throw new Error("No document library named " + (env("SP_LIBRARY") || "Documents") + " on that site");
  return (driveCache = d.id);
}
async function child(drive: string, parent: string, name: string) {
  const made = await graph(`/drives/${drive}/items/${parent}/children`, {method: "POST",
    body: JSON.stringify({name, folder: {}, "@microsoft.graph.conflictBehavior": "fail"})});
  if (made.ok) return made.body;
  if (made.status === 409) {
    const got = await graph(`/drives/${drive}/items/${parent}:/${encodeURIComponent(name)}`);
    if (got.ok) return got.body;
  }
  throw new Error(`Couldn't create folder "${name}" (${made.body.error?.message || made.status})`);
}

async function createFor(admin: any, dealId: string) {
  const {data: d, error} = await admin.from("deals").select("id, name, created_at, account_id, accounts(name)").eq("id", dealId).single();
  if (error || !d) throw new Error("Deal not found");
  if (!configured()) {
    await admin.from("deals").update({sharepoint_status: "waiting", sharepoint_error: null}).eq("id", dealId);
    return {status: "waiting"};
  }
  try {
    const drive = await driveId();
    const root = (await graph(`/drives/${drive}/root`)).body;
    const base = await child(drive, root.id, safe(env("SP_ROOT_FOLDER") || "Deals"));
    const year = await child(drive, base.id, String(new Date(d.created_at).getFullYear()));
    const name = safe((d.accounts?.name ? d.accounts.name + " – " : "") + d.name);
    const folder = await child(drive, year.id, name);
    const sales = await child(drive, folder.id, "Sales");
    for (const n of SALES) await child(drive, sales.id, n);
    const ops = await child(drive, folder.id, "Operations");
    for (const n of OPS) await child(drive, ops.id, n);
    await admin.from("deals").update({sharepoint_url: folder.webUrl, sharepoint_item_id: folder.id, sharepoint_status: "ready", sharepoint_error: null}).eq("id", dealId);
    await admin.from("projects").update({sharepoint_url: folder.webUrl}).eq("deal_id", dealId);
    return {status: "ready", url: folder.webUrl};
  } catch (e) {
    const msg = String((e as Error).message || e).slice(0, 500);
    await admin.from("deals").update({sharepoint_status: "error", sharepoint_error: msg}).eq("id", dealId);
    return {status: "error", error: msg};
  }
}

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", {headers: cors});
  if (req.method !== "POST") return json({error: "POST only"}, 405);
  const auth = req.headers.get("Authorization") || "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") || req.headers.get("apikey") || "";
  const asUser = createClient(env("SUPABASE_URL"), anon, {global: {headers: {Authorization: auth}}, auth: {persistSession: false}});
  const {data: u} = await asUser.auth.getUser(auth.replace(/^Bearer\s+/i, ""));
  if (!u?.user) return json({error: "Sign in first"}, 401);
  const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {auth: {persistSession: false}});
  let body: any = {}; try { body = await req.json(); } catch { /* empty */ }

  if (body.action === "status") return json({connected: configured(), site: configured() ? env("SP_SITE_URL") : null});

  if (body.action === "create") {
    if (!body.deal_id) return json({error: "deal_id is required"}, 400);
    const {data: ok} = await asUser.rpc("can_see_deal", {d: body.deal_id});
    if (!ok) return json({error: "That deal isn't available to you"}, 403);
    return json(await createFor(admin, body.deal_id));
  }

  if (body.action === "backfill") {
    const {data: isAdmin} = await asUser.rpc("is_admin");
    if (!isAdmin) return json({error: "Admins only"}, 403);
    if (!configured()) return json({error: "SharePoint isn't connected yet"}, 400);
    const {data: deals} = await admin.from("deals").select("id").or("sharepoint_status.is.null,sharepoint_status.neq.ready").limit(200);
    const out = {ready: 0, error: 0, errors: [] as string[]};
    for (const d of deals || []) { const r: any = await createFor(admin, d.id); if (r.status === "ready") out.ready++; else { out.error++; if (r.error) out.errors.push(r.error); } }
    return json(out);
  }
  return json({error: "Unknown action"}, 400);
});
