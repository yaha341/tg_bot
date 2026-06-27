import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/telegram/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let update: unknown;
        try {
          update = await request.json();
        } catch {
          return new Response("bad json", { status: 400 });
        }
        const { handleUpdate } = await import("@/lib/bot.server");
        await handleUpdate(update);
        return new Response("ok");
      },
    },
  },
});