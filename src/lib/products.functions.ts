import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin } from "./admin-session.server";

async function db() {
  const { supabaseAdmin } = await import("@/integrations-supabase/client.server");
  return supabaseAdmin;
}

export const listProducts = createServerFn({ method: "GET" }).handler(async () => {
  await requireAdmin();
  const s = await db();
  const { data, error } = await s
    .from("products")
    .select("*, product_images(id, image_path, sort_order), categories(name)")
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
});

export const getSignedUploadUrl = createServerFn({ method: "POST" })
  .validator((d: unknown) => z.object({ bucket: z.enum(["product-images", "product-files"]), filename: z.string() }).parse(d))
  .handler(async ({ data }) => {
    await requireAdmin();
    const ext = (data.filename.split(".").pop() || "bin").toLowerCase().slice(0, 10);
    const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const s = await db();
    const { data: signed, error } = await s.storage.from(data.bucket).createSignedUploadUrl(key);
    if (error || !signed) throw new Error(error?.message || "Error");
    return { path: key, name: data.filename, signedUrl: signed.signedUrl };
  });

export const getProduct = createServerFn({ method: "GET" })
  .validator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    await requireAdmin();
    const s = await db();
    const { data: prod, error } = await s
      .from("products")
      .select("*, product_images(id, image_path, sort_order)")
      .eq("id", data.id)
      .single();
    if (error) throw new Error(error.message);
    return prod;
  });

const SaveInput = z.object({
  id: z.string().uuid().optional(),
  category_id: z.string().uuid().nullable().optional(), // kept for backwards compatibility during migration
  category_ids: z.array(z.string().uuid()).default([]),
  name: z.string().min(1).max(200),
  description: z.string().max(4000).default(""),
  keywords: z.string().max(500).default(""),
  price: z.number().min(0),
  currency: z.string().min(1).max(8).default("KZT"),
  is_active: z.boolean().default(true),
  sort_order: z.number().int().default(0),
  file_path: z.string().nullable().optional(),
  file_name: z.string().nullable().optional(),
  image_paths: z.array(z.string()).default([]),
  country_prices: z.record(z.number()).optional().default({}),
});

export const saveProduct = createServerFn({ method: "POST" })
  .validator((d: unknown) => SaveInput.parse(d))
  .handler(async ({ data }) => {
    await requireAdmin();
    const s = await db();
    let productId = data.id;
    if (productId) {
      const { error } = await s
        .from("products")
        .update({
          category_id: data.category_ids[0] ?? null, // Sync the primary one just in case
          category_ids: data.category_ids,
          name: data.name,
          description: data.description,
          keywords: data.keywords,
          price: data.price,
          currency: data.currency,
          is_active: data.is_active,
          sort_order: data.sort_order,
          file_path: data.file_path ?? null,
          file_name: data.file_name ?? null,
          country_prices: data.country_prices,
        })
        .eq("id", productId);
      if (error) throw new Error(error.message);
    } else {
      const { data: inserted, error } = await s
        .from("products")
        .insert({
          category_id: data.category_ids[0] ?? null,
          category_ids: data.category_ids,
          name: data.name,
          description: data.description,
          keywords: data.keywords,
          price: data.price,
          currency: data.currency,
          is_active: data.is_active,
          sort_order: data.sort_order,
          file_path: data.file_path ?? null,
          file_name: data.file_name ?? null,
          country_prices: data.country_prices,
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      productId = inserted!.id as string;
    }
    // Replace images
    await s.from("product_images").delete().eq("product_id", productId);
    if (data.image_paths.length) {
      const rows = data.image_paths.map((p, idx) => ({
        product_id: productId!,
        image_path: p,
        sort_order: idx,
      }));
      const { error } = await s.from("product_images").insert(rows);
      if (error) throw new Error(error.message);
    }
    return { ok: true as const, id: productId };
  });

export const deleteProduct = createServerFn({ method: "POST" })
  .validator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    await requireAdmin();
    const s = await db();
    const { error } = await s.from("products").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

export const listCategoriesForProducts = createServerFn({ method: "GET" }).handler(async () => {
  await requireAdmin();
  const s = await db();
  const { data, error } = await s.from("categories").select("id, name, parent_id").order("name");
  if (error) throw new Error(error.message);
  return data ?? [];
});