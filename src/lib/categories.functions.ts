import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { TablesUpdate } from "@/integrations-supabase/types";
import { requireAdmin } from "./admin-session.server";

async function db() {
  const { supabaseAdmin } = await import("@/integrations-supabase/client.server");
  return supabaseAdmin;
}

export const listCategories = createServerFn({ method: "GET" }).handler(async () => {
  await requireAdmin();
  const s = await db();
  const { data, error } = await s
    .from("categories")
    .select("*")
    .order("sort_order")
    .order("created_at");
  if (error) throw new Error(error.message);
  return data ?? [];
});

const CreateInput = z.object({
  name: z.string().min(1).max(120),
  parent_id: z.string().uuid().nullable().optional(),
  sort_order: z.number().int().optional(),
  is_visible: z.boolean().optional(),
});

export const createCategory = createServerFn({ method: "POST" })
  .validator((d: unknown) => CreateInput.parse(d))
  .handler(async ({ data }) => {
    await requireAdmin();
    const s = await db();
    const { error } = await s.from("categories").insert({
      name: data.name,
      parent_id: data.parent_id ?? null,
      sort_order: data.sort_order ?? 0,
      is_visible: data.is_visible ?? true,
    });
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

const UpdateInput = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  parent_id: z.string().uuid().nullable().optional(),
  sort_order: z.number().int().optional(),
  is_visible: z.boolean().optional(),
});

export const updateCategory = createServerFn({ method: "POST" })
  .validator((d: unknown) => UpdateInput.parse(d))
  .handler(async ({ data }) => {
    await requireAdmin();
    const s = await db();
    const patch: TablesUpdate<"categories"> = {
      name: data.name,
      parent_id: data.parent_id ?? null,
      sort_order: data.sort_order ?? 0,
    };
    if (typeof data.is_visible === "boolean") patch.is_visible = data.is_visible;
    const { error } = await s.from("categories").update(patch).eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

export const setCategoryVisible = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z.object({ id: z.string().uuid(), is_visible: z.boolean() }).parse(d),
  )
  .handler(async ({ data }) => {
    await requireAdmin();
    const s = await db();
    const { error } = await s
      .from("categories")
      .update({ is_visible: data.is_visible })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

export const deleteCategory = createServerFn({ method: "POST" })
  .validator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    await requireAdmin();
    const s = await db();

    // Collect this category + all descendants (CASCADE would remove them from categories)
    const { data: allCats } = await s.from("categories").select("id, parent_id");
    const toRemove = new Set<string>([data.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const c of allCats ?? []) {
        if (c.parent_id && toRemove.has(c.parent_id) && !toRemove.has(c.id)) {
          toRemove.add(c.id);
          grew = true;
        }
      }
    }

    // Strip removed ids from products.category_ids (JSON array is not FK-managed)
    const { data: products } = await s.from("products").select("id, category_ids, category_id");
    const productUpdates: Array<{ id: string; category_ids: string[]; category_id: string | null }> = [];
    for (const p of products ?? []) {
      const ids = Array.isArray(p.category_ids) ? (p.category_ids as string[]) : [];
      const next = ids.filter((id) => !toRemove.has(id));
      const primary = p.category_id && toRemove.has(p.category_id) ? next[0] ?? null : p.category_id;
      if (next.length !== ids.length || primary !== p.category_id) {
        productUpdates.push({ id: p.id, category_ids: next, category_id: primary ?? null });
      }
    }

    // Параллельное обновление вместо N+1 последовательных запросов
    await Promise.all(
      productUpdates.map((u) =>
        s.from("products").update({ category_ids: u.category_ids, category_id: u.category_id }).eq("id", u.id)
      )
    );

    const { error } = await s.from("categories").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });
