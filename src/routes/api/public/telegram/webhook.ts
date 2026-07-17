import { createFileRoute } from "@tanstack/react-router";

async function runInBackground(task: () => Promise<void>) {
  try {
    const { waitUntil } = await import("@vercel/functions");
    waitUntil(task());
  } catch {
    await task();
  }
}

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

        const callbackData = (update as { callback_query?: { data?: string } })?.callback_query?.data;
        const runUpdate = async () => {
          const { handleUpdate } = await import("@/lib/bot.server");
          await handleUpdate(update);
        };

        // confirm/reject can take minutes on large orders — answer Telegram immediately
        // so it does not retry the same callback and deliver files multiple times
        if (typeof callbackData === "string" && (callbackData.startsWith("confirm:") || callbackData.startsWith("reject:"))) {
          await runInBackground(runUpdate);
          return new Response("ok");
        }

        await runUpdate();
        return new Response("ok");
      },
    },
  },
});
