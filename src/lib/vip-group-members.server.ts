/** Telegram group member lookup helpers (getChatMember). */

import { tgVip } from "./vip-bot.server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations-supabase/types";

export type TgMemberUser = {
  id: number;
  username?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  is_bot?: boolean;
};

export type TgChatMemberResult = {
  status: string;
  user: TgMemberUser;
};

export function memberStatusIsInGroup(status: string): boolean {
  return (
    status === "member" ||
    status === "administrator" ||
    status === "creator" ||
    status === "restricted"
  );
}

/** Creator/admin — подписка не нужна, cron не кикает. */
export function memberStatusExemptFromSubscription(status: string): boolean {
  return status === "creator" || status === "administrator";
}

export async function fetchVipChatMember(
  groupId: string,
  telegramId: number,
): Promise<TgChatMemberResult | null> {
  const res = await tgVip("getChatMember", { chat_id: groupId, user_id: telegramId });
  if (!res.ok) return null;
  const r = res.result as TgChatMemberResult | undefined;
  if (!r?.user?.id) return null;
  return r;
}

export async function loadVipGroupId(
  s: SupabaseClient<Database>,
): Promise<string> {
  const { data } = await s.from("app_settings").select("value").eq("key", "vip_group_id").maybeSingle();
  return ((data?.value as string) || "").trim();
}
