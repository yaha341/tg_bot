import { createFileRoute } from "@tanstack/react-router";
import { deliverOrder } from "@/lib/orders.server";
import { verifyRobokassaResultSignature } from "@/lib/robokassa.server";

export const Route = createFileRoute("/api/public/robokassa/result")({
  server: {
    handlers: {
      POST: async ({ request }) => handleRobokassaResult(request),
      GET: async ({ request }) => handleRobokassaResult(request),
    },
  },
});

async function db() {
  const { supabaseAdmin } = await import("@/integrations-supabase/client.server");
  return supabaseAdmin;
}

async function handleRobokassaResult(request: Request) {
  let body: URLSearchParams;
  if (request.method === "POST") {
    const text = await request.text();
    body = new URLSearchParams(text);
  } else {
    body = new URL(request.url).searchParams;
  }

  const outSum = body.get("OutSum");
  const invId = body.get("InvId");
  const signature = body.get("SignatureValue");
  const isTest = body.get("IsTest");

  if (!outSum || !invId || !signature) {
    return new Response("bad request", { status: 400 });
  }

  const s = await db();
  const { data: settings } = await s.from("app_settings").select("*");
  const getSetting = (key: string) => settings?.find((row) => row.key === key)?.value;

  if (getSetting("robokassa_enabled") !== "true") {
    return new Response("robokassa disabled", { status: 403 });
  }

  const testMode = getSetting("robokassa_test_mode") === "true";
  const pass2 = (
    isTest === "1" || testMode ? getSetting("robokassa_pass2_test") : getSetting("robokassa_pass2")
  )?.trim();

  if (!pass2) {
    return new Response("robokassa not configured", { status: 500 });
  }

  const shpEntries: Array<{ key: string; value: string }> = [];
  for (const [key, value] of body.entries()) {
    if (key.toLowerCase().startsWith("shp_")) shpEntries.push({ key, value });
  }

  const ok = verifyRobokassaResultSignature({
    outSum,
    invId,
    signature,
    pass2,
    shpEntries,
  });

  if (!ok) {
    console.error("[robokassa] signature mismatch", { outSum, invId });
    return new Response("bad sign", { status: 400 });
  }

  const orderId = Number(invId);
  const { data: order } = await s.from("orders").select("status").eq("id", orderId).maybeSingle();

  if (order && order.status !== "delivered") {
    try {
      await deliverOrder(orderId);
      await s
        .from("orders")
        .update({
          payment_proof_path: "robokassa",
          admin_note: `Paid via Robokassa. Amount: ${outSum}`,
        })
        .eq("id", orderId);
    } catch (e) {
      console.error("[robokassa] deliver error:", e);
    }
  }

  return new Response(`OK${invId}`);
}
