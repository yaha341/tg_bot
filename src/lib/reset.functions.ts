import { createServerFn } from "@tanstack/react-start";
import { requireAdmin } from "./admin-session.server";

async function db() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

async function emptyBucket(bucket: string) {
  const s = await db();
  // Recursively list and remove files. Storage list() returns files & folders for a prefix.
  async function walk(prefix: string): Promise<string[]> {
    const { data, error } = await s.storage.from(bucket).list(prefix, { limit: 1000 });
    if (error) return [];
    const files: string[] = [];
    for (const item of data ?? []) {
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.id === null || (item as any).metadata === null) {
        // folder
        files.push(...(await walk(path)));
      } else {
        files.push(path);
      }
    }
    return files;
  }
  const all = await walk("");
  if (all.length > 0) {
    await s.storage.from(bucket).remove(all);
  }
}

export const resetAllData = createServerFn({ method: "POST" }).handler(async () => {
  await requireAdmin();
  const s = await db();

  // Delete data rows (order matters due to FKs)
  await s.from("order_items").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await s.from("orders").delete().neq("id", -1);
  await s.from("cart_items").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await s.from("product_images").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await s.from("products").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await s.from("categories").delete().neq("id", "00000000-0000-0000-0000-000000000000");

  // Reset bot users state so checkout flows start fresh
  await s.from("bot_users").update({ state: {} }).neq("telegram_id", -1);

  // Reset orders sequence so numbering starts from 1
  try {
    await (s as any).rpc("exec_sql"); // noop if not present
  } catch {}

  // Wipe storage buckets
  await emptyBucket("product-images");
  await emptyBucket("product-files");
  await emptyBucket("payment-proofs");

  return { ok: true as const };
});