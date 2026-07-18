import { createFileRoute } from "@tanstack/react-router";
import { processBroadcastBatch } from "@/lib/broadcast.server";

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = request.headers.get("authorization");
  if (auth === `Bearer ${secret}`) return true;
  const url = new URL(request.url);
  return url.searchParams.get("secret") === secret;
}

export const Route = createFileRoute("/api/cron/broadcast")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthorized(request)) {
          return new Response("Unauthorized", { status: 401 });
        }
        try {
          let total = 0;
          let done = false;
          let last: Awaited<ReturnType<typeof processBroadcastBatch>> | undefined;
          for (let i = 0; i < 4 && !done; i++) {
            last = await processBroadcastBatch();
            total += last.processed;
            done = last.done;
            if (!last.processed) break;
          }
          return Response.json({ ok: true, processed: total, done, ...last });
        } catch (e: any) {
          console.error("[cron/broadcast]", e);
          return Response.json({ ok: false, error: e.message }, { status: 500 });
        }
      },
    },
  },
});
