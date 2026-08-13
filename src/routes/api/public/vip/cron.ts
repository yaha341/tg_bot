import { createFileRoute } from "@tanstack/react-router";
import { isVipCronAuthorized, runVipCronJob } from "@/lib/vip-cron.server";
import { ensureDidWebhooks } from "@/lib/webhook-ensure.server";

export const Route = createFileRoute("/api/public/vip/cron")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isVipCronAuthorized(request)) {
          return new Response("Unauthorized", { status: 401 });
        }
        const { moduleEnabled } = await import("@/lib/tenant-config.server");
        if (!(await moduleEnabled("vip"))) {
          return Response.json({ ok: true, vipCron: { skipped: true, reason: "VIP module disabled" } });
        }

        try {
          // Self-heal shop+VIP webhooks every cron tick (URL empty / secret mismatch / delivery errors)
          const webhooks = await ensureDidWebhooks();
          let vipCron: Awaited<ReturnType<typeof runVipCronJob>> | { skipped: true; reason: string };
          try {
            vipCron = await runVipCronJob();
          } catch (e) {
            // e.g. vip_group_id missing — still report webhook heal
            vipCron = { skipped: true, reason: (e as Error).message };
          }
          return Response.json({ ok: true, webhooks, vipCron });
        } catch (e) {
          return Response.json({ ok: false, error: (e as Error).message }, { status: 500 });
        }
      },
    },
  },
});
