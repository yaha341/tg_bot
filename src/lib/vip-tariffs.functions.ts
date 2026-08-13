import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin } from "./admin-session.server";
import type { TablesInsert, TablesUpdate } from "@/integrations-supabase/types";

async function db() {
  const { supabaseAdmin } = await import("@/integrations-supabase/client.server");
  return supabaseAdmin;
}

async function requireVip() {
  const { requireModule } = await import("./tenant-config.server");
  await requireModule("vip");
}
async function tenantBotId() {
  const { getConfiguredBotId } = await import("./tenant-config.server");
  return getConfiguredBotId();
}

const ENTRY_FALLBACK = {
  name: "Вход + 1 месяц",
  price: 10000,
  currency: "KZT",
  duration_days: 30,
  duration_minutes: 5,
  is_active: true,
  is_public: false,
  is_entry: true,
  sort_order: -100,
  _needsSchema: true,
};

export const getVipTariffs = createServerFn({ method: "GET" }).handler(async () => {
  await requireAdmin();
  await requireVip();
  const s = await db();
  const { data, error } = await s.from("vip_tariffs").select("*").order("sort_order");
  if (error) throw new Error(error.message);
  return data ?? [];
});

/** First-entry package. Never throws for missing is_entry column — returns safe fallback. */
export const getVipEntryTariff = createServerFn({ method: "GET" }).handler(async () => {
  await requireAdmin();
  await requireVip();
  try {
    const s = await db();
    const { data: existing, error: findError } = await s
      .from("vip_tariffs")
      .select("*")
      .eq("is_entry", true)
      .maybeSingle();

    if (findError) {
      console.error("[getVipEntryTariff] find:", findError.message);
      return { ...ENTRY_FALLBACK, _needsSchema: true };
    }
    if (existing) {
      return { ...existing, _needsSchema: false };
    }

    const { data: created, error } = await s
      .from("vip_tariffs")
      .insert({
        bot_id: await tenantBotId(),
        name: "Вход + 1 месяц",
        price: 10000,
        currency: "KZT",
        duration_days: 30,
        duration_minutes: 5,
        is_active: true,
        is_public: false,
        is_entry: true,
        sort_order: -100,
      })
      .select("*")
      .single();

    if (error) {
      console.error("[getVipEntryTariff] insert:", error.message);
      return { ...ENTRY_FALLBACK, _needsSchema: true };
    }
    return { ...created, _needsSchema: false };
  } catch (e) {
    console.error("[getVipEntryTariff] exception:", e);
    return { ...ENTRY_FALLBACK, _needsSchema: true };
  }
});

const SaveInput = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1),
  price: z.number().min(0),
  currency: z.string().min(1),
  duration_days: z.number().min(1),
  duration_minutes: z.number().min(1),
  is_active: z.boolean(),
  is_public: z.boolean().default(true),
  is_entry: z.boolean().optional(),
  sort_order: z.number(),
});

export const getVipBotUsername = createServerFn({ method: "GET" }).handler(async () => {
  await requireAdmin();
  await requireVip();
  const { resolveVipBotUsername } = await import("./vip-bot.server");
  return { username: resolveVipBotUsername() };
});

export const saveVipTariff = createServerFn({ method: "POST" })
  .validator((d: unknown) => SaveInput.parse(d))
  .handler(async ({ data }) => {
    await requireAdmin();
  await requireVip();
    const s = await db();
    const isEntry = data.is_entry !== undefined ? !!data.is_entry : false;

    // Only one entry package may exist — clear flag on others first
    if (isEntry) {
      let clearQ = s.from("vip_tariffs").update({ is_entry: false }).eq("is_entry", true);
      if (data.id) clearQ = clearQ.neq("id", data.id);
      const { error: clearError } = await clearQ;
      if (clearError) throw new Error(clearError.message);
    }

    const payload: TablesInsert<"vip_tariffs"> = {
      bot_id: await tenantBotId(),
      name: data.name,
      price: data.price,
      currency: data.currency,
      duration_days: data.duration_days,
      duration_minutes: data.duration_minutes,
      is_active: data.is_active,
      is_public: isEntry ? false : data.is_public,
      sort_order: isEntry ? -100 : data.sort_order,
      is_entry: data.is_entry !== undefined ? isEntry : undefined,
    };

    if (data.id) {
      const updatePayload: TablesUpdate<"vip_tariffs"> = payload;
      const { error } = await s.from("vip_tariffs").update(updatePayload).eq("id", data.id);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await s.from("vip_tariffs").insert(payload);
      if (error) throw new Error(error.message);
    }
    return { ok: true };
  });

const DeleteInput = z.object({ id: z.string().uuid() });

export const deleteVipTariff = createServerFn({ method: "POST" })
  .validator((d: unknown) => DeleteInput.parse(d))
  .handler(async ({ data }) => {
    await requireAdmin();
  await requireVip();
    const s = await db();
    const { data: row } = await s.from("vip_tariffs").select("*").eq("id", data.id).maybeSingle();
    if (row && (row as any).is_entry === true) {
      throw new Error("Тариф «Первый вход» нельзя удалить — выключите его галкой «Активен».");
    }
    const { error } = await s.from("vip_tariffs").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
