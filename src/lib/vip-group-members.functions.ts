import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin } from "./admin-session.server";
async function db() {
  const { supabaseAdmin } = await import("@/integrations-supabase/client.server");
  return supabaseAdmin;
}

async function requireVip() {
  const { requireModule } = await import("./tenant-config.server");
  await requireModule("vip");
}

type VipChatMember = {
  status: string;
  user: {
    id: number;
    username?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    is_bot?: boolean;
  };
};

function memberStatusIsInGroup(status: string): boolean {
  return ["member", "administrator", "creator", "restricted"].includes(status);
}

export type VipGroupMemberLookup = {
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  member_status: string;
  is_in_group: boolean;
};

function toLookup(member: VipChatMember): VipGroupMemberLookup {
  return {
    telegram_id: member.user.id,
    username: member.user.username ?? null,
    first_name: member.user.first_name ?? null,
    last_name: member.user.last_name ?? null,
    member_status: member.status,
    is_in_group: memberStatusIsInGroup(member.status),
  };
}

export const lookupVipGroupMemberFn = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z
      .object({
        telegram_id: z
          .string()
          .min(1)
          .regex(/^\d{5,15}$/, "Telegram ID должен быть числом"),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    await requireAdmin();
    await requireVip();
    const { fetchVipChatMember, loadVipGroupId } = await import("./vip-group-members.server");
    const s = await db();
    const groupId = await loadVipGroupId(s);
    if (!groupId) throw new Error("Не настроен ID VIP группы в /admin/vip/settings");

    const telegramId = parseInt(data.telegram_id, 10);
    const member = await fetchVipChatMember(groupId, telegramId);
    if (!member) {
      throw new Error(
        "Пользователь не найден в VIP-группе. Убедитесь что ID верный и человек состоит в группе (или бот — админ).",
      );
    }

    if (member.user.is_bot) {
      throw new Error("Это бот — проверять не нужно.");
    }

    return toLookup(member);
  });

/** Used by users-search fallback — caller must be admin. */
export async function lookupGroupMemberForSearch(telegramId: number) {
  await requireVip();
  const { fetchVipChatMember, loadVipGroupId } = await import("./vip-group-members.server");
  const s = await db();
  const groupId = await loadVipGroupId(s);
  if (!groupId) return null;

  const member = await fetchVipChatMember(groupId, telegramId);
  if (!member?.user || member.user.is_bot) return null;

  return toLookup(member);
}
