/** Ensure Telegram webhook URL matches this deployment (self-heal if cleared). */

import { tg } from "./telegram.server";

function publicAppOrigin(): string {
  return (
    process.env.PUBLIC_APP_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : "") ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "") ||
    "https://tg-bot-ashen-one.vercel.app"
  ).replace(/\/$/, "");
}

export function expectedWebhookUrl(): string {
  return `${publicAppOrigin()}/api/public/telegram/webhook`;
}

export type EnsureWebhookResult = {
  ok: boolean;
  action: "unchanged" | "set" | "error";
  expected: string;
  previousUrl: string;
  currentUrl?: string;
  pending_update_count?: number;
  error?: string;
};

export async function ensureTelegramWebhook(): Promise<EnsureWebhookResult> {
  const expected = expectedWebhookUrl();

  try {
    const info = await tg("getWebhookInfo", {});
    if (!info.ok) {
      return {
        ok: false,
        action: "error",
        expected,
        previousUrl: "",
        error: info.description || "getWebhookInfo failed",
      };
    }

    const result = (info.result || {}) as {
      url?: string;
      pending_update_count?: number;
    };
    const previousUrl = (result.url || "").trim();
    const pending = result.pending_update_count ?? 0;

    if (previousUrl === expected) {
      return {
        ok: true,
        action: "unchanged",
        expected,
        previousUrl,
        currentUrl: previousUrl,
        pending_update_count: pending,
      };
    }

    const payload: Record<string, string | boolean> = {
      url: expected,
      drop_pending_updates: false,
    };
    const secret = (process.env.TELEGRAM_WEBHOOK_SECRET || "").trim();
    if (secret) payload.secret_token = secret;

    const set = await tg("setWebhook", payload);
    if (!set.ok) {
      return {
        ok: false,
        action: "error",
        expected,
        previousUrl,
        error: set.description || "setWebhook failed",
      };
    }

    const after = await tg("getWebhookInfo", {});
    const afterUrl =
      ((after.result as { url?: string } | undefined)?.url || "").trim() || expected;

    console.log("[webhook] restored", { previousUrl, afterUrl });
    try {
      const { syncBotPublicDescription } = await import("./bot.server");
      await syncBotPublicDescription();
    } catch (e) {
      console.error("[webhook] syncBotPublicDescription", e);
    }
    return {
      ok: true,
      action: "set",
      expected,
      previousUrl,
      currentUrl: afterUrl,
      pending_update_count: pending,
    };
  } catch (e) {
    return {
      ok: false,
      action: "error",
      expected,
      previousUrl: "",
      error: (e as Error).message,
    };
  }
}


type VipEnsureResult = {
  name: "VIP";
  ok: boolean;
  action: "unchanged" | "set" | "skipped" | "error";
  expected: string;
  previousUrl: string;
  currentUrl?: string;
  error?: string;
};

async function vipApi(
  token: string,
  method: string,
  payload: Record<string, unknown> = {},
): Promise<{ ok: boolean; result?: unknown; description?: string }> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return (await res.json().catch(() => ({ ok: false }))) as {
    ok: boolean;
    result?: unknown;
    description?: string;
  };
}

async function ensureVipWebhook(): Promise<VipEnsureResult> {
  const expected = `${publicAppOrigin()}/api/public/telegram/webhook-vip`;
  const token = process.env.VIP_BOT_TOKEN?.trim();
  if (!token) {
    return { name: "VIP", ok: true, action: "skipped", expected, previousUrl: "", error: "VIP_BOT_TOKEN not set" };
  }

  try {
    const info = await vipApi(token, "getWebhookInfo");
    if (!info.ok) {
      return { name: "VIP", ok: false, action: "error", expected, previousUrl: "", error: info.description || "getWebhookInfo failed" };
    }

    const previousUrl = String((info.result as { url?: string } | undefined)?.url || "").trim();
    if (previousUrl === expected) {
      return { name: "VIP", ok: true, action: "unchanged", expected, previousUrl, currentUrl: previousUrl };
    }

    const secret = (process.env.VIP_TELEGRAM_WEBHOOK_SECRET || process.env.TELEGRAM_WEBHOOK_SECRET || "").trim();
    const payload: Record<string, unknown> = { url: expected, drop_pending_updates: false };
    if (secret) payload.secret_token = secret;
    const set = await vipApi(token, "setWebhook", payload);
    if (!set.ok) {
      return { name: "VIP", ok: false, action: "error", expected, previousUrl, error: set.description || "setWebhook failed" };
    }

    return { name: "VIP", ok: true, action: "set", expected, previousUrl, currentUrl: expected };
  } catch (error) {
    return { name: "VIP", ok: false, action: "error", expected, previousUrl: "", error: (error as Error).message };
  }
}

/** Ensure the shop webhook and, when enabled, the separate VIP webhook. */
export async function ensureDidWebhooks(): Promise<{ ok: boolean; bots: Array<EnsureWebhookResult | VipEnsureResult> }> {
  const shop = await ensureTelegramWebhook();
  const { moduleEnabled } = await import("./tenant-config.server");
  const vipEnabled = await moduleEnabled("vip");
  const vip = vipEnabled
    ? await ensureVipWebhook()
    : {
        name: "VIP" as const,
        ok: true,
        action: "skipped" as const,
        expected: `${publicAppOrigin()}/api/public/telegram/webhook-vip`,
        previousUrl: "",
        error: "VIP module disabled",
      };
  return { ok: shop.ok && vip.ok, bots: [shop, vip] };
}
