# Webhook самовосстановление (tg_bot)

Telegram **не** возвращает webhook сам. Если `getWebhookInfo` показывает `"url":""`, бот молчит, даже когда сайт и БД живы.

## Сейчас (разово)

```
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://tg-bot-ashen-one.vercel.app/api/public/telegram/webhook
```

Или локально: `node scripts/set-webhook.mjs` (нужен `.env.local`).

## Чтобы не слетал снова

1. В Vercel env:
   - `TELEGRAM_BOT_TOKEN`
   - `PUBLIC_APP_URL=https://tg-bot-ashen-one.vercel.app`
   - `CRON_SECRET=<тот же длинный секрет>`

2. На [cron-job.org](https://cron-job.org) **каждый час** GET:
   ```
   https://tg-bot-ashen-one.vercel.app/api/cron/ensure-webhook?secret=ВАШ_CRON_SECRET
   ```
   Если URL пустой или другой — endpoint сам вызовет `setWebhook` снова.

3. Не запускай бота через `getUpdates` / long polling на том же токене — многие скрипты делают `deleteWebhook`.

Ответ ensure-webhook:
- `action: "unchanged"` — всё ок
- `action: "set"` — хук был сбит и восстановлен
