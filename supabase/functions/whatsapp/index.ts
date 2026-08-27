// Quadem WhatsApp intake — Supabase Edge Function (Deno)
//
// Deploy:  supabase functions deploy whatsapp --no-verify-jwt
//          (--no-verify-jwt is required: Meta cannot send a Supabase JWT)
//
// Webhook URL to give Meta:
//          https://<project-ref>.supabase.co/functions/v1/whatsapp
//
// Secrets needed (supabase secrets set KEY=value):
//   WA_VERIFY_TOKEN    any random string you also paste into Meta's webhook setup
//   WA_APP_SECRET      Meta app secret, used to verify request signatures
//   WA_TOKEN           permanent access token from a Meta system user
//   WA_PHONE_ID        the phone number ID from the WhatsApp > API Setup page
//   SUPABASE_URL       provided automatically by the platform
//   SUPABASE_SERVICE_ROLE_KEY  provided automatically by the platform

import { createClient } from "jsr:@supabase/supabase-js@2";

const VERIFY_TOKEN = Deno.env.get("WA_VERIFY_TOKEN")!;
const APP_SECRET   = Deno.env.get("WA_APP_SECRET")!;
const WA_TOKEN     = Deno.env.get("WA_TOKEN")!;
const WA_PHONE_ID  = Deno.env.get("WA_PHONE_ID")!;
const GRAPH        = "https://graph.facebook.com/v21.0";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

// ---------------------------------------------------------------------------
// Signature check. Meta signs the RAW body with your app secret. You must hash
// the exact bytes received, not a re-serialised copy of the parsed JSON, or the
// digest will not match.
// ---------------------------------------------------------------------------
async function signatureValid(rawBody: string, header: string | null): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(APP_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const given = header.slice(7);
  // constant-time compare
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------
async function send(waId: string, body: string, inReplyTo?: string) {
  let messageId: string | null = null;
  let error: string | null = null;
  try {
    const res = await fetch(`${GRAPH}/${WA_PHONE_ID}/messages`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${WA_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: waId,
        type: "text",
        text: { preview_url: false, body },
      }),
    });
    const json = await res.json();
    if (!res.ok) error = JSON.stringify(json);
    else messageId = json?.messages?.[0]?.id ?? null;
  } catch (e) {
    error = String(e);
  }
  await db.from("wa_outbound").insert({
    wa_id: waId, body, in_reply_to: inReplyTo ?? null,
    wa_message_id: messageId, error,
  });
  return { messageId, error };
}

// ---------------------------------------------------------------------------
// The flow. Three questions, then stop. Anything it cannot classify goes to a
// human rather than guessing — a wrong auto-reply to a real customer costs more
// than a slow one.
// ---------------------------------------------------------------------------
const GREETING =
  "Hi, thanks for reaching out to Quadem Digital. I build websites and online systems for businesses across Ghana.\n\n" +
  "So I can point you to the right thing: what are you looking for? A website, help getting found on Google, branding, or something else?";

const ASK_CITY   = "Got it. Which city are you based in?";
const ASK_SITE   = "Thanks. Last one: do you already have a website? If yes, send me the address and I will take a look before we speak.";
const HANDOFF    = "Thanks. Ernest will read this himself and come back to you shortly.";

const YES = /\b(yes|yeah|yep|yh|we do|i do|sure)\b/i;
const NO  = /\b(no|nope|not yet|none|we don'?t|i don'?t)\b/i;
// NOTE: do not name this URL. A module-level `const URL` shadows the global
// URL class, and `new URL(req.url)` in the handler then throws
// "TypeError: URL is not a constructor" on every single request.
const URL_RE = /((https?:\/\/)?[a-z0-9][a-z0-9-]*\.[a-z]{2,}(\.[a-z]{2,})?(\/\S*)?)/i;
const GHANA_CITIES = [
  "accra","kumasi","takoradi","tema","cape coast","tamale","techiman","sunyani",
  "ho","koforidua","hohoe","kpando","obuasi","wa","bolgatanga","aflao","keta",
];

function findCity(text: string): string | null {
  const t = text.toLowerCase();
  const hit = GHANA_CITIES.find((c) => t.includes(c));
  return hit ? hit.replace(/\b\w/g, (m) => m.toUpperCase()) : null;
}

async function handle(msg: {
  wa_message_id: string; from: string; name?: string; body: string;
}) {
  const text = (msg.body ?? "").trim();

  const { data: existing } = await db
    .from("wa_leads").select("*").eq("wa_id", msg.from).maybeSingle();

  // First contact
  if (!existing) {
    await db.from("wa_leads").insert({
      wa_id: msg.from,
      profile_name: msg.name ?? null,
      stage: "asked_need",
      last_message_at: new Date().toISOString(),
    });
    await send(msg.from, GREETING, msg.wa_message_id);
    return;
  }

  const patch: Record<string, unknown> = { last_message_at: new Date().toISOString() };
  if (msg.name && !existing.profile_name) patch.profile_name = msg.name;

  switch (existing.stage) {
    case "asked_need": {
      if (text.length < 2) break;                     // ignore stickers, reactions
      patch.need = text.slice(0, 500);
      patch.stage = "asked_city";
      await db.from("wa_leads").update(patch).eq("wa_id", msg.from);
      await send(msg.from, ASK_CITY, msg.wa_message_id);
      return;
    }

    case "asked_city": {
      const city = findCity(text);
      if (!city) {
        // Do not guess a city. Take what they typed, flag it, move on.
        patch.city = text.slice(0, 80);
        patch.notes = "City not recognised from the known list, verify before calling.";
      } else {
        patch.city = city;
      }
      patch.stage = "asked_website";
      await db.from("wa_leads").update(patch).eq("wa_id", msg.from);
      await send(msg.from, ASK_SITE, msg.wa_message_id);
      return;
    }

    case "asked_website": {
      const url = text.match(URL_RE)?.[0];
      if (url) {
        patch.has_website = true;
        patch.website_url = url.startsWith("http") ? url : `https://${url}`;
      } else if (NO.test(text)) {
        patch.has_website = false;
        patch.headline_fault = "No website";
        patch.fault_severity = "critical";
      } else if (YES.test(text)) {
        // Says yes but gave no address. Not enough to act on.
        patch.has_website = true;
        patch.notes = "Says they have a website but did not give the address.";
      } else {
        patch.stage = "needs_human";
        await db.from("wa_leads").update(patch).eq("wa_id", msg.from);
        await send(msg.from, HANDOFF, msg.wa_message_id);
        return;
      }
      patch.stage = "qualified";
      patch.qualified_at = new Date().toISOString();
      await db.from("wa_leads").update(patch).eq("wa_id", msg.from);
      await send(
        msg.from,
        "Thank you. That is everything I need. Ernest will look at this and come back to you shortly with something specific rather than a generic quote.",
        msg.wa_message_id,
      );
      return;
    }

    // Already qualified, or already handed to a human. Do not auto-reply again.
    // Silence here is deliberate: once a real conversation is running, a bot
    // interrupting it is worse than nothing.
    default: {
      await db.from("wa_leads").update(patch).eq("wa_id", msg.from);
      return;
    }
  }

  await db.from("wa_leads").update(patch).eq("wa_id", msg.from);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
Deno.serve(async (req) => {
  const url = new URL(req.url);

  // --- Verification handshake. Meta expects the raw challenge back as plain
  // --- text. Returning JSON here is the single most common setup failure.
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge") ?? "";
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
    }
    return new Response("forbidden", { status: 403 });
  }

  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const rawBody = await req.text();

  if (!(await signatureValid(rawBody, req.headers.get("x-hub-signature-256")))) {
    return new Response("bad signature", { status: 401 });
  }

  let payload: any;
  try { payload = JSON.parse(rawBody); } catch { return new Response("ok", { status: 200 }); }

  // Collect inbound text messages. Status callbacks (delivered/read) arrive on
  // the same webhook and are ignored here.
  const jobs: Array<{ wa_message_id: string; from: string; name?: string; body: string; raw: any }> = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const v = change?.value;
      const nameOf = (waId: string) =>
        v?.contacts?.find((c: any) => c?.wa_id === waId)?.profile?.name;
      for (const m of v?.messages ?? []) {
        if (m?.type !== "text") continue;
        jobs.push({
          wa_message_id: m.id,
          from: m.from,
          name: nameOf(m.from),
          body: m?.text?.body ?? "",
          raw: m,
        });
      }
    }
  }

  // Persist first. If everything after this fails, the message is still on disk
  // and can be replayed. onConflict does nothing on a Meta retry.
  const work: typeof jobs = [];
  for (const j of jobs) {
    const { data, error } = await db.from("wa_messages")
      .upsert({
        wa_message_id: j.wa_message_id,
        from_wa_id: j.from,
        profile_name: j.name ?? null,
        body: j.body,
        msg_type: "text",
        raw: j.raw,
      }, { onConflict: "wa_message_id", ignoreDuplicates: true })
      .select("id");
    // data is empty when the row already existed, which means this is a retry
    // of something already handled. Skip it.
    if (!error && data && data.length > 0) work.push(j);
  }

  // Meta disables a webhook after 5 consecutive failures to answer within
  // 5 seconds, so acknowledge now and do the slow part after the response.
  const process = (async () => {
    for (const j of work) {
      try {
        await handle(j);
        await db.from("wa_messages")
          .update({ processed_at: new Date().toISOString() })
          .eq("wa_message_id", j.wa_message_id);
      } catch (e) {
        await db.from("wa_messages")
          .update({ processed_at: new Date().toISOString(), process_error: String(e) })
          .eq("wa_message_id", j.wa_message_id);
      }
    }
  })();

  // @ts-ignore EdgeRuntime is provided by the Supabase runtime
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
    // @ts-ignore
    EdgeRuntime.waitUntil(process);
  } else {
    await process; // local dev fallback
  }

  return new Response("ok", { status: 200 });
});
