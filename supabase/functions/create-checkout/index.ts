import Stripe from "https://esm.sh/stripe@14.14.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripeKey = Deno.env.get("stripe_secret_key") || Deno.env.get("STRIPE_SECRET_KEY") || "";
const stripe = new Stripe(stripeKey, { apiVersion: "2024-04-10" });
const STRIPE_PRICE_ID = Deno.env.get("stripe_price_id") || Deno.env.get("STRIPE_PRICE_ID") || "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return jsonResponse({ error: "Not authenticated" }, 401);
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return jsonResponse({ error: "Invalid token" }, 401);
    }

    const serviceSupabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: subs } = await serviceSupabase
      .from("user_subscription")
      .select("stripe_customer_id")
      .eq("user_id", user.id)
      .limit(1);

    let customerId = subs?.[0]?.stripe_customer_id;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { user_id: user.id },
      });
      customerId = customer.id;

      await serviceSupabase
        .from("user_subscription")
        .update({ stripe_customer_id: customerId, modified_time: new Date().toISOString() })
        .eq("user_id", user.id);
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      metadata: { user_id: user.id },
      success_url: "https://audi-m.github.io/Aburrido/payment-success.html",
      cancel_url: "https://audi-m.github.io/Aburrido/pricing.html",
    });

    return jsonResponse({ url: session.url });
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
});
