import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin } from "./admin-session.server";
import { formatDateTimeRu } from "./datetime";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function isAlreadyNotInChat(description?: string): boolean {
  if (!description) return false;
  const value = description.toLowerCase();
  return [
    "user_not_participant",
    "user not found",
    "chat_not_found",
    "participant_id_invalid",
    "user_id_invalid",
  ].some((part) => value.includes(part));
}

async function tgVip(method: string, payload: unknown) {
  const { tgVip: call } = await import("./vip-bot.server");
  return call(method, payload);
}

async function isVipGroupMember(groupId: string, telegramId: number) {
  const { isVipGroupMember: check } = await import("./vip-bot.server");
  return check(groupId, telegramId);
}

async function revokeVipInvite(groupId: string, inviteLink: string | null | undefined) {
  const { revokeVipInvite: revoke } = await import("./vip-bot.server");
  return revoke(groupId, inviteLink);
}

async function assignMemberTariff(
  s: any,
  telegramId: number,
  user: { username?: string | null; first_name?: string | null; last_name?: string | null },
  tariffId: string,
  source: "deep_link" | "payment" | "admin",
) {
  const { assignMemberTariff: assign } = await import("./vip-member.server");
  return assign(s, telegramId, user, tariffId, source);
}

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

async function expireOtherActivesAndRevokeInvites(
  s: Awaited<ReturnType<typeof db>>,
  telegramId: number,
  keepId: string,
  groupId: string,
) {
  const { data: others } = await s
    .from("vip_subscriptions")
    .select("id, group_invite_link")
    .eq("telegram_id", telegramId)
    .eq("status", "active")
    .neq("id", keepId);

  for (const other of others ?? []) {
    await revokeVipInvite(groupId, other.group_invite_link as string | null);
  }

  if ((others ?? []).length > 0) {
    await s
      .from("vip_subscriptions")
      .update({ status: "expired", group_invite_link: null })
      .eq("telegram_id", telegramId)
      .eq("status", "active")
      .neq("id", keepId);
  }
}

/** Latest valid active expiry for stacking renew periods (or null). */
async function getLatestActiveExpiry(
  s: Awaited<ReturnType<typeof db>>,
  telegramId: number,
  excludeId?: string,
): Promise<Date | null> {
  let q = s
    .from("vip_subscriptions")
    .select("expires_at")
    .eq("telegram_id", telegramId)
    .eq("status", "active")
    .gt("expires_at", new Date().toISOString());
  if (excludeId) q = q.neq("id", excludeId);
  const { data } = await q.order("expires_at", { ascending: false }).limit(1).maybeSingle();
  if (!data?.expires_at) return null;
  return new Date(data.expires_at as string);
}

function addTariffDuration(base: Date, tariff: { duration_minutes?: number; duration_days?: number } | null, isTest: boolean): Date {
  const expiresAt = new Date(base);
  if (isTest) {
    expiresAt.setMinutes(expiresAt.getMinutes() + (tariff?.duration_minutes || 1));
  } else {
    expiresAt.setDate(expiresAt.getDate() + (tariff?.duration_days || 30));
  }
  return expiresAt;
}

type MemberUserFields = {
  username?: string | null;
  first_name?: string | null;
  last_name?: string | null;
};

/** After manual/admin activation: invite if needed, notify user, save invite link. */
async function grantVipAccessAfterManual(
  s: Awaited<ReturnType<typeof db>>,
  opts: {
    subscriptionId: string;
    telegramId: number;
    expiresAt: Date;
    groupId: string;
    settings: Record<string, string>;
    user: MemberUserFields;
  },
): Promise<{ inGroup: boolean; inviteSent: boolean }> {
  const alreadyInGroup = await isVipGroupMember(opts.groupId, opts.telegramId);
  let link: string | null = null;

  if (!alreadyInGroup) {
    const inviteLinkData = await tgVip("createChatInviteLink", {
      chat_id: opts.groupId,
      member_limit: 1,
      name: `vip-man-${opts.subscriptionId.slice(0, 8)}`,
      expire_date: Math.floor(opts.expiresAt.getTime() / 1000),
    });

    if (!inviteLinkData.ok) {
      throw new Error("Не удалось создать ссылку-приглашение. Убедитесь что бот админ в группе.");
    }

    link = (inviteLinkData.result as { invite_link?: string }).invite_link ?? null;
  }

  const { error: linkErr } = await s
    .from("vip_subscriptions")
    .update({ group_invite_link: link })
    .eq("id", opts.subscriptionId);

  if (linkErr) {
    if (link) await revokeVipInvite(opts.groupId, link);
    throw new Error("Ошибка сохранения ссылки: " + linkErr.message);
  }

  const welcomeMsg = escapeHtml(opts.settings.vip_welcome_message || "Ваша VIP подписка активна!");
  const until = escapeHtml(formatDateTimeRu(opts.expiresAt));

  if (alreadyInGroup) {
    await tgVip("sendMessage", {
      chat_id: opts.telegramId,
      text:
        `✅ ${welcomeMsg}\n\n` +
        `Подписка оформлена администратором до: <b>${until}</b>\n\n` +
        `Вы уже в VIP-группе — новая ссылка не нужна.`,
      parse_mode: "HTML",
    });
  } else if (link) {
    await tgVip("sendMessage", {
      chat_id: opts.telegramId,
      text:
        `✅ ${welcomeMsg}\n\n` +
        `Подписка оформлена администратором до: <b>${until}</b>\n\n` +
        `Ваша персональная одноразовая ссылка для вступления:\n${link}`,
      parse_mode: "HTML",
    });
  }

  return { inGroup: alreadyInGroup, inviteSent: !!link };
}

// Test function to check Supabase connection (real totals, not limit(1))
export const testVipDbConnection = createServerFn({ method: "GET" })
  .handler(async () => {
    await requireAdmin();
    await requireVip();

    try {
      const s = await db();

      const [settingsRes, tariffsRes, subsRes, pendingRes] = await Promise.all([
        s.from("app_settings").select("*", { count: "exact", head: true }),
        s.from("vip_tariffs").select("*", { count: "exact", head: true }),
        s.from("vip_subscriptions").select("*", { count: "exact", head: true }),
        s
          .from("vip_subscriptions")
          .select("*", { count: "exact", head: true })
          .eq("status", "pending_payment"),
      ]);

      const firstError =
        settingsRes.error?.message ||
        tariffsRes.error?.message ||
        subsRes.error?.message ||
        pendingRes.error?.message;

      if (firstError) {
        return { success: false, error: firstError };
      }

      return {
        success: true,
        settingsCount: settingsRes.count ?? 0,
        tariffsCount: tariffsRes.count ?? 0,
        subscriptionsCount: subsRes.count ?? 0,
        pendingCount: pendingRes.count ?? 0,
        message: "All queries successful",
      };
    } catch (error) {
      console.error("[testVipDbConnection] Exception:", error);
      return { success: false, error: (error as Error).message };
    }
  });

export const getVipSubscriptions = createServerFn({ method: "GET" })
  .validator((d: unknown) => z.object({ status: z.string().optional() }).parse(d ?? {}))
  .handler(async ({ data }) => {
    await requireAdmin();
    await requireVip();
    const s = await db();
    const status = data?.status && data.status !== "all" ? data.status : null;

    try {
      let q = s
        .from("vip_subscriptions")
        .select("*, vip_tariffs(name, duration_days, duration_minutes)")
        .order("created_at", { ascending: false });

      if (status) q = q.eq("status", status);

      const { data: subs, error } = await q;

      if (!error) {
        return subs ?? [];
      }

      console.error("[getVipSubscriptions] Join query error, fallback:", error.message);
      let simple = s.from("vip_subscriptions").select("*").order("created_at", { ascending: false });
      if (status) simple = simple.eq("status", status);
      const { data: simpleSubs, error: simpleError } = await simple;
      if (simpleError) {
        console.error("[getVipSubscriptions] simple error:", simpleError.message);
        return [];
      }
      return simpleSubs ?? [];
    } catch (e) {
      console.error("[getVipSubscriptions] exception:", e);
      return [];
    }
  });

/** Shared confirm logic for admin UI and VIP bot callbacks */
export async function activateVipSubscription(id: string) {
  await requireVip();
  console.log("[confirmVipSubscription] START - Confirming subscription:", id);
  const s = await db();

  const { data: sub, error: fetchError } = await s
    .from("vip_subscriptions")
    .select("*, vip_tariffs(*)")
    .eq("id", id)
    .single();

  if (fetchError) {
    console.error("[confirmVipSubscription] Error fetching subscription:", fetchError);
    throw new Error("Ошибка получения подписки: " + fetchError.message);
  }

  if (!sub) {
    throw new Error("Подписка не найдена");
  }

  if (sub.status === "active") {
    throw new Error("Подписка уже активна");
  }

  if (sub.status !== "pending_payment") {
    throw new Error("Подписку можно подтвердить только из статуса «ожидает оплаты»");
  }

  const { data: settingsData } = await s.from("app_settings").select("*");
  const settings: Record<string, string> = {};
  for (const r of settingsData ?? []) settings[r.key as string] = (r.value as string) ?? "";

  const groupId = settings.vip_group_id;
  if (!groupId) {
    throw new Error("Не настроен ID VIP группы в настройках");
  }

  const tariff = sub.vip_tariffs as any;
  const isTest = settings.vip_test_mode === "true";

  const now = new Date();
  const latestOtherExpiry = await getLatestActiveExpiry(s, sub.telegram_id as number, id);
  // Stack renew onto remaining paid time instead of resetting from "now"
  const periodBase =
    latestOtherExpiry && latestOtherExpiry.getTime() > now.getTime() ? latestOtherExpiry : now;
  const expiresAt = addTariffDuration(periodBase, tariff, isTest);

  const alreadyInGroup = await isVipGroupMember(groupId, sub.telegram_id as number);
  // Invite only when user is NOT in the group (left early / first join / kick failed then left)
  const needsInvite = !alreadyInGroup;
  const isStackedRenewal = !!(latestOtherExpiry && latestOtherExpiry.getTime() > now.getTime());

  let link: string | null = null;

  if (needsInvite) {
    // Create one-time invite BEFORE marking active — avoids stuck "active" without link
    const inviteLinkData = await tgVip("createChatInviteLink", {
      chat_id: groupId,
      member_limit: 1,
      name: `vip-${id.slice(0, 8)}`,
      expire_date: Math.floor(expiresAt.getTime() / 1000),
    });

    if (!inviteLinkData.ok) {
      throw new Error("Не удалось создать ссылку-приглашение. Убедитесь что бот админ в группе.");
    }

    link = (inviteLinkData.result as any).invite_link as string;
  }

  const { data: updated, error: updateError } = await s
    .from("vip_subscriptions")
    .update({
      status: "active",
      started_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      group_invite_link: link,
      admin_note: null,
    })
    .eq("id", id)
    .eq("status", "pending_payment")
    .select("id")
    .maybeSingle();

  if (updateError) {
    if (link) await revokeVipInvite(groupId, link);
    throw new Error("Ошибка обновления подписки: " + updateError.message);
  }

  if (!updated) {
    if (link) await revokeVipInvite(groupId, link);
    throw new Error("Заявка уже обработана другим администратором");
  }

  // Close other actives + revoke their invites (user stays in group under new period)
  await expireOtherActivesAndRevokeInvites(s, sub.telegram_id as number, id, groupId);

  const welcomeMsg = escapeHtml(settings.vip_welcome_message || "Ваша VIP подписка активна!");
  const until = escapeHtml(formatDateTimeRu(expiresAt));

  if (!needsInvite) {
    await tgVip("sendMessage", {
      chat_id: sub.telegram_id,
      text:
        `✅ ${welcomeMsg}\n\n` +
        `Доступ продлён до: <b>${until}</b>\n\n` +
        `Вы остаётесь в VIP-группе — новая ссылка не нужна.`,
      parse_mode: "HTML",
    });
  } else if (isStackedRenewal) {
    await tgVip("sendMessage", {
      chat_id: sub.telegram_id,
      text:
        `✅ ${welcomeMsg}\n\n` +
        `Доступ продлён до: <b>${until}</b>\n\n` +
        `Вас нет в группе — одноразовая ссылка для возврата:\n${link}`,
      parse_mode: "HTML",
    });
  } else {
    await tgVip("sendMessage", {
      chat_id: sub.telegram_id,
      text:
        `✅ ${welcomeMsg}\n\n` +
        `Срок действия до: <b>${until}</b>\n\n` +
        `Ваша персональная одноразовая ссылка для вступления:\n${link}`,
      parse_mode: "HTML",
    });
  }

  if (tariff?.is_public === false && !tariff?.is_entry) {
    await assignMemberTariff(
      s,
      sub.telegram_id as number,
      {
        username: sub.username as string | null,
        first_name: sub.first_name as string | null,
        last_name: sub.last_name as string | null,
      },
      tariff.id,
      "payment",
    );
  }

  console.log("[confirmVipSubscription] COMPLETE - Confirmation successful");
  return { ok: true as const };
}

export const getVipMemberProfiles = createServerFn({ method: "GET" }).handler(async () => {
  await requireAdmin();
  try {
    const s = await db();
    const { data, error } = await s
      .from("vip_member_profiles")
      .select("telegram_id, assigned_tariff_id, assigned_at, assigned_source, vip_tariffs(name, price, currency, is_public)")
      .order("assigned_at", { ascending: false });
    if (error) {
      console.error("[getVipMemberProfiles]", error.message);
      return [];
    }
    return data ?? [];
  } catch (e) {
    console.error("[getVipMemberProfiles] exception", e);
    return [];
  }
});

export const runVipCronNow = createServerFn({ method: "POST" }).handler(async () => {
  await requireAdmin();
  const { runVipCronJob } = await import("./vip-cron.server");
  return await runVipCronJob();
});

export const confirmVipSubscription = createServerFn({ method: "POST" })
  .validator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    await requireAdmin();
    await requireVip();
    return await activateVipSubscription(data.id);
  });

/** Shared reject: Telegram callbacks and admin panel. Notifies user only if row was updated. */
export async function rejectVipSubscriptionCore(id: string): Promise<{ ok: true; alreadyProcessed?: boolean }> {
  await requireVip();
  const s = await db();

  const { data: sub, error: fetchError } = await s
    .from("vip_subscriptions")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (fetchError) throw new Error(fetchError.message);
  if (!sub) throw new Error("Подписка не найдена");
  if (sub.status !== "pending_payment") {
    return { ok: true, alreadyProcessed: true };
  }

  const { data: settingsData } = await s.from("app_settings").select("*");
  const settings: Record<string, string> = {};
  for (const r of settingsData ?? []) settings[r.key as string] = (r.value as string) ?? "";
  const groupId = settings.vip_group_id;

  if (groupId && sub.group_invite_link) {
    await revokeVipInvite(groupId, sub.group_invite_link as string);
  }

  const { data: updated, error } = await s
    .from("vip_subscriptions")
    .update({ status: "cancelled" })
    .eq("id", id)
    .eq("status", "pending_payment")
    .select("telegram_id")
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!updated) {
    return { ok: true, alreadyProcessed: true };
  }

  // Одна «отклонённая» на человека — старые cancelled не копятся в админке
  await s
    .from("vip_subscriptions")
    .delete()
    .eq("telegram_id", updated.telegram_id)
    .eq("status", "cancelled")
    .neq("id", id);

  await tgVip("sendMessage", {
    chat_id: updated.telegram_id,
    text: "❌ Ваша оплата была отклонена. Если это ошибка, свяжитесь с поддержкой.",
  });

  return { ok: true };
}

export const rejectVipSubscription = createServerFn({ method: "POST" })
  .validator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    await requireAdmin();
    await requireVip();
    return await rejectVipSubscriptionCore(data.id);
  });

const AddManualInput = z.object({
  telegram_id: z
    .string()
    .min(1)
    .regex(/^\d{5,15}$/, "Telegram ID должен быть числом"),
  tariff_id: z.string().uuid(),
  days: z.number().min(1).optional(),
  status: z.string(),
});

export const addVipSubscriptionManual = createServerFn({ method: "POST" })
  .validator((d: unknown) => AddManualInput.parse(d))
  .handler(async ({ data }) => {
    await requireAdmin();
    await requireVip();
    const s = await db();

    const { data: settingsData } = await s.from("app_settings").select("*");
    const settings: Record<string, string> = {};
    for (const r of settingsData ?? []) settings[r.key as string] = (r.value as string) ?? "";
    const isTest = settings.vip_test_mode === "true";
    const groupId = (settings.vip_group_id || "").trim();

    const { data: tariff } = await s
      .from("vip_tariffs")
      .select("duration_days, duration_minutes, is_public, is_entry")
      .eq("id", data.tariff_id)
      .maybeSingle();

    const telegramId = parseInt(data.telegram_id, 10);
    if (!Number.isFinite(telegramId)) throw new Error("Некорректный Telegram ID");

    const now = new Date();
    const expiresAt = new Date(now);
    if (isTest) {
      const mins = tariff?.duration_minutes ?? 5;
      expiresAt.setMinutes(expiresAt.getMinutes() + mins);
    } else {
      const days = data.days ?? tariff?.duration_days ?? 30;
      expiresAt.setDate(expiresAt.getDate() + days);
    }

    let userFields: MemberUserFields = {};
    let memberWarning: string | undefined;

    if (groupId) {
      const { fetchVipChatMember } = await import("./vip-group-members.server");
      const member = await fetchVipChatMember(groupId, telegramId);
      if (member?.user) {
        userFields = {
          username: member.user.username ?? null,
          first_name: member.user.first_name ?? null,
          last_name: member.user.last_name ?? null,
        };
      } else {
        memberWarning =
          "Пользователь не найден в VIP-группе через Telegram API. Подписка создана — при активном статусе будет отправлена ссылка (если пользователь писал боту).";
      }
    }

    const { data: inserted, error } = await s
      .from("vip_subscriptions")
      .insert({
        bot_id: await tenantBotId(),
        telegram_id: telegramId,
        username: userFields.username ?? null,
        first_name: userFields.first_name ?? null,
        last_name: userFields.last_name ?? null,
        tariff_id: data.tariff_id,
        started_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
        status: data.status,
        imported: true,
      })
      .select("id")
      .single();

    if (error) throw new Error(error.message);

    // Avoid duplicate concurrent actives for the same user
    if (data.status === "active" && inserted?.id && groupId) {
      await expireOtherActivesAndRevokeInvites(s, telegramId, inserted.id, groupId);
    } else if (data.status === "active" && inserted?.id) {
      await s
        .from("vip_subscriptions")
        .update({ status: "expired" })
        .eq("telegram_id", telegramId)
        .eq("status", "active")
        .neq("id", inserted.id);
    }

    let accessInfo: { inGroup: boolean; inviteSent: boolean } | undefined;
    if (data.status === "active" && inserted?.id && groupId) {
      accessInfo = await grantVipAccessAfterManual(s, {
        subscriptionId: inserted.id,
        telegramId,
        expiresAt,
        groupId,
        settings,
        user: userFields,
      });
    } else if (data.status === "active" && inserted?.id && !groupId) {
      memberWarning = (memberWarning ? memberWarning + " " : "") + "VIP группа не настроена — инвайт не отправлен.";
    }

    if (tariff?.is_public === false && !tariff?.is_entry) {
      await assignMemberTariff(s, telegramId, userFields, data.tariff_id, "admin");
    }

    return {
      ok: true as const,
      warning: memberWarning,
      inGroup: accessInfo?.inGroup,
      inviteSent: accessInfo?.inviteSent,
    };
  });

const ExtendInput = z.object({
  id: z.string().uuid(),
  /** Positive = add days, negative = subtract days. Zero forbidden. */
  days: z.number().int().refine((n) => n !== 0, "days must be non-zero"),
});

export const extendVipSubscription = createServerFn({ method: "POST" })
  .validator((d: unknown) => ExtendInput.parse(d))
  .handler(async ({ data }) => {
    await requireAdmin();
    await requireVip();
    const s = await db();
    const { data: sub } = await s.from("vip_subscriptions").select("*").eq("id", data.id).single();
    if (!sub) throw new Error("Not found");

    const { data: settingsData } = await s.from("app_settings").select("*");
    const settings: Record<string, string> = {};
    for (const r of settingsData ?? []) settings[r.key as string] = (r.value as string) ?? "";
    const groupId = (settings.vip_group_id || "").trim();

    const pastDue =
      sub.status === "active" &&
      new Date(sub.expires_at as string).getTime() <= Date.now();
    const wasInactive = sub.status !== "active" || pastDue;

    if (data.days < 0 && wasInactive) {
      throw new Error("Нельзя уменьшить истёкшую подписку. Сначала продлите (+дни) или создайте новую.");
    }

    const base = wasInactive ? new Date() : new Date(sub.expires_at as string);
    const baseSafe = base.getTime() < Date.now() && data.days > 0 ? new Date() : new Date(base);
    baseSafe.setDate(baseSafe.getDate() + data.days);

    const shortenedPast = data.days < 0 && baseSafe.getTime() <= Date.now();
    let inviteLink = sub.group_invite_link as string | null;

    // Shrink past now → expire this subscription (+ kick if no other active remains)
    if (shortenedPast) {
      if (inviteLink && groupId) {
        await revokeVipInvite(groupId, inviteLink);
        inviteLink = null;
      }
      const { error } = await s
        .from("vip_subscriptions")
        .update({
          expires_at: baseSafe.toISOString(),
          status: "expired",
          admin_note: "admin_shortened",
          group_invite_link: null,
        })
        .eq("id", data.id);
      if (error) throw new Error(error.message);

      const { data: otherActive } = await s
        .from("vip_subscriptions")
        .select("id")
        .eq("telegram_id", sub.telegram_id)
        .eq("status", "active")
        .gt("expires_at", new Date().toISOString())
        .limit(1)
        .maybeSingle();

      if (!otherActive && groupId) {
        const ban = await tgVip("banChatMember", {
          chat_id: groupId,
          user_id: sub.telegram_id,
          revoke_messages: false,
        });
        if (ban.ok || isAlreadyNotInChat(ban.description)) {
          await tgVip("unbanChatMember", {
            chat_id: groupId,
            user_id: sub.telegram_id,
            only_if_banned: true,
          });
        }
      }

      await tgVip("sendMessage", {
        chat_id: sub.telegram_id,
        text:
          `ℹ️ Срок VIP изменён администратором.\n\n` +
          `Подписка завершена <b>${escapeHtml(formatDateTimeRu(baseSafe))}</b>.` +
          (!otherActive ? `\nДоступ к группе закрыт.` : ""),
        parse_mode: "HTML",
      });
      return { ok: true as const, expired: true as const };
    }

    // Re-issue invite if user was expired/cancelled AND not currently in the group
    if (wasInactive && groupId) {
      const inGroup = await isVipGroupMember(groupId, sub.telegram_id as number);
      if (inGroup) {
        if (inviteLink) await revokeVipInvite(groupId, inviteLink);
        inviteLink = null;
        await tgVip("sendMessage", {
          chat_id: sub.telegram_id,
          text:
            `✅ Подписка продлена до <b>${escapeHtml(formatDateTimeRu(baseSafe))}</b>\n\n` +
            `Вы уже в VIP-группе — новая ссылка не нужна.`,
          parse_mode: "HTML",
        });
      } else {
        await revokeVipInvite(groupId, inviteLink);
        const invite = await tgVip("createChatInviteLink", {
          chat_id: groupId,
          member_limit: 1,
          name: `vip-ext-${data.id.slice(0, 8)}`,
          expire_date: Math.floor(baseSafe.getTime() / 1000),
        });
        if (!invite.ok) {
          throw new Error("Не удалось создать ссылку-приглашение. Убедитесь что бот админ в группе.");
        }
        inviteLink = (invite.result as any).invite_link;

        await tgVip("sendMessage", {
          chat_id: sub.telegram_id,
          text:
            `✅ Подписка продлена до <b>${escapeHtml(formatDateTimeRu(baseSafe))}</b>\n\n` +
            `Одноразовая ссылка для вступления:\n${inviteLink}`,
          parse_mode: "HTML",
        });
      }
    } else {
      const verb = data.days > 0 ? "продлена" : "изменена";
      await tgVip("sendMessage", {
        chat_id: sub.telegram_id,
        text: `✅ Ваша VIP подписка ${verb} до <b>${escapeHtml(formatDateTimeRu(baseSafe))}</b>.`,
        parse_mode: "HTML",
      });
    }

    const { error } = await s
      .from("vip_subscriptions")
      .update({
        expires_at: baseSafe.toISOString(),
        status: "active",
        admin_note: null,
        group_invite_link: inviteLink,
      })
      .eq("id", data.id);

    if (error) throw new Error(error.message);
    return { ok: true as const, expired: false as const };
  });

const DeleteInput = z.object({ id: z.string().uuid() });

/** Kick from VIP group + expire access. Keeps history (status → expired). */
export const excludeVipFromCommunity = createServerFn({ method: "POST" })
  .validator((d: unknown) => DeleteInput.parse(d))
  .handler(async ({ data }) => {
    await requireAdmin();
    await requireVip();
    const s = await db();

    const { data: sub } = await s.from("vip_subscriptions").select("*").eq("id", data.id).maybeSingle();
    if (!sub) throw new Error("Подписка не найдена");

    const telegramId = sub.telegram_id as number;

    const { data: settingsData } = await s.from("app_settings").select("*");
    const settings: Record<string, string> = {};
    for (const r of settingsData ?? []) settings[r.key as string] = (r.value as string) ?? "";
    const groupId = (settings.vip_group_id || "").trim();
    if (!groupId) throw new Error("vip_group_id не настроен в /admin/vip/settings");

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
    if (!ban.ok && !isAlreadyNotInChat(ban.description)) {
      throw new Error(ban.description || "Не удалось исключить из группы (бот админ? право ban users?)");
    }
    await tgVip("unbanChatMember", {
      chat_id: groupId,
      user_id: telegramId,
      only_if_banned: true,
    });

    await s
      .from("vip_subscriptions")
      .update({ status: "expired", group_invite_link: null, admin_note: "admin_excluded" })
      .eq("telegram_id", telegramId)
      .eq("status", "active");

    await s
      .from("vip_subscriptions")
      .update({ status: "cancelled", group_invite_link: null })
      .eq("telegram_id", telegramId)
      .eq("status", "pending_payment");

    await tgVip("sendMessage", {
      chat_id: telegramId,
      text:
        `❌ <b>Доступ к VIP-сообществу отозван администратором.</b>\n\n` +
        `Вы исключены из группы. Чтобы вернуться — оформите подписку заново в боте.`,
      parse_mode: "HTML",
    });

    return { ok: true };
  });

export const deleteVipSubscription = createServerFn({ method: "POST" })
  .validator((d: unknown) => DeleteInput.parse(d))
  .handler(async ({ data }) => {
    await requireAdmin();
    await requireVip();
    const s = await db();
    const { data: sub } = await s.from("vip_subscriptions").select("*").eq("id", data.id).maybeSingle();
    if (!sub) throw new Error("Not found");

    const { data: settingsData } = await s.from("app_settings").select("*");
    const settings: Record<string, string> = {};
    for (const r of settingsData ?? []) settings[r.key as string] = (r.value as string) ?? "";
    const groupId = settings.vip_group_id;

    if (groupId && sub.group_invite_link) {
      await revokeVipInvite(groupId, sub.group_invite_link as string);
    }

    // Kick only if this was an active sub and no other valid active remains
    if (groupId && sub.status === "active") {
      const { count: otherActive } = await s
        .from("vip_subscriptions")
        .select("*", { count: "exact", head: true })
        .eq("telegram_id", sub.telegram_id)
        .eq("status", "active")
        .gt("expires_at", new Date().toISOString())
        .neq("id", data.id);

      if ((otherActive ?? 0) === 0) {
        const ban = await tgVip("banChatMember", {
          chat_id: groupId,
          user_id: sub.telegram_id,
          revoke_messages: false,
        });
        if (ban.ok || isAlreadyNotInChat(ban.description)) {
          await tgVip("unbanChatMember", {
            chat_id: groupId,
            user_id: sub.telegram_id,
            only_if_banned: true,
          });
        }
      }
    }

    const { error } = await s.from("vip_subscriptions").delete().eq("id", data.id);
    if (error) throw new Error(error.message);

    // If no subscriptions left for this user — forget personal tariff / "already was in VIP"
    const { count: remaining } = await s
      .from("vip_subscriptions")
      .select("*", { count: "exact", head: true })
      .eq("telegram_id", sub.telegram_id);

    if ((remaining ?? 0) === 0) {
      await s.from("vip_member_profiles").delete().eq("telegram_id", sub.telegram_id);
    }

    return { ok: true, forgotProfile: (remaining ?? 0) === 0 };
  });
