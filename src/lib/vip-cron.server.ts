import {
  escapeHtml,
  isAlreadyNotInChat,
  resolveVipBotUsername,
  revokeVipInvite,
  tgVip,
  WARN_STAGE_1,
  WARN_STAGE_2,
} from "@/lib/vip-bot.server";
import { memberStatusExemptFromSubscription } from "@/lib/vip-group-members.server";
import { formatDateTimeRu } from "@/lib/datetime";

export type VipCronResult = {
  warned: number;
  warned2: number;
  expired: number;
  kickFailed: number;
  errors: string[];
};

function addWarnOffset(base: Date, amount: number, isTest: boolean): Date {
  const d = new Date(base);
  if (isTest) d.setMinutes(d.getMinutes() + amount);
  else d.setDate(d.getDate() + amount);
  return d;
}

async function sendWarn(
  telegramId: number,
  expiresAt: string,
  stage: 1 | 2,
): Promise<{ ok: boolean; description?: string }> {
  const when = escapeHtml(formatDateTimeRu(expiresAt));
  const text =
    stage === 1
      ? `⚠️ <b>Напоминание</b>\n\nВаша VIP подписка истекает <b>${when}</b>.\n\nПродлите подписку заранее, чтобы не потерять доступ к группе.`
      : `🚨 <b>Срочно!</b>\n\nВаша VIP подписка истекает уже <b>${when}</b>!\n\nПродлите сейчас — иначе доступ к группе будет закрыт.`;

  const botUsername = resolveVipBotUsername();
  const reply_markup = botUsername
    ? {
        inline_keyboard: [
          [
            {
              text: "Продлить подписку",
              url: `https://t.me/${botUsername}?start=renew`,
            },
          ],
        ],
      }
    : {
        inline_keyboard: [[{ text: "Продлить подписку", callback_data: "buy_renew" }]],
      };

  // If no username configured, tell user to open /start renew (callback answered in bot)
  const extraHint = botUsername
    ? ""
    : "\n\nНажмите /start renew в этом боте, чтобы выбрать тариф.";

  return tgVip("sendMessage", {
    chat_id: telegramId,
    text: text + extraHint,
    parse_mode: "HTML",
    reply_markup,
  });
}

/** Shared VIP expiry/warn job — used by HTTP cron and admin "run now". */
export async function runVipCronJob(): Promise<VipCronResult> {
  const { requireModule } = await import("./tenant-config.server");
  await requireModule("vip");
  const { supabaseAdmin } = await import("@/integrations-supabase/client.server");
  const s = supabaseAdmin;

  const result: VipCronResult = { warned: 0, warned2: 0, expired: 0, kickFailed: 0, errors: [] };

  const { data: settingsData } = await s.from("app_settings").select("*");
  const settings: Record<string, string> = {};
  for (const r of settingsData ?? []) settings[r.key as string] = (r.value as string) ?? "";

  const isTest = settings.vip_test_mode === "true";
  let warnDays = parseInt(settings.vip_warn_days || "3", 10);
  let warnDays2 = parseInt(settings.vip_warn_days_2 || "1", 10);
  if (!Number.isFinite(warnDays) || warnDays < 1) warnDays = 3;
  if (!Number.isFinite(warnDays2) || warnDays2 < 1) warnDays2 = 1;
  // Ensure stage-2 window is strictly closer than stage-1
  if (warnDays2 >= warnDays) warnDays2 = Math.max(1, warnDays - 1);

  const groupId = settings.vip_group_id;

  if (!groupId) {
    throw new Error("vip_group_id не настроен в настройках VIP");
  }

  const now = new Date();
  const threshold1 = addWarnOffset(now, warnDays, isTest);
  const threshold2 = addWarnOffset(now, warnDays2, isTest);

  // 1st warning: not warned yet, within first window
  const { data: stage1 } = await s
    .from("vip_subscriptions")
    .select("*")
    .eq("status", "active")
    .lte("expires_at", threshold1.toISOString())
    .gt("expires_at", now.toISOString())
    .is("admin_note", null);

  // Prefer warning the latest-expiring active per user (avoid spam if duplicates slipped in)
  const pickLatestPerUser = <T extends { telegram_id: number | null; expires_at: string | null }>(
    rows: T[] | null,
  ): T[] => {
    const best = new Map<number, T>();
    for (const sub of rows ?? []) {
      const tid = sub.telegram_id as number;
      const prev = best.get(tid);
      if (!prev || new Date(sub.expires_at as string) > new Date(prev.expires_at as string)) {
        best.set(tid, sub);
      }
    }
    return [...best.values()];
  };

  for (const sub of pickLatestPerUser(stage1)) {
    try {
      const sent = await sendWarn(sub.telegram_id as number, sub.expires_at as string, 1);
      if (sent.ok) {
        await s.from("vip_subscriptions").update({ admin_note: WARN_STAGE_1 }).eq("id", sub.id);
        result.warned++;
      } else {
        result.errors.push(`warn1 ${sub.telegram_id}: ${sent.description || "send failed"}`);
      }
    } catch (err) {
      result.errors.push(`warn1 ${sub.telegram_id}: ${(err as Error).message}`);
    }
  }

  // 2nd warning: already got 1st, within second (closer) window
  const { data: stage2 } = await s
    .from("vip_subscriptions")
    .select("*")
    .eq("status", "active")
    .lte("expires_at", threshold2.toISOString())
    .gt("expires_at", now.toISOString())
    .eq("admin_note", WARN_STAGE_1);

  for (const sub of pickLatestPerUser(stage2)) {
    try {
      const sent = await sendWarn(sub.telegram_id as number, sub.expires_at as string, 2);
      if (sent.ok) {
        await s.from("vip_subscriptions").update({ admin_note: WARN_STAGE_2 }).eq("id", sub.id);
        result.warned2++;
      } else {
        result.errors.push(`warn2 ${sub.telegram_id}: ${sent.description || "send failed"}`);
      }
    } catch (err) {
      result.errors.push(`warn2 ${sub.telegram_id}: ${(err as Error).message}`);
    }
  }

  const { data: subsToExpire } = await s
    .from("vip_subscriptions")
    .select("*")
    .eq("status", "active")
    .lte("expires_at", now.toISOString());

  for (const sub of subsToExpire ?? []) {
    try {
      const { count: otherActive } = await s
        .from("vip_subscriptions")
        .select("*", { count: "exact", head: true })
        .eq("telegram_id", sub.telegram_id)
        .eq("status", "active")
        .gt("expires_at", now.toISOString())
        .neq("id", sub.id);

      if ((otherActive ?? 0) > 0) {
        await revokeVipInvite(groupId, sub.group_invite_link as string | null);
        await s
          .from("vip_subscriptions")
          .update({ status: "expired", group_invite_link: null })
          .eq("id", sub.id);
        result.expired++;
        continue;
      }

      const memberRes = await tgVip("getChatMember", {
        chat_id: groupId,
        user_id: sub.telegram_id,
      });
      const memberStatus = (memberRes.result as { status?: string } | undefined)?.status;
      if (memberStatus && memberStatusExemptFromSubscription(memberStatus)) {
        await revokeVipInvite(groupId, sub.group_invite_link as string | null);
        await s
          .from("vip_subscriptions")
          .update({ status: "expired", group_invite_link: null })
          .eq("id", sub.id);
        result.expired++;
        continue;
      }

      const ban = await tgVip("banChatMember", {
        chat_id: groupId,
        user_id: sub.telegram_id,
        revoke_messages: false,
      });

      if (!ban.ok && !isAlreadyNotInChat(ban.description)) {
        result.kickFailed++;
        result.errors.push(`kick ${sub.telegram_id}: ${ban.description || "ban failed"}`);
        continue;
      }

      await tgVip("unbanChatMember", {
        chat_id: groupId,
        user_id: sub.telegram_id,
        only_if_banned: true,
      });

      await revokeVipInvite(groupId, sub.group_invite_link as string | null);

      await tgVip("sendMessage", {
        chat_id: sub.telegram_id,
        text: `❌ <b>Ваша VIP подписка истекла!</b>\n\nВы были исключены из VIP группы. Чтобы вернуться, оформите новую подписку в боте.`,
        parse_mode: "HTML",
      });

      await s
        .from("vip_subscriptions")
        .update({ status: "expired", group_invite_link: null })
        .eq("id", sub.id);
      result.expired++;
    } catch (err) {
      result.errors.push(`expire ${sub.telegram_id}: ${(err as Error).message}`);
    }
  }

  return result;
}

export function isVipCronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const url = new URL(request.url);
  if (url.searchParams.get("secret") === secret) return true;

  const auth = request.headers.get("authorization");
  if (auth === `Bearer ${secret}`) return true;

  // Keep Vercel Cron header support if ever enabled on a paid plan
  if (request.headers.get("x-vercel-cron") === "1") return true;

  return false;
}
