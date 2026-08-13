import { createFileRoute } from "@tanstack/react-router";

async function runInBackground(task: () => Promise<void>) {
  try {
    const { waitUntil } = await import("@vercel/functions");
    waitUntil(task());
  } catch {
    await task();
  }
}

export const Route = createFileRoute("/api/public/zernio/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { moduleEnabled } = await import("@/lib/tenant-config.server");
        if (!(await moduleEnabled("instagram"))) {
          return new Response("ok", { status: 200 });
        }

        let payload: any;
        try {
          payload = await request.json();
        } catch {
          return new Response("bad json", { status: 400 });
        }

        const eventId = payload.id || payload.comment?.id || payload.message?.id || null;
        const eventType = payload.event || "unknown";

        const { supabaseAdmin } = await import("@/integrations-supabase/client.server");

        // Проверка дедупликации
        if (eventId) {
          const { data: existing } = await supabaseAdmin
            .from("zernio_logs")
            .select("id")
            .eq("event_id", String(eventId))
            .maybeSingle();

          if (existing) {
            return new Response("already processed", { status: 200 });
          }
        }

        // Логирование входящего события
        const { data: logEntry, error: insertError } = await supabaseAdmin.from("zernio_logs").insert({
          event_id: eventId ? String(eventId) : null,
          event_type: eventType,
          status: "pending",
          payload,
        }).select("id").single();

        if (insertError) {
          console.error("Failed to insert zernio log:", insertError);
        }

        // Запуск асинхронной обработки события
        runInBackground(async () => {
          try {
            const { handleZernioMessage, handleZernioComment } = await import("@/lib/zernio-bot.server");
            if (eventType === "message.received") {
              await handleZernioMessage(payload);
            } else if (eventType === "comment.received") {
              await handleZernioComment(payload);
            }
            
            if (logEntry?.id) {
              await supabaseAdmin.from("zernio_logs").update({ status: "processed" }).eq("id", logEntry.id);
            }
          } catch (err) {
            console.error(`Error processing zernio event ${eventId}:`, err);
            if (logEntry?.id) {
              await supabaseAdmin.from("zernio_logs").update({ status: "error" }).eq("id", logEntry.id);
            }
          }
        });

        return new Response("ok", { status: 200 });
      },
    },
  },
});
