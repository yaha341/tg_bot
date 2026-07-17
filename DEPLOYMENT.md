# Деплой Telegram бота с админ-панелью на Vercel

## Текущая архитектура
- **База данных**: Supabase
- **Фронтенд**: React + TanStack Router
- **Бэкенд**: Nitro SSR (TanStack Start)
- **Telegram бот**: Webhook на `/api/public/telegram/webhook`

## Инструкция по деплою на Vercel

### 1. Установите Vercel CLI
```bash
npm install -g vercel
```

### 2. Авторизуйтесь в Vercel
```bash
vercel login
```

### 3. Разверните проект
```bash
vercel
```

При первом деплое:
- Выберите существующий проект или создайте новый
- Подтвердите настройки

### 4. Настройте переменные окружения в Vercel Dashboard

После деплоя перейдите в Vercel Dashboard → Settings → Environment Variables и добавьте:

```
TELEGRAM_BOT_TOKEN=<ваш_токен_от_BotFather>
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_PUBLISHABLE_KEY=<publishable_key>
SUPABASE_SERVICE_ROLE_KEY=<service_role_key>
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<publishable_key>
PUBLIC_APP_URL=https://<your-project>.vercel.app
```

> **Важно:** никогда не коммитьте реальные ключи в репозиторий. Храните их только в Vercel / `.env.local`.

### 5. Настройте Telegram Webhook

После деплоя вы получите URL вида `https://your-project.vercel.app`

Настройте вебхук для Telegram бота:

```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://your-project.vercel.app/api/public/telegram/webhook"}'
```

### 6. Проверьте вебхук
```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"
```

## Важные замечания

### Telegram Webhook на Vercel
- Vercel поддерживает webhook API endpoints из коробки
- Telegram будет отправлять обновления на ваш URL `/api/public/telegram/webhook`
- Убедитесь, что ваш проект публично доступен

### Supabase
- База данных работает независимо от деплоя фронтенда
- Миграции лежат в `supabase/migrations/`

### Обновления
- Для обновления проекта делайте `git push` в репозиторий
- Vercel автоматически задеploит новую версию

## Альтернативный вариант: Railway

Если у вас возникнут проблемы с webhook на Vercel, Railway — хороший аналог:

1. Создайте аккаунт на [railway.app](https://railway.app)
2. Подключите GitHub репозиторий
3. Railway автоматически определит Nitro проект
4. Добавьте те же переменные окружения
5. Railway предоставит публичный URL для webhook
