import Stripe from "https://esm.sh/stripe@14.14.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("stripe_secret_key")!, { apiVersion: "2024-04-10" });
const webhookSecret = Deno.env.get("stripe_webhook_secret")!;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const body = await req.text();
  const sig = req.headers.get("stripe-signature");
  if (!sig) return new Response("No signature", { status: 400 });

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  // Idempotency: skip if already processed
  const { data: existing } = await supabase
    .from("webhook_event")
    .select("webhook_event_id")
    .eq("provider_event_id", event.id)
    .limit(1);
  if (existing?.length) {
    return new Response(JSON.stringify({ received: true, duplicate: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Log the event
  await supabase.from("webhook_event").insert({
    provider: "stripe",
    provider_event_id: event.id,
    event_type: event.type,
    payload: event.data.object,
    processed: false,
  });

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.metadata?.user_id;
        if (!userId) break;

        const subscription = await stripe.subscriptions.retrieve(session.subscription as string);

        // Get Pro plan ID
        const { data: plans } = await supabase
          .from("subscription_plan")
          .select("plan_id")
          .eq("plan_name", "Pro")
          .limit(1);
        const proPlanId = plans?.[0]?.plan_id;
        if (!proPlanId) break;

        await supabase
          .from("user_subscription")
          .update({
            plan_id: proPlanId,
            stripe_customer_id: session.customer as string,
            stripe_subscription_id: subscription.id,
            stripe_price_id: subscription.items.data[0]?.price.id,
            billing_period: "monthly",
            payment_status: subscription.status,
            current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
            current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
            trial_ends_at: subscription.trial_end
              ? new Date(subscription.trial_end * 1000).toISOString()
              : null,
            modified_time: new Date().toISOString(),
          })
          .eq("user_id", userId);
        break;
      }

      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription;
        await supabase
          .from("user_subscription")
          .update({
            payment_status: subscription.status,
            cancel_at_period_end: subscription.cancel_at_period_end,
            current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
            current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
            modified_time: new Date().toISOString(),
          })
          .eq("stripe_subscription_id", subscription.id);
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        // Get Free plan ID to downgrade
        const { data: freePlans } = await supabase
          .from("subscription_plan")
          .select("plan_id")
          .eq("plan_name", "Free")
          .limit(1);
        const freePlanId = freePlans?.[0]?.plan_id;

        await supabase
          .from("user_subscription")
          .update({
            plan_id: freePlanId || undefined,
            payment_status: "canceled",
            modified_time: new Date().toISOString(),
          })
          .eq("stripe_subscription_id", subscription.id);
        break;
      }

      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        const userId = invoice.subscription_details?.metadata?.user_id
          || invoice.metadata?.user_id;
        if (userId) {
          await supabase.from("payment_transaction").insert({
            user_id: userId,
            stripe_payment_id: invoice.payment_intent as string,
            amount: (invoice.amount_paid || 0) / 100,
            currency: invoice.currency,
            status: "succeeded",
            description: `Pro subscription — ${invoice.lines?.data?.[0]?.description || "monthly"}`,
          });
        }
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        // Update subscription status
        if (invoice.subscription) {
          await supabase
            .from("user_subscription")
            .update({ payment_status: "past_due", modified_time: new Date().toISOString() })
            .eq("stripe_subscription_id", invoice.subscription as string);
        }
        break;
      }
    }

    // Mark event as processed
    await supabase
      .from("webhook_event")
      .update({ processed: true })
      .eq("provider_event_id", event.id);
  } catch (err) {
    console.error("Webhook processing error:", err);
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
