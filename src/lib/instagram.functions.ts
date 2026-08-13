import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

async function db() {
  const { supabaseAdmin } = await import("@/integrations-supabase/client.server");
  return supabaseAdmin;
}

async function requireInstagram() {
  const { requireModule } = await import("./tenant-config.server");
  await requireModule("instagram");
}

export const getInstagramConnectUrlFn = createServerFn({ method: "GET" }).handler(async () => {
  const { requireAdmin } = await import("./admin-session.server");
  const { getZernioConnectUrl } = await import("./zernio.server");
  await requireAdmin();
  await requireInstagram();

  const origin =
    process.env.PUBLIC_APP_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "") ||
    "https://tg-bot-ashen-one.vercel.app";

  const redirectUrl = `${origin.replace(/\/$/, "")}/admin/instagram?connected=1`;
  return await getZernioConnectUrl("instagram", undefined, redirectUrl);
});

export const getInstagramAccountsFn = createServerFn({ method: "GET" }).handler(async () => {
  const { requireAdmin } = await import("./admin-session.server");
  const { listZernioAccounts } = await import("./zernio.server");
  await requireAdmin();
  await requireInstagram();
  const accounts = await listZernioAccounts();
  return { accounts };
});

export const registerInstagramWebhookFn = createServerFn({ method: "POST" }).handler(async () => {
  const { requireAdmin } = await import("./admin-session.server");
  const { registerZernioWebhook } = await import("./zernio.server");
  await requireAdmin();
  await requireInstagram();

  const origin =
    process.env.PUBLIC_APP_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "") ||
    "https://tg-bot-ashen-one.vercel.app";

  const webhookUrl = `${origin.replace(/\/$/, "")}/api/public/zernio/webhook`;
  return await registerZernioWebhook(webhookUrl);
});

// ─── Automations via Zernio API ───────────────────────────────────────────────

/**
 * Получить список Comment-to-DM автоматизаций напрямую из Zernio
 */
export const getAutomationsFn = createServerFn({ method: "GET" }).handler(async () => {
  const { requireAdmin } = await import("./admin-session.server");
  const { listCommentAutomations } = await import("./zernio.server");
  await requireAdmin();
  await requireInstagram();
  const res = await listCommentAutomations();
  
  // Добавляем флаг replyToAll для удобства фронтенда
  if (res.automations) {
    res.automations = res.automations.map((a: any) => ({
      ...a,
      replyToAll: !a.keywords || a.keywords.length === 0
    }));
  }
  
  return res;
});

/**
 * Создать Comment-to-DM автоматизацию через Zernio API
 */
export const saveAutomationFn = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z
      .object({
        id: z.string().optional(),
        originalPlatformPostId: z.string().optional().nullable(),
        originalTrigger: z.enum(["comment", "story_reply"]).optional(),
        accountId: z.string().min(1, "Укажите accountId"),
        profileId: z.any().optional(),
        name: z.string().min(1, "Укажите название"),
        keywords: z.array(z.string()).default([]),
        replyToAll: z.boolean().optional().default(false),
        matchMode: z.enum(["exact", "contains"]).default("contains"),
        dmMessage: z.string().default(""),
        commentReply: z.string().default(""),
        trigger: z.enum(["comment", "story_reply"]).default("comment"),
        platformPostId: z.string().optional().nullable(),
        postId: z.string().optional().nullable(),
        postTitle: z.string().max(500).optional(),
        buttons: z.array(z.object({ type: z.enum(["url", "postback", "phone"]), title: z.string().min(1), url: z.string().optional(), payload: z.string().optional(), phone: z.string().optional() })).max(3).optional(),
        dmMessageVariations: z.array(z.string()).max(5).optional(),
        commentReplyVariations: z.array(z.string()).max(5).optional(),
        linkTracking: z.boolean().optional(), clickTag: z.string().max(100).optional(), isActive: z.boolean().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./admin-session.server");
    const { createCommentAutomation, deleteCommentAutomation, ensureDefaultZernioProfile, updateCommentAutomation } = await import("./zernio.server");
    await requireAdmin();
  await requireInstagram();
    if (data.platformPostId && data.platformPostId === data.accountId) {
      throw new Error("Выбран ID аккаунта вместо ID публикации. Обновите список и выберите пост заново.");
    }
    
    let profileId = typeof data.profileId === "string" ? data.profileId : "";
    if (!profileId) {
      const defaultProfile = await ensureDefaultZernioProfile();
      profileId = defaultProfile._id;
    }

    const { id: automationId, originalPlatformPostId, originalTrigger, replyToAll, ...automationData } = data;
    
    // Если включен режим "Отвечать всем", очищаем ключевые слова, 
    // но ТОЛЬКО если выбран конкретный пост. 
    // На уровне "Все посты" отвечать на всё опасно (конфликты с другими ботами).
    const isSpecificPost = !!automationData.platformPostId;
    if (replyToAll && isSpecificPost) {
      automationData.keywords = [];
    } else if (replyToAll && !isSpecificPost) {
      // Если это не конкретный пост, игнорируем флаг replyToAll и требуем ключи
      if (!automationData.keywords || automationData.keywords.length === 0) {
        throw new Error("Для автоматизации на все посты необходимо указать хотя бы одно ключевое слово.");
      }
    }

    const automation = {
      ...automationData,
      profileId,
    };
    // Zernio PATCH cannot change platformPostId, postId, or trigger. If those
    // fields are unchanged, preserve the rule and its statistics with PATCH.
    if (automationId) {
      if (originalPlatformPostId === data.platformPostId && (originalTrigger || "comment") === data.trigger) {
        return await updateCommentAutomation(automationId, automation);
      }
      // Target changed: create first. This keeps the old working rule intact
      // when Zernio rejects the new post ID or returns a validation error.
      const created = await createCommentAutomation(automation);
      if (!created.ok) return created;
      const deleted = await deleteCommentAutomation(automationId);
      if (!deleted.ok) throw new Error("Новое правило создано, но старое не удалось удалить");
      return created;
    }
    return await createCommentAutomation(automation);
  });

/**
 * Удалить автоматизацию через Zernio API
 */
export const deleteAutomationFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => z.object({ id: z.string() }).parse(d))
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./admin-session.server");
    const { deleteCommentAutomation } = await import("./zernio.server");
    await requireAdmin();
  await requireInstagram();
    return await deleteCommentAutomation(data.id);
  });

/**
 * Включить/выключить автоматизацию через Zernio API
 */
export const toggleAutomationFn = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z.object({ id: z.string(), isActive: z.boolean() }).parse(d),
  )
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./admin-session.server");
    const { updateCommentAutomation } = await import("./zernio.server");
    await requireAdmin();
  await requireInstagram();
    return await updateCommentAutomation(data.id, { isActive: data.isActive });
  });

/**
 * Получить логи конкретной автоматизации из Zernio API
 */
export const getAutomationLogsFn = createServerFn({ method: "GET" })
  .validator((d: unknown) => z.object({ id: z.string() }).parse(d))
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./admin-session.server");
    const { getCommentAutomationLogs } = await import("./zernio.server");
    await requireAdmin();
  await requireInstagram();
    return await getCommentAutomationLogs(data.id);
  });

// ─── Webhook logs (наша БД) ───────────────────────────────────────────────────

export const getInstagramLogsFn = createServerFn({ method: "GET" }).handler(async () => {
  const { requireAdmin } = await import("./admin-session.server");
  await requireAdmin();
  await requireInstagram();

  const s = await db();
  const { data, error } = await s
    .from("zernio_logs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(30);

  if (error) {
    console.error("[instagram.functions] getInstagramLogs error:", error);
    return { logs: [] };
  }

  return { logs: data || [] };
});

/**
 * Сгенерировать signed upload URL для медиа-вложения в Instagram DM
 */
export const disconnectInstagramAccountFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => z.object({ accountId: z.string() }).parse(d))
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./admin-session.server");
    const { disconnectZernioAccount } = await import("./zernio.server");
    await requireAdmin();
  await requireInstagram();
    return await disconnectZernioAccount(data.accountId);
  });

export const getZernioPostsFn = createServerFn({ method: "GET" })
  .validator((d: unknown) => z.object({ accountId: z.string() }).parse(d))
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./admin-session.server");
    const { listZernioPosts } = await import("./zernio.server");
    await requireAdmin();
  await requireInstagram();
    const posts = await listZernioPosts(data.accountId);
    return { posts };
  });
