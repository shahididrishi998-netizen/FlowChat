// ================================================================
//  supabase/functions/send-push/index.ts
//
//  Triggered by a Postgres trigger (see push-schema.sql) whenever a
//  new message is inserted. Looks up who should be notified, fetches
//  their push subscriptions, and sends a Web Push notification to
//  each of their devices.
//
//  DEPLOY:
//    supabase functions deploy send-push --no-verify-jwt
//
//  SECRETS (set these once, see README section "Push notifications"):
//    supabase secrets set VAPID_PUBLIC_KEY=...
//    supabase secrets set VAPID_PRIVATE_KEY=...
//    supabase secrets set VAPID_SUBJECT=mailto:you@example.com
// ================================================================

import { createClient } from "npm:@supabase/supabase-js@2";
import * as webpush from "jsr:@negrel/webpush@0.5.0";

// ── Required secrets ─────────────────────────────────────────────
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically
// on every Edge Function — you never set these yourself. VAPID_* are
// the ones you set with `supabase secrets set ...` (see README).
//
// Using a named helper instead of TS's `!` assertion is the actual fix
// for the "ReferenceError ... is not defined" crash: `!` is erased at
// runtime and does nothing to stop a missing secret — if any of these
// come back empty, this throws a clear, named error at boot instead of
// failing later in a confusing way.
function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Missing required secret "${name}". Set it with: supabase secrets set ${name}=...`);
  }
  return value;
}

const SUPABASE_URL = requireEnv("SUPABASE_URL");
const SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const VAPID_PUBLIC_KEY = requireEnv("VAPID_PUBLIC_KEY");
const VAPID_PRIVATE_KEY = requireEnv("VAPID_PRIVATE_KEY");
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@example.com";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// Build the VAPID-authenticated application server once per cold start.
// Wrapped in try/catch so a bad key produces one clear log line instead
// of an uncaught top-level rejection that crashes the whole isolate.
let appServer: webpush.ApplicationServer | undefined;
let initError: string | null = null;
try {

  const vapidKeys = await webpush.importVapidKeys({
    publicKey: JSON.parse(VAPID_PUBLIC_KEY),
    privateKey: JSON.parse(VAPID_PRIVATE_KEY),
  });
  appServer = await webpush.ApplicationServer.new({
    contactInformation: VAPID_SUBJECT,
    vapidKeys,
  });
} catch (e) {
  initError = `Failed to initialize VAPID keys/ApplicationServer: ${e}`;
  console.error(initError);
}

Deno.serve(async req => {
  if (initError) {
    return new Response(JSON.stringify({ error: initError }), { status: 500 });
  }

  // ── Only the DB trigger (or you) should be able to call this ────
  // push-schema.sql sends the service_role key as a Bearer token.
  // Without this check, anyone who finds the URL could POST arbitrary
  // sender_id/conversation_id/group_id values and spam real users.
  const authHeader = req.headers.get("Authorization") || "";
  if (authHeader !== `Bearer ${SERVICE_ROLE_KEY}`) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  try {
    const body = await req.json();
    const { sender_id, conversation_id, group_id, type, text } = body;

    // ── Figure out who should be notified ──────────────────────────
    let recipientIds: string[] = [];

    if (conversation_id) {
      const { data: conv } = await supabase
        .from("conversations")
        .select("user_a, user_b")
        .eq("id", conversation_id)
        .single();
      if (conv) {
        recipientIds = [conv.user_a, conv.user_b].filter(id => id !== sender_id);
      }
    } else if (group_id) {
      const { data: members } = await supabase
        .from("group_members")
        .select("user_id")
        .eq("group_id", group_id);
      recipientIds = (members || []).map(m => m.user_id).filter(id => id !== sender_id);
    }

    if (!recipientIds.length) {
      return new Response(JSON.stringify({ skipped: "no recipients" }), { status: 200 });
    }

    // ── Sender's name, for the notification title ───────────────────
    const { data: sender, error: senderError } = await supabase
      .from("profiles").select("name").eq("id", sender_id).single();
    if (senderError) {
      console.error(senderError);
      return new Response(JSON.stringify({ error: "Failed to fetch sender information" }), { status: 500 });
    }
    const senderName = sender?.name || "Someone";

    const bodyText = type === "image" ? "📷 Sent an image"
      : type === "video" ? "🎬 Sent a video"
      : type === "audio" ? "🎵 Sent an audio message"
      : type === "file" ? "📄 Sent a file"
      : (text || "New message").slice(0, 120);

    // ── Fetch push subscriptions for all recipients ─────────────────
    const { data: subs, error: subsError } = await supabase
      .from("push_subscriptions")
      .select("*")
      .in("user_id", recipientIds);

    if (subsError) {

    console.error(subsError);

    return new Response(
        JSON.stringify(subsError),
        {status:500}
    );

}

    if (!subs || !subs.length) {
      return new Response(JSON.stringify({ skipped: "no subscriptions" }), { status: 200 });
    }

    const payload = JSON.stringify({
      title: senderName,
      body: bodyText,
      url: conversation_id ? "/chat.html" : "/chat.html",
    });

    // ── Send to every subscription, cleaning up dead ones ───────────
    const results = await Promise.allSettled(
      subs.map(async sub => {
        const subscriber = appServer!.subscribe({
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth_key },
        });
        try {
          await subscriber.pushTextMessage(payload, {});
        } catch (err: any) {
          // 404/410 means the browser unsubscribed or the subscription
          // expired — clean it up so we stop trying every time.
          if (err?.response?.status === 404 || err?.response?.status === 410) {
            await supabase.from("push_subscriptions").delete().eq("id", sub.id);
          }
          throw err;
        }
      })
    );

    return new Response(JSON.stringify({ sent: results.length }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("send-push error:", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
