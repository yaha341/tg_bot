#!/usr/bin/env node
/**
 * One-shot: set shop bot webhook to PUBLIC_APP_URL.
 * Usage: node scripts/set-webhook.mjs
 * Needs .env.local with TELEGRAM_BOT_TOKEN (and optional PUBLIC_APP_URL, TELEGRAM_WEBHOOK_SECRET)
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvLocal() {
  const p = resolve(process.cwd(), ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

loadEnvLocal();

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN missing");
  process.exit(1);
}

const base = (
  process.env.PUBLIC_APP_URL || "https://tg-bot-ashen-one.vercel.app"
).replace(/\/$/, "");
const url = `${base}/api/public/telegram/webhook`;
const body: Record<string, string | boolean> = { url, drop_pending_updates: false };
if (process.env.TELEGRAM_WEBHOOK_SECRET) {
  body.secret_token = process.env.TELEGRAM_WEBHOOK_SECRET;
}

const set = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
}).then((r) => r.json());

console.log("setWebhook:", set);

const info = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`).then((r) =>
  r.json(),
);
console.log("getWebhookInfo:", {
  url: info.result?.url,
  pending_update_count: info.result?.pending_update_count,
  last_error_message: info.result?.last_error_message || null,
});
