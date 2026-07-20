import { createFileRoute } from "@tanstack/react-router";
import { ensureTelegramWebhook } from "@/lib/webhook-ensure.server";

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = request.headers.get("authorization");
  if (auth === `Bearer ${secret}`) return true;
  const url = new URL(request.url);
  return url.searchParams.get("secret") === secret;
}

/** Hourly/self-heal: re-set Telegram webhook if URL was cleared. Use with cron-job.org on free Vercel. */
export const Route = createFileRoute("/api/cron/ensure-webhook")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthorized(request)) {
          return new Response("Unauthorized", { status: 401 });
        }
        const result = await ensureTelegramWebhook();
        return Response.json(result, { status: result.ok ? 200 : 500 });
      },
    },
  },
});
