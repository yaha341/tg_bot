import { createFileRoute } from "@tanstack/react-router";
import { isAdminAuthed } from "@/lib/admin-session.server";

export const Route = createFileRoute("/api/admin/file/$")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        if (!(await isAdminAuthed())) return new Response("Unauthorized", { status: 401 });
        const splat = params._splat;
        if (!splat) return new Response("Not found", { status: 404 });
        const url = new URL(request.url);
        const bucket = url.searchParams.get("bucket") || "product-files";
        if (!["product-files", "payment-proofs", "product-images"].includes(bucket)) {
          return new Response("Bad bucket", { status: 400 });
        }
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data, error } = await supabaseAdmin.storage.from(bucket).download(splat);
        if (error || !data) return new Response("Not found", { status: 404 });
        const buf = await data.arrayBuffer();
        return new Response(buf, {
          headers: { "Content-Type": data.type || "application/octet-stream" },
        });
      },
    },
  },
});