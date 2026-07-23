#!/usr/bin/env node
/**
 * Set Telegram bot profile texts (Robokassa: terms + privacy in «Что умеет этот бот?»).
 * Usage: node scripts/set-bot-description.mjs
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

const description = (
  `📚 Каталог цифровых учебных материалов.\n` +
  `→ Выбор материалов и мгновенная выдача файлов после оплаты\n` +
  `→ Оплата картой / по реквизитам\n` +
  `→ Поддержка автора\n\n` +
  `Нажимая /start, вы соглашаетесь с:\n` +
  `• Условиями использования\n` +
  `${base}/legal/offer\n` +
  `• Политикой конфиденциальности\n` +
  `${base}/legal/privacy`
).slice(0, 512);

const short_description =
  "Каталог материалов. Нажимая /start, вы принимаете оферту и политику конфиденциальности.".slice(0, 120);

async function call(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());
  console.log(method, res);
}

await call("setMyDescription", { description });
await call("setMyShortDescription", { short_description });
console.log("\nPreview description:\n" + description);
