import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

async function requireBlockedUsers() {
  const { requireModule } = await import("./tenant-config.server");
  await requireModule("blocked_users");
}

export const listBlockedUsersFn = createServerFn({ method: "GET" }).handler(async () => {
  const { requireAdmin } = await import("./admin-session.server");
  const { listBlockedUsers } = await import("./blocked-users.server");
  await requireAdmin();
  await requireBlockedUsers();
  return await listBlockedUsers();
});

export const blockTelegramUserFn = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z
      .object({
        telegram_id: z.union([z.string(), z.number()]),
        reason: z.string().max(500).optional(),
        username: z.string().optional(),
        first_name: z.string().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./admin-session.server");
    const { blockTelegramUser } = await import("./blocked-users.server");
    await requireAdmin();
  await requireBlockedUsers();
    const telegramId = Number(data.telegram_id);
    if (!Number.isFinite(telegramId) || telegramId <= 0) {
      throw new Error("Укажите корректный Telegram ID");
    }
    return await blockTelegramUser(telegramId, {
      reason: data.reason,
      username: data.username ?? null,
      first_name: data.first_name ?? null,
    });
  });

export const unblockTelegramUserFn = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z.object({ telegram_id: z.union([z.string(), z.number()]) }).parse(d),
  )
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./admin-session.server");
    const { unblockTelegramUser } = await import("./blocked-users.server");
    await requireAdmin();
  await requireBlockedUsers();
    const telegramId = Number(data.telegram_id);
    if (!Number.isFinite(telegramId) || telegramId <= 0) {
      throw new Error("Укажите корректный Telegram ID");
    }
    return await unblockTelegramUser(telegramId);
  });
