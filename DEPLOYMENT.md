# Деплой tg_bot

## Environment Variables (Vercel)

| Переменная | Описание |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Токен основного бота (@BotFather) |
| `VITE_SUPABASE_URL` / `SUPABASE_URL` | URL Supabase проекта |
| `VITE_SUPABASE_PUBLISHABLE_KEY` / `SUPABASE_PUBLISHABLE_KEY` | Anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (серверные операции) |
| `SUPABASE_PROJECT_ID` / `VITE_SUPABASE_PROJECT_ID` | ID проекта |
| `CRON_SECRET` | Секрет для авторизации cron-запросов |
| `PUBLIC_APP_URL` | Публичный URL приложения (напр. `https://my-app.vercel.app`) |

## Cron Jobs

### Рассылка — `/api/cron/broadcast`

Обрабатывает очередь рассылки порциями по 25 сообщений за вызов. Перед обработкой автоматически проверяет и восстанавливает webhook бота.

> ⚠️ На тарифе **Hobby** Vercel cron чаще раза в день **нельзя** (ошибка про `* * * * *`). В `vercel.json` встроенный cron отключён — используйте **внешний** cron.

**Внешний cron (cron-job.org и т.п.) — рекомендуется:**
```
GET https://your-app.vercel.app/api/cron/broadcast?secret=YOUR_CRON_SECRET
```
Интервал: каждую 1–2 минуты, пока идёт рассылка (или постоянно).

**Vercel Pro:** можно вернуть в `vercel.json`:
```json
{ "crons": [{ "path": "/api/cron/broadcast", "schedule": "* * * * *" }] }
```

### Webhook — `/api/cron/ensure-webhook`

Проверяет и восстанавливает webhook Telegram бота. Вызывается автоматически из `/api/cron/broadcast`, но можно настроить отдельно.

## База данных

При первой настройке выполните `COMPLETE-SETUP.sql` в SQL Editor Supabase.

Если БД уже существует и нужно добавить только модуль рассылки — выполните `PATCH-BROADCASTS.sql`.

## Модуль рассылки — Smoke-проверка

1. Убедитесь, что в настройках бота (`app_settings`) задан `admin_chat_id` (ваш Telegram ID).
2. Откройте админку → «Рассылка».
3. Введите текст, выберите аудиторию «Тест (admin Telegram ID)».
4. Нажмите «Отправить себе (тест)» → сообщение должно прийти в Telegram.
5. Выберите аудиторию «Все пользователи», нажмите «Запустить рассылку».
6. Убедитесь, что статус меняется: `В очереди` → `Отправляется` → `Завершена`.
7. Проверьте историю: счётчики sent/failed/blocked корректны.
8. Для проверки отмены: запустите рассылку и нажмите «Отменить» до завершения.
