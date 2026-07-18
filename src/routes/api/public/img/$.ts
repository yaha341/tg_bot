import { createFileRoute } from "@tanstack/react-router";

function resolveBucketAndKey(splat: string): { bucket: string; key: string } {
  if (splat.startsWith("broadcast-images/")) {
    return { bucket: "broadcast-images", key: splat.slice("broadcast-images/".length) };
  }
  return { bucket: "product-images", key: splat };
}

export const Route = createFileRoute("/api/public/img/$")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const splat = params._splat;
        if (!splat) return new Response("Not found", { status: 404 });
        const { bucket, key } = resolveBucketAndKey(splat);
        const { supabaseAdmin } = await import("@/integrations-supabase/client.server");
        const { data, error } = await supabaseAdmin.storage.from(bucket).download(key);
        if (error || !data) return new Response("Not found", { status: 404 });
        const buf = await data.arrayBuffer();
        return new Response(buf, {
          headers: {
            "Content-Type": data.type || "image/jpeg",
            "Cache-Control": "public, max-age=3600",
          },
        });
      },
    },
  },
});
