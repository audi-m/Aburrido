import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STRIPE_SECRET = Deno.env.get("stripe_secret_key")!;
const WEBHOOK_SECRET = Deno.env.get("stripe_webhook_secret")!;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// --- Stripe signature verification (no SDK needed) ---
async function verifySignature(payload: string, header: string, secret: string) {
  const parts = Object.fromEntries(
    header.split(",").map((p) => {
      const [k, v] = p.split("=");
      return [k, v];
    })
  );
  const timestamp = parts["t"];
  const sig = parts["v1"];
  if (!timestamp || !sig) throw new Error("Invalid signature header");

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestamp}.${payload}`)
  );
  const expected = Array.from(new Uint8Array(signed))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (expected !== sig) throw new Error("Signature mismatch");

  // Check timestamp (5 min tolerance)
  const age = Math.abs(Date.now() / 1000 - parseInt(timestamp));
  if (age > 300) throw new Error("Timestamp too old");

  return JSON.parse(payload);
}

// --- Stripe REST API helper ---
async function stripeGet(path: string) {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    headers: { Authorization: `Bearer ${STRIPE_SECRET}` },
  });
  return res.json();
}

// Safe timestamp to ISO string
function safeDate(ts: any): string | null {
  if (!ts) return null;
  try {
    const d = new Date(typeof ts === "number" ? ts * 1000 : ts);
    return isNaN(d.getTime()) ? null : d.toISOString();
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  console.log("[WEBHOOK] Received request");
  const body = await req.text();
  const sig = req.headers.get("stripe-signature");
  if (!sig) return new Response("No signature", { status: 400 });

  let event: any;
  try {
    event = await verifySignature(body, sig, WEBHOOK_SECRET);
    console.log("[WEBHOOK] Event verified:", event.type, event.id);
  } catch (err) {
    console.error("[WEBHOOK] Verification FAILED:", err.message);
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  // Idempotency
  const { data: existing } = await supabase
    .from("webhook_event")
    .select("webhook_event_id")
    .eq("provider_event_id", event.id)
    .limit(1);
  if (existing?.length) {
    console.log("[WEBHOOK] Duplicate — skipping");
    return new Response(JSON.stringify({ received: true, duplicate: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Log event
  const { error: insertErr } = await supabase.from("webhook_event").insert({
    provider: "stripe",
    provider_event_id: event.id,
    event_type: event.type,
    payload: event.data?.object || {},
    processed: false,
  });
  console.log("[WEBHOOK] Event insert:", insertErr ? insertErr.message : "OK");

  try {
    const obj = event.data?.object || {};

    switch (event.type) {
      case "checkout.session.completed": {
        const userId = obj.metadata?.user_id;
        console.log("[WEBHOOK] checkout — userId:", userId, "sub:", obj.subscription, "customer:", obj.customer);
        if (!userId) { console.log("[WEBHOOK] No userId — skip"); break; }

        // Fetch subscription from Stripe REST API
        const sub = await stripeGet(`/subscriptions/${obj.subscription}`);
        console.log("[WEBHOOK] Stripe sub:", sub.id, "status:", sub.status);

        // Get Pro plan ID
        const { data: plans, error: planErr } = await supabase
          .from("subscription_plan")
          .select("plan_id")
          .eq("plan_name", "Pro")
          .limit(1);
        const proPlanId = plans?.[0]?.plan_id;
        console.log("[WEBHOOK] Pro planId:", proPlanId, "planErr:", planErr);
        if (!proPlanId) { console.log("[WEBHOOK] No Pro plan — skip"); break; }

        const { error: updateErr } = await supabase
          .from("user_subscription")
          .update({
            plan_id: proPlanId,
            stripe_customer_id: obj.customer,
            stripe_subscription_id: sub.id,
            stripe_price_id: sub.items?.data?.[0]?.price?.id || null,
            billing_period: "monthly",
            payment_status: sub.status,
            current_period_start: safeDate(sub.current_period_start) || new Date().toISOString(),
            current_period_end: safeDate(sub.current_period_end) || new Date(Date.now() + 30 * 86400000).toISOString(),
            trial_ends_at: safeDate(sub.trial_end),
            modified_time: new Date().toISOString(),
          })
          .eq("user_id", userId);
        console.log("[WEBHOOK] Update result:", updateErr ? updateErr.message : "OK");
        break;
      }

      case "customer.subscription.updated": {
        const { error } = await supabase
          .from("user_subscription")
          .update({
            payment_status: obj.status,
            cancel_at_period_end: obj.cancel_at_period_end,
            current_period_start: safeDate(obj.current_period_start),
            current_period_end: safeDate(obj.current_period_end),
            modified_time: new Date().toISOString(),
          })
          .eq("stripe_subscription_id", obj.id);
        console.log("[WEBHOOK] sub.updated:", error ? error.message : "OK");
        break;
      }

      case "customer.subscription.deleted": {
        const { data: freePlans } = await supabase
          .from("subscription_plan")
          .select("plan_id")
          .eq("plan_name", "Free")
          .limit(1);
        const freePlanId = freePlans?.[0]?.plan_id;

        const { error } = await supabase
          .from("user_subscription")
          .update({
            plan_id: freePlanId || undefined,
            payment_status: "canceled",
            modified_time: new Date().toISOString(),
          })
          .eq("stripe_subscription_id", obj.id);
        console.log("[WEBHOOK] sub.deleted:", error ? error.message : "OK");
        break;
      }

      case "invoice.paid": {
        const userId = obj.subscription_details?.metadata?.user_id || obj.metadata?.user_id;
        if (userId) {
          const { error } = await supabase.from("payment_transaction").insert({
            user_id: userId,
            stripe_payment_id: obj.payment_intent,
            amount: (obj.amount_paid || 0) / 100,
            currency: obj.currency,
            status: "succeeded",
            description: `Pro subscription — ${obj.lines?.data?.[0]?.description || "monthly"}`,
          });
          console.log("[WEBHOOK] invoice.paid:", error ? error.message : "OK");
        }
        break;
      }

      case "invoice.payment_failed": {
        if (obj.subscription) {
          const { error } = await supabase
            .from("user_subscription")
            .update({ payment_status: "past_due", modified_time: new Date().toISOString() })
            .eq("stripe_subscription_id", obj.subscription);
          console.log("[WEBHOOK] invoice.failed:", error ? error.message : "OK");
        }
        break;
      }
    }

    // Mark processed
    await supabase
      .from("webhook_event")
      .update({ processed: true })
      .eq("provider_event_id", event.id);
  } catch (err) {
    console.error("[WEBHOOK] Processing error:", err);
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
