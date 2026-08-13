import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export type TelegramUserHit = {
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  sources: Array<"shop" | "vip">;
};

async function db() {
  const { supabaseAdmin } = await import("@/integrations-supabase/client.server");
  return supabaseAdmin;
}

function mergeHits(
  map: Map<number, TelegramUserHit>,
  row: {
    telegram_id: number;
    username?: string | null;
    first_name?: string | null;
    last_name?: string | null;
  },
  source: "shop" | "vip",
) {
  const id = Number(row.telegram_id);
  if (!Number.isFinite(id) || id <= 0) return;
  const prev = map.get(id);
  if (!prev) {
    map.set(id, {
      telegram_id: id,
      username: row.username ?? null,
      first_name: row.first_name ?? null,
      last_name: row.last_name ?? null,
      sources: [source],
    });
    return;
  }
  if (!prev.sources.includes(source)) prev.sources.push(source);
  if (!prev.username && row.username) prev.username = row.username;
  if (!prev.first_name && row.first_name) prev.first_name = row.first_name;
  if (!prev.last_name && row.last_name) prev.last_name = row.last_name;
}

export async function searchTelegramUsers(query: string, limit = 30): Promise<TelegramUserHit[]> {
  const q = query.trim().replace(/^@/, "");
  if (!q || q.length < 1) return [];

  const s = await db();
  const map = new Map<number, TelegramUserHit>();
  const isNumeric = /^\d+$/.test(q);

  if (isNumeric) {
    const id = Number(q);
    const [{ data: shop }, { data: vip }] = await Promise.all([
      s
        .from("bot_users")
        .select("telegram_id, username, first_name, last_name")
        .eq("telegram_id", id)
        .maybeSingle(),
      s
        .from("vip_subscriptions")
        .select("telegram_id, username, first_name, last_name")
        .eq("telegram_id", id)
        .order("created_at", { ascending: false })
        .limit(1),
    ]);
    if (shop) mergeHits(map, shop as any, "shop");
    for (const row of vip ?? []) mergeHits(map, row as any, "vip");

    if (map.size === 0) {
      const { lookupGroupMemberForSearch } = await import("./vip-group-members.functions");
      const fromGroup = await lookupGroupMemberForSearch(id);
      if (fromGroup) {
        mergeHits(map, fromGroup, "vip");
      }
    }

    return [...map.values()];
  }

  const pattern = `%${q.replace(/[%_,]/g, "")}%`;
  if (pattern === "%%") return [];

  const [{ data: shopRows }, { data: vipRows }] = await Promise.all([
    s
      .from("bot_users")
      .select("telegram_id, username, first_name, last_name")
      .or(`username.ilike.${pattern},first_name.ilike.${pattern},last_name.ilike.${pattern}`)
      .limit(limit),
    s
      .from("vip_subscriptions")
      .select("telegram_id, username, first_name, last_name, created_at")
      .or(`username.ilike.${pattern},first_name.ilike.${pattern},last_name.ilike.${pattern}`)
      .order("created_at", { ascending: false })
      .limit(limit * 3),
  ]);

  for (const row of shopRows ?? []) mergeHits(map, row as any, "shop");
  for (const row of vipRows ?? []) mergeHits(map, row as any, "vip");

  return [...map.values()].slice(0, limit);
}

export const searchTelegramUsersFn = createServerFn({ method: "GET" })
  .validator((d: unknown) =>
    z.object({ query: z.string().min(1).max(100) }).parse(d),
  )
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./admin-session.server");
    const { requireModule } = await import("./tenant-config.server");
    await requireAdmin();
    await requireModule("blocked_users");
    return await searchTelegramUsers(data.query);
  });
