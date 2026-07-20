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
