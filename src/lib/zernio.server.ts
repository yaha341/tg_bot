/**
 * Zernio API Client for Instagram & Multi-channel Integration
 */
import type { Json } from "@/integrations-supabase/types";

function getZernioKey(): string {
  const key = process.env.ZERNIO_API_KEY?.trim();
  if (!key) {
    throw new Error("ZERNIO_API_KEY environment variable is not configured");
  }
  return key;
}

function getZernioBaseUrl(): string {
  return (process.env.ZERNIO_BASE_URL || "https://zernio.com/api/v1").replace(/\/$/, "");
}

export type ZernioProfile = {
  _id: string;
  name: string;
  description?: string;
};

export type ZernioAccount = {
  _id: string;
  platform: string;
  name?: string;
  username?: string;
  // Zernio отдаёт ссылку на профиль либо строкой-идентификатором, либо уже
  // развёрнутым объектом — зависит от эндпоинта. Форма в admin.instagram.tsx
  // разбирает оба случая, и тип должен описывать то же самое.
  profileId?: string | { _id: string };
  isExpired?: boolean;
  // Json, а не Record<string, unknown>: тип уезжает на клиент через
  // getInstagramAccountsFn, а `unknown` в TanStack Start не проходит проверку
  // сериализуемости — это ведь просто разобранный ответ Zernio, то есть JSON.
  metadata?: Record<string, Json>;
};

export type ZernioAccountHealth = {
  accountId: string;
  status: "healthy" | "warning" | "error";
  tokenStatus?: { valid?: boolean; expiresAt?: string; expiresIn?: string; needsRefresh?: boolean };
  permissions?: { canPost?: boolean; canFetchAnalytics?: boolean; missingRequired?: string[] };
  issues?: string[];
  recommendations?: string[];
};

export type ZernioConversation = {
  id: string;
  accountId: string;
  participantName?: string;
  participantUsername?: string;
  participantPicture?: string | null;
  lastMessage?: string;
  updatedTime?: string;
  unreadCount?: number | null;
  status?: "active" | "archived";
};

export type ZernioInboxMessage = {
  id: string;
  message?: string;
  direction?: "incoming" | "outgoing";
  createdAt?: string;
  attachments?: Array<{ id: string; type: string; url: string; filename?: string | null; previewUrl?: string | null }>;
};

export type ZernioDmButton = {
  type: "url" | "postback" | "phone";
  title: string;
  url?: string;
  payload?: string;
  phone?: string;
};

/** A normal Direct reply must not carry an out-of-window message tag. */
export function buildInstagramInboxMessageBody(accountId: string, message: string): Record<string, string> {
  return { accountId, message };
}

export type ZernioCommentAutomation = {
  id?: string;
  _id?: string;
  name: string;
  platform?: "instagram" | "facebook";
  trigger?: "comment" | "story_reply";
  accountId: string;
  profileId?: string;
  // null — «все посты», а не «значение не задано»: именно его кладёт сюда
  // разбор постов ниже (`… || null`) и валидатор формы в instagram.functions.ts
  // (`.optional().nullable()`). Тип обязан это допускать.
  platformPostId?: string | null;
  postId?: string | null;
  postTitle?: string;
  keywords: string[];
  replyToAll?: boolean;
  matchMode?: "exact" | "contains";
  dmMessage: string;
  buttons?: ZernioDmButton[];
  commentReply?: string;
  dmMessageVariations?: string[];
  commentReplyVariations?: string[];
  linkTracking?: boolean;
  clickTag?: string;
  isActive?: boolean;
  stats?: {
    triggered?: number;
    dmsSent?: number;
    dmsFailed?: number;
    uniqueContacts?: number;
    linkClicks?: number;
    read?: number;
  };
};

/**
 * Полезная нагрузка `message.received` — по документации Zernio и по факту.
 *
 * Прежний вариант этого типа описывал объект `data` с плоскими полями
 * (`senderId`, `senderUsername`, `commentText`…). Такого поля Zernio не
 * присылает вовсе: в 26 865 сохранённых событиях `data` не встречается ни
 * разу. Тип был выдумкой, и написанный по нему разбор молча читал undefined.
 */
export type ZernioWebhookMessagePayload = {
  /** Стабильный идентификатор события — он же ключ дедупликации. */
  id?: string;
  event: "message.received" | string;
  message?: {
    id?: string;
    conversationId?: string;
    platform?: string;
    platformMessageId?: string;
    direction?: "incoming" | "outgoing";
    /** Может быть null: у сообщения бывает одно вложение без текста. */
    text?: string | null;
    attachments?: Array<{ type: string; url: string; payload?: Record<string, Json> }>;
    sender?: {
      id?: string;
      /** Идентификатор карточки контакта в CRM самого Zernio. */
      contactId?: string;
      name?: string;
      username?: string;
      picture?: string;
      instagramProfile?: {
        isFollower?: boolean | null;
        isFollowing?: boolean | null;
        followerCount?: number | null;
        isVerified?: boolean | null;
      };
    };
    /** Приходит при нажатии кнопки в DM: тип и идентификатор нажатого. */
    metadata?: { interactiveType?: string; interactiveId?: string };
    sentAt?: string;
    isRead?: boolean;
  };
  conversation?: {
    id?: string;
    participantId?: string;
    participantName?: string;
    participantUsername?: string;
    participantPicture?: string | null;
  };
  account?: {
    id?: string;
    /** Тот же идентификатор, что и `id`; каноническое поле для фильтрации. */
    accountId?: string;
    platform?: string;
    username?: string;
  };
  timestamp?: string;
};

async function zernioRequest<T>(
  endpoint: string,
  options: {
    method?: string;
    body?: unknown;
    query?: Record<string, string>;
    /**
     * Значение заголовка `Idempotency-Key`. Zernio хранит ключ сутки: тот же
     * ключ с тем же телом возвращает исходный ответ вместо повторного действия,
     * тот же ключ с другим телом — 422, ключ ещё в работе — 409.
     */
    idempotencyKey?: string;
  } = {},
): Promise<T> {
  const apiKey = getZernioKey();
  const baseUrl = getZernioBaseUrl();

  let url = `${baseUrl}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;

  if (options.query) {
    const params = new URLSearchParams(options.query);
    url += `?${params.toString()}`;
  }

  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`[zernio] API request error ${response.status} on ${endpoint}:`, text);
    throw new Error(`Zernio API Error ${response.status}: ${text}`);
  }

  return (await response.json()) as T;
}

/**
 * Получить список профилей Zernio или создать дефолтный профиль магазина.
 */
export async function ensureDefaultZernioProfile(): Promise<ZernioProfile> {
  const envProfileId = process.env.ZERNIO_PROFILE_ID?.trim();
  
  try {
    const listRes = await zernioRequest<{ profiles: ZernioProfile[] }>("/profiles");
    
    // If ZERNIO_PROFILE_ID is set, try to find that specific profile
    if (envProfileId) {
      const found = listRes.profiles?.find(p => p._id === envProfileId);
      if (found) return found;
      console.warn(`[zernio] Profile ${envProfileId} not found in account, falling back to first available or create`);
    }

    if (listRes.profiles && listRes.profiles.length > 0) {
      return listRes.profiles[0];
    }
  } catch (e) {
    console.warn("[zernio] failed to list profiles, attempting create...", e);
  }

  const createRes = await zernioRequest<{ profile: ZernioProfile }>("/profiles", {
    method: "POST",
    body: {
      name: "Store Main Profile",
      description: "Default profile for Instagram Bot Store",
    },
  });

  return createRes.profile;
}

/**
 * Сгенерировать официальную ссылку авторизации Zernio OAuth (Connect Link) для Instagram.
 */
export async function getZernioConnectUrl(
  platform = "instagram",
  profileId?: string,
  redirectUrl?: string,
): Promise<{ authUrl: string }> {
  let targetProfileId = profileId;
  if (!targetProfileId) {
    const defaultProfile = await ensureDefaultZernioProfile();
    targetProfileId = defaultProfile._id;
  }

  const query: Record<string, string> = { profileId: targetProfileId };
  if (redirectUrl) {
    query.redirect_url = redirectUrl;
  }

  const res = await zernioRequest<{ authUrl: string }>(`/connect/${platform}`, {
    query,
  });

  return res;
}

/**
 * Получить список привязанных соц. аккаунтов.
 */
export async function listZernioAccounts(profileId?: string): Promise<ZernioAccount[]> {
  try {
    const query: Record<string, string> = {};
    const targetProfileId = profileId || process.env.ZERNIO_PROFILE_ID?.trim();
    if (targetProfileId) query.profileId = targetProfileId;
    const res = await zernioRequest<{ accounts: ZernioAccount[] }>("/accounts", { query });
    return res.accounts || [];
  } catch (e) {
    console.error("[zernio] listZernioAccounts error", e);
    return [];
  }
}

/**
 * Отправить личное сообщение в Instagram Direct (Zernio Inbox API).
 */
export async function sendZernioInboxMessage(
  conversationId: string,
  accountId: string,
  message: string,
  attachmentUrl?: string,
  attachmentType?: "image" | "video" | "audio" | "file",
  buttons?: ZernioDmButton[],
): Promise<{ ok: boolean; error?: string }> {
  try {
    const body: Record<string, unknown> = buildInstagramInboxMessageBody(accountId, message);

    if (attachmentUrl) {
      body.attachmentUrl = attachmentUrl;
      body.attachmentType = attachmentType || "image";
    }
    /**
     * Кнопки — только те, что просил вызывающий.
     *
     * Здесь стояла догадка: если в тексте есть слово «корзина», подставить кнопку
     * «Оформить заказ». На живой проверке это выстрелило ровно так, как и должно
     * было: на «/start» бот ответил «Отменил, корзина пуста» — и приклеил к
     * отмене кнопку оформления. Человек нажал её при пустой корзине и уехал в
     * тупик, а выглядело это как предложение оформить то, что только что
     * отменили.
     *
     * Кнопку под ответом с корзиной ставит sendCart и добавление товара — там,
     * где оформлять действительно есть что.
     */
    if (buttons?.length) {
      body.buttons = buttons.slice(0, 3);
    }

    // Внутри обработки вебхука повтор доставки не должен обернуться вторым
    // сообщением у клиента — Zernio по этому ключу вернёт исходный ответ.
    const { idempotencyKeyFor } = await import("./zernio-event-context.server");

    await zernioRequest(`/inbox/conversations/${conversationId}/messages`, {
      method: "POST",
      body,
      idempotencyKey: idempotencyKeyFor(body),
    });
    return { ok: true };
  } catch (e) {
    console.error(`[zernio] sendZernioInboxMessage failed for conversation ${conversationId}`, e);
    const details = e instanceof Error ? e.message : "";
    const error = /inbox add-on required/i.test(details)
      ? "Для этого аккаунта недоступна отправка в Direct. Проверьте права подключения и тариф сервиса."
      : "Не удалось отправить сообщение. Проверьте подключение Instagram и повторите попытку.";
    return { ok: false, error };
  }
}

/**
 * Кеш состава профиля на минуту.
 *
 * Проверка ниже стоит на горячем пути вебхука: она выполняется до того, как мы
 * ответим Zernio, а у Zernio на ответ ровно 5 секунд — дальше доставка
 * считается неуспешной и уходит в повтор. Без кеша каждое входящее событие
 * тянуло за собой исходящий запрос `GET /accounts` к тому же Zernio, то есть на
 * ~1670 событиях в сутки столько же лишних round-trip'ов внутри этого бюджета.
 *
 * Состав профиля меняется редко (подключили или отключили аккаунт), так что
 * минута расхождения безобидна: свежеподключённый аккаунт начнёт обслуживаться
 * не позже чем через минуту, а отключённый столько же будет считаться своим —
 * и это не дыра в изоляции, потому что чужой аккаунт в кеше не появится.
 * Ошибку и пустой ответ не кешируем: иначе разовый сбой Zernio погасил бы
 * обработку на всю минуту.
 */
const PROFILE_ACCOUNTS_TTL_MS = 60_000;
let profileAccountsCache: { at: number; profileId: string; accounts: ZernioAccount[] } | null = null;

async function accountsInProfile(profileId: string): Promise<ZernioAccount[]> {
  const cached = profileAccountsCache;
  if (cached && cached.profileId === profileId && Date.now() - cached.at < PROFILE_ACCOUNTS_TTL_MS) {
    return cached.accounts;
  }
  const accounts = await listZernioAccounts(profileId);
  if (accounts.length > 0) {
    profileAccountsCache = { at: Date.now(), profileId, accounts };
  }
  return accounts;
}

/** Сбрасывает кеш состава профиля — после подключения или отключения аккаунта. */
export function resetProfileAccountsCache() {
  profileAccountsCache = null;
}

/** Fail closed: a deployment may process only accounts in its configured profile. */
export async function isInstagramAccountInConfiguredProfile(accountId: string): Promise<boolean> {
  const profileId = process.env.ZERNIO_PROFILE_ID?.trim();
  if (!profileId || !accountId) return false;
  const accounts = await accountsInProfile(profileId);
  return accounts.some((account) => account._id === accountId && account.platform === "instagram");
}

/**
 * Ответить на комментарий под постом/Reels в Instagram.
 */
export async function replyToInstagramComment(
  postId: string,
  commentId: string,
  accountId: string,
  message: string,
): Promise<{ ok: boolean }> {
  try {
    await zernioRequest(`/inbox/comments/${postId}`, {
      method: "POST",
      body: {
        accountId,
        commentId,
        message,
      },
    });
    return { ok: true };
  } catch (e) {
    console.error(`[zernio] replyToInstagramComment failed for post ${postId}`, e);
    return { ok: false };
  }
}

/**
 * Отправить личное сообщение в DM по комментарию (Comment-to-DM Private Reply).
 * Endpoint: POST /v1/inbox/comments/{postId}/{commentId}/private-reply
 */
export async function sendInstagramPrivateReply(
  postId: string,
  commentId: string,
  accountId: string,
  message: string,
): Promise<{ ok: boolean }> {
  try {
    await zernioRequest(`/inbox/comments/${postId}/${commentId}/private-reply`, {
      method: "POST",
      body: {
        accountId,
        message,
      },
    });
    return { ok: true };
  } catch (e) {
    console.error(`[zernio] sendInstagramPrivateReply failed for comment ${commentId} on post ${postId}`, e);
    return { ok: false };
  }
}

/**
 * Зарегистрировать Webhook в Zernio на наш публичный эндпоинт.
 */
export async function registerZernioWebhook(webhookUrl: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const secret = process.env.ZERNIO_WEBHOOK_SECRET?.trim();
    if (!secret) return { ok: false, error: "Не задана переменная окружения ZERNIO_WEBHOOK_SECRET." };
    /**
     * Только то, что действительно обрабатывается — первое правило из
     * руководства Zernio по вебхукам, и здесь оно нарушалось дороже всего.
     *
     * Подписка была на десять событий при двух обработчиках, причём один из них
     * (`comment.received`) сводился к console.log: комментарии закрывают родные
     * Comment-to-DM автоматизации Zernio, наше участие там не требуется. При
     * этом на `comment.received` приходилось 19 088 событий из 26 865 — 69 % и
     * всего трафика, и таблицы логов. Каждое из них стоило вставки в базу,
     * обновления статуса и места на диске ради строчки в консоли.
     *
     * Статистика по комментариям в админке от этого не пострадала: она читается
     * из `rule.stats` в ответе Zernio (см. getInstagramDashboardFn), а не из
     * наших логов.
     *
     * `account.disconnected` не подписан намеренно — обработчика у него нет, а
     * заводить ещё один игнорируемый поток незачем. Событие полезное (истёкший
     * токен = бот молча перестаёт отвечать), и подписаться на него стоит
     * одновременно с обработчиком, а не заранее.
     */
    const events = ["message.received"];
    const current = await zernioRequest<{ webhooks?: Array<{ _id?: string; id?: string; url?: string; name?: string }> }>("/webhooks/settings");
    const existing = (current.webhooks || []).find((webhook) => webhook.url === webhookUrl || webhook.name === "Instagram Store Webhook");
    const response = await zernioRequest<{ success?: boolean; error?: string }>("/webhooks/settings", {
      method: existing ? "PUT" : "POST",
      body: {
        ...(existing ? { _id: existing._id || existing.id } : {}),
        name: "Instagram Store Webhook",
        url: webhookUrl,
        secret,
        events,
        isActive: true,
      },
    });
    if (response.success === false) return { ok: false, error: response.error || "Zernio не принял настройки webhook." };
    return { ok: true };
  } catch (e) {
    console.error("[zernio] registerZernioWebhook failed", e);
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Опубликовать Пост / Карточку в Instagram.
 */
export type CreateInstagramPostInput = {
  accountId: string;
  content: string;
  mediaUrls: string[];
  mediaType: "image" | "video";
  /** Instagram turns a single video into a Reel automatically. */
  contentType?: "story";
  scheduledFor?: string;
  firstComment?: string;
  shareToFeed?: boolean;
  collaborators?: string[];
  isAiGenerated?: boolean;
};

/** Create a Feed post, Reel, Story or carousel now or at a scheduled time. */
export async function createInstagramPost(
  input: CreateInstagramPostInput,
): Promise<{ ok: boolean; postId?: string; status?: string; scheduledFor?: string; error?: string }> {
  try {
    const platformSpecificData: Record<string, unknown> = {};
    if (input.contentType === "story") platformSpecificData.contentType = "story";
    if (input.mediaType === "video") platformSpecificData.shareToFeed = input.shareToFeed ?? true;
    if (input.collaborators?.length) platformSpecificData.collaborators = input.collaborators;
    if (input.isAiGenerated) platformSpecificData.isAiGenerated = true;
    if (input.firstComment?.trim()) platformSpecificData.firstComment = input.firstComment.trim();

    const body: Record<string, unknown> = {
      content: input.content,
      mediaItems: input.mediaUrls.map((url) => ({ type: input.mediaType, url })),
      platforms: [
        {
          platform: "instagram",
          accountId: input.accountId,
          ...(Object.keys(platformSpecificData).length ? { platformSpecificData } : {}),
        },
      ],
    };
    if (input.scheduledFor) {
      body.scheduledFor = input.scheduledFor;
    } else {
      body.publishNow = true;
    }

    const res = await zernioRequest<{ post: { _id: string; status?: string; scheduledFor?: string } }>("/posts", {
      method: "POST",
      body,
    });

    return {
      ok: true,
      postId: res.post?._id,
      status: res.post?.status,
      scheduledFor: res.post?.scheduledFor,
    };
  } catch (e) {
    console.error("[zernio] createInstagramPost failed", e);
    return { ok: false, error: (e as Error).message };
  }
}

/** Check the token, permissions and publishing capability of one connected account. */
export async function getZernioAccountHealth(accountId: string): Promise<ZernioAccountHealth | null> {
  try {
    return await zernioRequest<ZernioAccountHealth>(`/accounts/${encodeURIComponent(accountId)}/health`);
  } catch (e) {
    console.error("[zernio] getZernioAccountHealth error", e);
    return null;
  }
}

export async function listZernioConversations(accountId: string): Promise<ZernioConversation[]> {
  try {
    const result = await zernioRequest<{ data?: ZernioConversation[] }>("/inbox/conversations", {
      query: { platform: "instagram", accountId, sortOrder: "desc", limit: "50" },
    });
    return result.data || [];
  } catch (e) {
    console.error("[zernio] listZernioConversations error", e);
    return [];
  }
}

export async function listZernioConversationMessages(accountId: string, conversationId: string): Promise<ZernioInboxMessage[]> {
  try {
    const result = await zernioRequest<{ messages?: ZernioInboxMessage[] }>(`/inbox/conversations/${encodeURIComponent(conversationId)}/messages`, {
      query: { accountId, limit: "100", sortOrder: "asc" },
    });
    return result.messages || [];
  } catch (e) {
    console.error("[zernio] listZernioConversationMessages error", e);
    return [];
  }
}

/**
 * Отключить (удалить) аккаунт Instagram из Zernio.
 */
/** Cancel a draft or scheduled post. Published posts are intentionally not deleted. */
export async function deleteZernioPost(postId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await zernioRequest(`/posts/${encodeURIComponent(postId)}`, { method: "DELETE" });
    return { ok: true };
  } catch (e) {
    console.error("[zernio] deleteZernioPost failed", e);
    return { ok: false, error: (e as Error).message };
  }
}

/** Retry a failed post immediately. Zernio keeps the original content and media. */
export async function retryZernioPost(postId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await zernioRequest(`/posts/${encodeURIComponent(postId)}`, {
      method: "PUT",
      body: { publishNow: true, isDraft: false },
    });
    return { ok: true };
  } catch (e) {
    console.error("[zernio] retryZernioPost failed", e);
    return { ok: false, error: (e as Error).message };
  }
}

export async function disconnectZernioAccount(accountId: string): Promise<{ ok: boolean }> {
  try {
    await zernioRequest(`/accounts/${accountId}`, {
      method: "DELETE",
    });
    return { ok: true };
  } catch (e) {
    console.error("[zernio] disconnectZernioAccount error", e);
    return { ok: false };
  }
}

/**
 * Получить список Comment-to-DM автоматизаций
 */
export async function listCommentAutomations(profileId?: string): Promise<{ automations: any[] }> {
  try {
    const query: Record<string, string> = {};
    const targetProfileId = profileId || process.env.ZERNIO_PROFILE_ID?.trim();
    if (targetProfileId) query.profileId = targetProfileId;
    const res = await zernioRequest<{ automations: any[] }>("/comment-automations", { query });
    return res;
  } catch (e) {
    console.error("[zernio] listCommentAutomations error", e);
    return { automations: [] };
  }
}

/** Предел длины текста DM: с кнопками это button_template, и он строже. */
const DM_LIMIT_WITH_BUTTONS = 640;
const DM_LIMIT_PLAIN = 1000;

/**
 * Готовит тело запроса к автоматизации так, как его описывает документация.
 *
 * Две вещи, которые нельзя оставить вызывающему коду.
 *
 * Во-первых, пустые поля надо **опускать, а не слать null**. Для автоматизации
 * «на все посты» доки прямо говорят: omit `platformPostId` и `postId`. Форма же
 * отдаёт явный null (валидатор описан как `.optional().nullable()`), и такой
 * null уходил в Zernio как значение.
 *
 * Во-вторых, длина текста DM ограничена, причём по-разному: с кнопками
 * сообщение превращается в button_template и обязано уложиться в 640 символов,
 * без них предел около 1000. Без проверки Zernio отвечает 400 уже после того,
 * как оператор нажал «Сохранить», и видит он сырую английскую ошибку.
 */
export function buildAutomationBody(data: Partial<ZernioCommentAutomation>): Record<string, unknown> {
  /**
   * Пропускаем null и undefined — именно ими форма обозначает «поле не
   * заполнено», и именно их доки велят опускать. Пустую строку, наоборот,
   * оставляем: при редактировании ею оператор стирает публичный ответ или
   * метку клика, и если её проглотить, Zernio сохранит прежнее значение —
   * поле будет невозможно очистить. Пустой массив ключевых слов тоже
   * значащий: по докам это «срабатывать на любой комментарий».
   */
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) continue;
    // Идентификаторы поста пустой строкой не задают — это то же «на все посты».
    if ((key === "platformPostId" || key === "postId") && value === "") continue;
    body[key] = value;
  }

  // Ключевые слова сравниваются в нижнем регистре — иначе «Хочу» и «хочу»
  // станут разными правилами.
  if (Array.isArray(body.keywords)) {
    body.keywords = (body.keywords as string[]).map((k) => k.toLowerCase().trim()).filter(Boolean);
  }

  const dmMessage = typeof body.dmMessage === "string" ? body.dmMessage : "";
  if (!dmMessage.trim()) {
    throw new Error("Текст сообщения в Direct обязателен — без него автоматизации нечего отправить.");
  }

  const hasButtons = Array.isArray(body.buttons) && (body.buttons as unknown[]).length > 0;
  const limit = hasButtons ? DM_LIMIT_WITH_BUTTONS : DM_LIMIT_PLAIN;
  if (dmMessage.length > limit) {
    throw new Error(
      hasButtons
        ? `Сообщение в Direct — ${dmMessage.length} символов, а с кнопками помещается ${limit}. Сократите текст или уберите кнопки.`
        : `Сообщение в Direct — ${dmMessage.length} символов, предел ${limit}. Сократите текст.`,
    );
  }

  // Варианты текста ротируются вместе с основным, поэтому предел тот же.
  for (const field of ["dmMessageVariations", "commentReplyVariations"] as const) {
    const variations = body[field];
    if (!Array.isArray(variations)) continue;
    const tooLong = (variations as string[]).find((text) => text.length > limit);
    if (tooLong) {
      throw new Error(`Один из вариантов текста длиннее ${limit} символов. Сократите его.`);
    }
  }

  return body;
}

/**
 * Создать Comment-to-DM автоматизацию
 */
export async function createCommentAutomation(data: Partial<ZernioCommentAutomation>): Promise<{ ok: boolean; error?: string; automation?: ZernioCommentAutomation }> {
  try {
    const body = buildAutomationBody(data);

    const res = await zernioRequest<{ success: boolean; automation: ZernioCommentAutomation; error?: string }>("/comment-automations", {
      method: "POST",
      body,
    });
    return { ok: res.success, automation: res.automation, error: res.error };
  } catch (e: any) {
    console.error("[zernio] createCommentAutomation error", e);
    return { ok: false, error: e.message };
  }
}

/**
 * Обновить Comment-to-DM автоматизацию
 */
export async function updateCommentAutomation(automationId: string, data: Partial<ZernioCommentAutomation>): Promise<{ ok: boolean; error?: string; automation?: ZernioCommentAutomation }> {
  try {
    const body = buildAutomationBody(data);

    const res = await zernioRequest<{ success: boolean; automation: ZernioCommentAutomation; error?: string }>(`/comment-automations/${automationId}`, {
      method: "PATCH",
      body,
    });
    return { ok: res.success, automation: res.automation, error: res.error };
  } catch (e: any) {
    console.error("[zernio] updateCommentAutomation error", e);
    return { ok: false, error: e.message };
  }
}

/**
 * Удалить Comment-to-DM автоматизацию
 */
export async function deleteCommentAutomation(automationId: string): Promise<{ ok: boolean }> {
  try {
    await zernioRequest(`/comment-automations/${automationId}`, {
      method: "DELETE",
    });
    return { ok: true };
  } catch (e) {
    console.error("[zernio] deleteCommentAutomation error", e);
    return { ok: false };
  }
}

/**
 * Получить логи автоматизации
 */
export async function getCommentAutomationLogs(automationId: string): Promise<{ logs: any[] }> {
  try {
    const res = await zernioRequest<{ logs: any[] }>(`/comment-automations/${automationId}/logs`);
    return { logs: res.logs || [] };
  } catch (e) {
    console.error("[zernio] getCommentAutomationLogs error", e);
    return { logs: [] };
  }
}

/**
 * Получить список постов (для выбора Post ID в автоответах)
 */
export async function listZernioPosts(accountId: string): Promise<any[]> {
  try {
    const [analyticsResult, externalResult, zernioResult, storiesResult] = await Promise.allSettled([
      // This endpoint is the authoritative source for the native Instagram media
      // ID: platformAnalytics[].platformPostId. /posts may expose only a Zernio ID.
      zernioRequest<{ posts?: any[] }>(`/analytics`, { query: { accountId, platform: "instagram", source: "all", limit: "50" } }),
      // GET /posts?source=external only reflects Zernio's background sync, which
      // refreshes each account at most every ~90 minutes — far too slow for a
      // "just published, refresh now" flow. sync-external forces an on-demand
      // live fetch from the platform instead (debounced ~15s per account server
      // side, so calling it on every refresh click is safe).
      zernioRequest<{ posts?: any[] }>(`/posts/sync-external`, { method: "POST", body: { accountId } }),
      zernioRequest<{ posts: any[] }>(`/posts`, { query: { accountId, source: "zernio", limit: "50" } }),
      // Active stories are intentionally not returned by GET /posts.
      zernioRequest<{ stories?: any[] }>(`/accounts/${encodeURIComponent(accountId)}/instagram/stories`),
    ]);
    const analyticsRes = analyticsResult.status === "fulfilled" ? analyticsResult.value : { posts: [] };
    const externalRes = externalResult.status === "fulfilled" ? externalResult.value : { posts: [] };
    const zernioRes = zernioResult.status === "fulfilled" ? zernioResult.value : { posts: [] };
    const storiesRes = storiesResult.status === "fulfilled" ? storiesResult.value : { stories: [] };
    if (storiesResult.status === "rejected") console.warn("[zernio] unable to load active Instagram stories", storiesResult.reason);
    const analyticsPosts = (analyticsRes.posts || []).map((post: any) => {
      const platformData = Array.isArray(post.platformAnalytics)
        ? post.platformAnalytics.find((item: any) => item.accountId === accountId && item.platform === "instagram")
        : null;
      return {
        ...post,
        _zernioPostId: post.latePostId || post.postId || post._id || post.id || null,
        platformPostId: platformData?.platformPostId || post.platformPostId || null,
      };
    });
    // Analytics is authoritative and already contains the platform media ID, so
    // it's the base list. But analytics indexing can itself lag a freshly
    // synced post, so any externally-synced post analytics doesn't have yet
    // (matched by the platform's own platformPostId, not a Zernio-internal id)
    // is appended rather than dropped — that's exactly the post that was just
    // published and is why the refresh was clicked.
    const analyticsPlatformIds = new Set(analyticsPosts.map((p: any) => p.platformPostId).filter(Boolean));
    const newlySyncedExternalPosts = (externalRes.posts || []).filter(
      (p: any) => p.platformPostId && !analyticsPlatformIds.has(p.platformPostId),
    );
    const regularPosts = analyticsPosts.length > 0
      ? [...analyticsPosts, ...newlySyncedExternalPosts]
      : [...(externalRes.posts || []), ...(zernioRes.posts || [])];
    const allPosts = [...regularPosts, ...(storiesRes.stories || []).map((story) => ({ ...story, platformPostId: story.platformPostId || story.id || story._id, thumbnailUrl: story.thumbnailUrl || story.mediaUrl, publishedAt: story.timestamp, type: "story" }))];
    
    const uniquePosts: any[] = [];
    const seen = new Set();
    const seenPostFingerprints = new Set();
    
    for (const p of allPosts) {
      // A Zernio-created post has two IDs. The root ID identifies the Zernio
      // record, while platformAnalytics.platformPostId is the native Instagram
      // media ID required by Comment-to-DM targeting.
      const platformAnalytics = Array.isArray(p.platformAnalytics)
        ? p.platformAnalytics.find((item: any) => item.accountId === accountId && item.platform === "instagram")
        : null;
      const platformTarget = Array.isArray(p.platforms)
        ? p.platforms.find((item: any) => item.accountId === accountId && item.platform === "instagram")
        : null;
      p._zernioPostId = p._zernioPostId || p.latePostId || p._id || p.id || p.postId || null;
      p.platformPostId = platformAnalytics?.platformPostId || platformTarget?.platformPostId || p.platformPostId || p.metadata?.platformPostId || null;
      const id = p.platformPostId || p._zernioPostId;
      if (id && !seen.has(id)) {
        seen.add(id);
        
        // Normalize text/caption
        if (!p.caption && (p.text || p.content || p.metadata?.caption)) {
          p.caption = p.text || p.content || p.metadata?.caption;
        }
        
        // Normalize thumbnail for UI display
        // Zernio API returns: thumbnailUrl (top-level), mediaItems[].thumbnail, mediaItems[].url
        const mediaItem = Array.isArray(p.mediaItems) ? p.mediaItems[0] : null;
        p._thumbnail = p.thumbnailUrl || mediaItem?.thumbnail || mediaItem?.url || null;
        
        // Normalize date for UI display
        // `createdAt` is the time the record was created in Zernio, not when it
        // was published to Instagram, so it must never be shown as a post date.
        const rawDate = p.publishedAt || p.metadata?.publishedAt || p.metadata?.timestamp || p.timestamp ||
          platformTarget?.publishedAt || platformTarget?.published_at || p.scheduledFor || null;
        // Some Meta payloads use Unix seconds; Date expects milliseconds.
        const timestamp = typeof rawDate === "string" && /^\d+$/.test(rawDate) ? Number(rawDate) : rawDate;
        p._date = typeof timestamp === "number" && timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;

        // Zernio can return the same Instagram media from separate analytics
        // records. Their internal IDs differ, so also deduplicate by content.
        const parsedDate = p._date ? new Date(p._date) : null;
        const dateKey = parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toISOString().slice(0, 10) : "";
        const textKey = String(p.caption || p.content || "").replace(/\s+/g, " ").trim().toLowerCase();
        const mediaKey = p.platformPostUrl || p.permalink || p._thumbnail || "";
        const fingerprint = `${dateKey}|${textKey}|${mediaKey}`;
        if (fingerprint !== "||" && seenPostFingerprints.has(fingerprint)) continue;
        seenPostFingerprints.add(fingerprint);
        
        // Mark if it's a story
        p._isStory = p.type === 'story' || p.metadata?.type === 'story' || !!p.metadata?.story_id;
        
        uniquePosts.push(p);
      }
    }
    
    return uniquePosts.sort((a, b) => {
      const d1 = new Date(a._date || 0).getTime();
      const d2 = new Date(b._date || 0).getTime();
      return d2 - d1;
    });
  } catch (e) {
    console.error("[zernio] listZernioPosts error", e);
    return [];
  }
}
