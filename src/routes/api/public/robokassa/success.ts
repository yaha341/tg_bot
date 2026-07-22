import { createFileRoute } from "@tanstack/react-router";

function htmlPage(title: string, body: string) {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5; color: #1a1a1a; }
    h1 { font-size: 1.35rem; }
    .muted { color: #666; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  <p>${body}</p>
  <p class="muted">Можете закрыть эту страницу и вернуться в Telegram-бот.</p>
</body>
</html>`;
}

export const Route = createFileRoute("/api/public/robokassa/success")({
  server: {
    handlers: {
      GET: async () =>
        new Response(
          htmlPage(
            "Оплата прошла успешно",
            "Спасибо! Платёж принят. Файлы придут в Telegram-бот автоматически в течение минуты.",
          ),
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        ),
    },
  },
});
