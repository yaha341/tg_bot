import { tg } from "./telegram.server";
import { isAlreadyNotInChat, revokeVipInvite, tgVip } from "./vip-bot.server";

type TgSend = (method: string, payload: unknown) => Promise<{ ok: boolean; description?: string }>;

async function db() {
  const { supabaseAdmin } = await import("@/integrations-supabase/client.server");
  return supabaseAdmin;
}

async function tenantBotId() {
  const { getConfiguredBotId } = await import("./tenant-config.server");
  return getConfiguredBotId();
}

const BLOCKED_MSG = "⛔ Доступ к боту закрыт администратором.";

export async function isTelegramBlocked(telegramId: number): Promise<boolean> {
  const s = await db();
  const { data } = await s
    .from("blocked_users")
    .select("telegram_id")
    .eq("telegram_id", telegramId)
    .maybeSingle();
  return !!data;
}

export async function replyIfBlocked(
  chatId: number | undefined,
  telegramId: number | undefined,
  send: TgSend = tg,
): Promise<boolean> {
  if (!chatId || !telegramId) return false;
  if (!(await isTelegramBlocked(telegramId))) return false;
  await send("sendMessage", { chat_id: chatId, text: BLOCKED_MSG });
  return true;
}

async function kickFromVipGroup(telegramId: number) {
  const s = await db();
  const { data: settingsData } = await s.from("app_settings").select("*");
  const settings: Record<string, string> = {};
  for (const r of settingsData ?? []) settings[r.key as string] = (r.value as string) ?? "";
  const groupId = (settings.vip_group_id || "").trim();
  if (!groupId) return;

  const { data: userSubs } = await s
    .from("vip_subscriptions")
    .select("id, status, group_invite_link")
    .eq("telegram_id", telegramId)
    .in("status", ["active", "pending_payment"]);

  for (const row of userSubs ?? []) {
    await revokeVipInvite(groupId, row.group_invite_link as string | null);
  }

  const ban = await tgVip("banChatMember", {
    chat_id: groupId,
    user_id: telegramId,
    revoke_messages: false,
  });
  if (ban.ok || isAlreadyNotInChat(ban.description)) {
    await tgVip("unbanChatMember", {
      chat_id: groupId,
      user_id: telegramId,
      only_if_banned: true,
    });
  }

  await s
    .from("vip_subscriptions")
    .update({ status: "expired", group_invite_link: null, admin_note: "user_blocked" })
    .eq("telegram_id", telegramId)
    .eq("status", "active");

  await s
    .from("vip_subscriptions")
    .update({ status: "cancelled", group_invite_link: null })
    .eq("telegram_id", telegramId)
    .eq("status", "pending_payment");
}

export async function blockTelegramUser(
  telegramId: number,
  opts?: {
    reason?: string;
    username?: string | null;
    first_name?: string | null;
    notify?: boolean;
  },
) {
  const s = await db();

  const { error } = await s.from("blocked_users").upsert(
    {
      bot_id: await tenantBotId(),
      telegram_id: telegramId,
      username: opts?.username ?? null,
      first_name: opts?.first_name ?? null,
      reason: opts?.reason?.trim() || null,
      blocked_at: new Date().toISOString(),
    },
    { onConflict: "bot_id,telegram_id" },
  );
  if (error) throw new Error(error.message);

  await kickFromVipGroup(telegramId);

  await s
    .from("orders")
    .update({ status: "rejected", admin_note: "user_blocked" })
    .eq("telegram_id", telegramId)
    .in("status", ["awaiting_payment", "awaiting_confirmation"]);

  await s.from("cart_items").delete().eq("telegram_id", telegramId);

  if (opts?.notify !== false) {
    const text = "⛔ <b>Доступ к боту закрыт администратором.</b>";
    await tg("sendMessage", { chat_id: telegramId, text, parse_mode: "HTML" }).catch(() => {});
    await tgVip("sendMessage", { chat_id: telegramId, text, parse_mode: "HTML" }).catch(() => {});
  }

  return { ok: true as const };
}

export async function unblockTelegramUser(telegramId: number) {
  const s = await db();
  const { error } = await s.from("blocked_users").delete().eq("telegram_id", telegramId);
  if (error) throw new Error(error.message);
  return { ok: true as const };
}

export async function listBlockedUsers() {
  const s = await db();
  const { data, error } = await s
    .from("blocked_users")
    .select("*")
    .order("blocked_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}
