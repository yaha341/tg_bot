import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin } from "./admin-session.server";

async function db() {
  const { supabaseAdmin } = await import("@/integrations-supabase/client.server");
  return supabaseAdmin;
}

export const getSettings = createServerFn({ method: "GET" }).handler(async () => {
  await requireAdmin();
  const s = await db();
  const { data, error } = await s.from("app_settings").select("*");
  if (error) throw new Error(error.message);
  const map: Record<string, string> = {};
  for (const r of data ?? []) map[r.key as string] = (r.value as string) ?? "";
  return map;
});

const SaveInput = z.object({ key: z.string().min(1).max(100), value: z.string().max(100_000) });

export const saveSetting = createServerFn({ method: "POST" })
  .validator((d: unknown) => SaveInput.parse(d))
  .handler(async ({ data }) => {
    await requireAdmin();
    const s = await db();
    const { error } = await s
      .from("app_settings")
      .upsert({ key: data.key, value: data.value, updated_at: new Date().toISOString() });
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

export const getLegalDocUploadUrl = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z
      .object({
        kind: z.enum(["offer", "privacy"]),
        filename: z.string().min(1),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    await requireAdmin();
    const ext = (data.filename.split(".").pop() || "pdf").toLowerCase().slice(0, 10);
    const key = `${data.kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const s = await db();
    const { data: signed, error } = await s.storage.from("legal-docs").createSignedUploadUrl(key);
    if (error || !signed) throw new Error(error?.message || "Upload error");
    return { path: key, signedUrl: signed.signedUrl, filename: data.filename };
  });

export const clearLegalDocFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => z.object({ kind: z.enum(["offer", "privacy"]) }).parse(d))
  .handler(async ({ data }) => {
    await requireAdmin();
    const s = await db();
    const pathKey = data.kind === "offer" ? "legal_offer_file" : "legal_privacy_file";
    const nameKey = data.kind === "offer" ? "legal_offer_filename" : "legal_privacy_filename";
    const { data: row } = await s.from("app_settings").select("value").eq("key", pathKey).maybeSingle();
    const path = row?.value?.trim();
    if (path) {
      await s.storage.from("legal-docs").remove([path]);
    }
    await s.from("app_settings").upsert([
      { key: pathKey, value: "", updated_at: new Date().toISOString() },
      { key: nameKey, value: "", updated_at: new Date().toISOString() },
    ]);
    return { ok: true as const };
  });