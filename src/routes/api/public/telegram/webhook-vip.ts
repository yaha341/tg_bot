import { createFileRoute } from "@tanstack/react-router";
import { verifyTelegramWebhookSecret } from "@/lib/telegram-webhook.server";

export const Route = createFileRoute("/api/public/telegram/webhook-vip")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!verifyTelegramWebhookSecret(request, ["VIP_TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_WEBHOOK_SECRET"])) {
          return new Response("unauthorized", { status: 401 });
        }
        const { moduleEnabled } = await import("@/lib/tenant-config.server");
        if (!(await moduleEnabled("vip"))) {
          return new Response("ok", { status: 200 });
        }
        let update: unknown;
        try {
          update = await request.json();
        } catch {
          return new Response("bad json", { status: 400 });
        }
        const { handleVipUpdate } = await import("@/lib/vip-bot.server");
        await handleVipUpdate(update);
        return new Response("ok");
      },
    },
  },
});
