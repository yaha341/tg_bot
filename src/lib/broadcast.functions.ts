import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const payloadSchema = z.object({
  message_text: z.string().min(1).max(4000),
  photo_paths: z.array(z.string().min(1)).max(10).default([]),
  product_ids: z.array(z.string().uuid()).max(8).default([]),
  show_catalog: z.boolean().default(true),
  audience_type: z.enum(["all", "country", "buyers", "non_buyers", "test"]),
  audience_filter: z.object({ country_code: z.string().optional() }).optional(),
});

export const previewBroadcastAudience = createServerFn({ method: "GET" })
  .validator((d: unknown) =>
    z
      .object({
        audience_type: z.enum(["all", "country", "buyers", "non_buyers", "test"]),
        country_code: z.string().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./admin-session.server");
    const { resolveAudienceIds } = await import("./broadcast.server");
    await requireAdmin();
    const ids = await resolveAudienceIds(data.audience_type, { country_code: data.country_code });
    return { count: new Set(ids).size };
  });

export const sendTestBroadcastFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => payloadSchema.parse(d))
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./admin-session.server");
    const { sendTestBroadcast } = await import("./broadcast.server");
    await requireAdmin();
    return await sendTestBroadcast({
      ...data,
      audience_filter: data.audience_filter,
    });
  });

export const startBroadcastFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => payloadSchema.parse(d))
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./admin-session.server");
    const { createBroadcast, processBroadcastBatch } = await import("./broadcast.server");
    await requireAdmin();
    const broadcast = await createBroadcast({
      ...data,
      audience_filter: data.audience_filter,
    });
    for (let i = 0; i < 4; i++) {
      const result = await processBroadcastBatch();
      if (result.done) break;
    }
    return broadcast;
  });

export const listBroadcastsFn = createServerFn({ method: "GET" }).handler(async () => {
  const { requireAdmin } = await import("./admin-session.server");
  await requireAdmin();
  const { supabaseAdmin } = await import("@/integrations-supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("broadcasts")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return data ?? [];
});

export const getBroadcastFn = createServerFn({ method: "GET" })
  .validator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./admin-session.server");
    await requireAdmin();
    const { supabaseAdmin } = await import("@/integrations-supabase/client.server");
    const { data: row, error } = await supabaseAdmin.from("broadcasts").select("*").eq("id", data.id).single();
    if (error) throw new Error(error.message);
    return row;
  });

export const processBroadcastBatchFn = createServerFn({ method: "POST" }).handler(async () => {
  const { requireAdmin } = await import("./admin-session.server");
  const { processBroadcastBatch } = await import("./broadcast.server");
  await requireAdmin();
  return await processBroadcastBatch();
});

export const getBroadcastUploadUrl = createServerFn({ method: "POST" })
  .validator((d: unknown) => z.object({ filename: z.string().min(1) }).parse(d))
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./admin-session.server");
    await requireAdmin();
    const ext = (data.filename.split(".").pop() || "jpg").toLowerCase().slice(0, 10);
    const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { supabaseAdmin } = await import("@/integrations-supabase/client.server");
    const { data: signed, error } = await supabaseAdmin.storage.from("broadcast-images").createSignedUploadUrl(key);
    if (error || !signed) throw new Error(error?.message || "Upload error");
    return { path: key, signedUrl: signed.signedUrl };
  });
