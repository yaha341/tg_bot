import { createFileRoute } from "@tanstack/react-router";
import { isAdminAuthed } from "@/lib/admin-session.server";

export const Route = createFileRoute("/api/admin/upload")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await isAdminAuthed())) {
          return new Response("Unauthorized", { status: 401 });
        }
        const form = await request.formData();
        const file = form.get("file");
        const bucket = String(form.get("bucket") || "");
        if (!(file instanceof File) || !["product-images", "product-files"].includes(bucket)) {
          return new Response("Bad request", { status: 400 });
        }
        const ext = (file.name.split(".").pop() || "bin").toLowerCase().slice(0, 10);
        const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const bytes = new Uint8Array(await file.arrayBuffer());
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { error } = await supabaseAdmin.storage.from(bucket).upload(key, bytes, {
          contentType: file.type || "application/octet-stream",
          upsert: false,
        });
        if (error) return new Response(error.message, { status: 500 });
        return Response.json({ path: key, name: file.name });
      },
    },
  },
});