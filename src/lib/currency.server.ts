// Free FX rates from open.er-api.com (no API key), cached in app_settings.
const CACHE_KEY = "fx_rates_usd_v1";
const TTL_MS = 6 * 60 * 60 * 1000; // 6h

type Cached = { ts: number; rates: Record<string, number> };

async function loadCache(): Promise<Cached | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("app_settings")
    .select("value")
    .eq("key", CACHE_KEY)
    .maybeSingle();
  if (!data?.value) return null;
  try {
    return JSON.parse(data.value) as Cached;
  } catch {
    return null;
  }
}

async function saveCache(c: Cached) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await supabaseAdmin
    .from("app_settings")
    .upsert({ key: CACHE_KEY, value: JSON.stringify(c) }, { onConflict: "key" });
}

async function fetchRates(): Promise<Record<string, number>> {
  const r = await fetch("https://open.er-api.com/v6/latest/USD");
  if (!r.ok) throw new Error(`FX api ${r.status}`);
  const j = (await r.json()) as { result?: string; rates?: Record<string, number> };
  if (j.result !== "success" || !j.rates) throw new Error("FX api bad payload");
  return j.rates;
}

async function getRates(): Promise<Record<string, number>> {
  const cached = await loadCache();
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.rates;
  try {
    const rates = await fetchRates();
    await saveCache({ ts: Date.now(), rates });
    return rates;
  } catch (e) {
    if (cached) return cached.rates; // fall back to stale
    throw e;
  }
}

// Convert `amount` from `from` currency to `to` currency. Rounds to whole units.
export async function convertAmount(amount: number, from: string, to: string): Promise<number> {
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  if (!amount || f === t) return Math.round(amount);
  const rates = await getRates();
  const rf = rates[f];
  const rt = rates[t];
  if (!rf || !rt) return Math.round(amount); // unknown currency — keep as-is
  const usd = amount / rf;
  const result = usd * rt;
  return Math.round(result);
}