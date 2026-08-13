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
  profileId?: string | { _id?: string } | null;
  isExpired?: boolean;
  metadata?: Json;
};

export type ZernioDmButton = {
  type: "url" | "postback" | "phone";
  title: string;
  url?: string;
  payload?: string;
  phone?: string;
};

export type ZernioCommentAutomation = {
  id?: string;
  _id?: string;
  name: string;
  platform?: "instagram" | "facebook";
  trigger?: "comment" | "story_reply";
  accountId: string;
  profileId?: string;
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

export type ZernioWebhookMessagePayload = {
  event: "message.received" | "comment.received" | "account.connected" | string;
  id?: string;
  data?: {
    conversationId?: string;
    accountId?: string;
    senderId?: string;
    senderUsername?: string;
    senderName?: string;
    message?: string;
    mediaUrl?: string;
    commentId?: string;
    postId?: string;
    commentText?: string;
    instagramProfile?: {
      isFollower?: boolean;
      isFollowing?: boolean;
      followerCount?: number;
      isVerified?: boolean;
    };
  };
};

async function zernioRequest<T>(
  endpoint: string,
  options: { method?: string; body?: unknown; query?: Record<string, string> } = {},
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
  attachmentType?: "image" | "video" | "audio",
): Promise<{ ok: boolean }> {
  try {
    const body: Record<string, unknown> = {
      accountId,
      message,
      messagingType: "MESSAGE_TAG",
      messageTag: "HUMAN_AGENT",
    };

    if (attachmentUrl) {
      body.attachmentUrl = attachmentUrl;
      body.attachmentType = attachmentType || "image";
    }

    await zernioRequest(`/inbox/conversations/${conversationId}/messages`, {
      method: "POST",
      body,
    });
    return { ok: true };
  } catch (e) {
    console.error(`[zernio] sendZernioInboxMessage failed for conversation ${conversationId}`, e);
    return { ok: false };
  }
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
export async function registerZernioWebhook(webhookUrl: string): Promise<{ ok: boolean }> {
  try {
    await zernioRequest("/webhooks/settings", {
      method: "POST",
      body: {
        name: "Instagram Store Webhook",
        url: webhookUrl,
        events: ["message.received", "comment.received", "account.connected"],
        isActive: true,
      },
    });
    return { ok: true };
  } catch (e) {
    console.error("[zernio] registerZernioWebhook failed", e);
    return { ok: false };
  }
}

/**
 * Опубликовать Пост / Карточку в Instagram.
 */
export async function publishZernioPost(
  accountId: string,
  content: string,
  mediaUrls: string[] = [],
): Promise<{ ok: boolean; postId?: string }> {
  try {
    const body: Record<string, unknown> = {
      content,
      publishNow: true,
      platforms: [
        {
          platform: "instagram",
          accountId,
        },
      ],
    };

    if (mediaUrls.length > 0) {
      body.media = mediaUrls.map((url) => ({ url }));
    }

    const res = await zernioRequest<{ post: { _id: string } }>("/posts", {
      method: "POST",
      body,
    });

    return { ok: true, postId: res.post?._id };
  } catch (e) {
    console.error("[zernio] publishZernioPost failed", e);
    return { ok: false };
  }
}

/**
 * Отключить (удалить) аккаунт Instagram из Zernio.
 */
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

/**
 * Создать Comment-to-DM автоматизацию
 */
export async function createCommentAutomation(data: Partial<ZernioCommentAutomation>): Promise<{ ok: boolean; automation?: ZernioCommentAutomation }> {
  try {
    const body: Record<string, any> = { ...data };

    // Ensure keywords are lowercase for better matching
    if (body.keywords) {
      body.keywords = body.keywords.map((k: string) => k.toLowerCase());
    }

    const res = await zernioRequest<{ success: boolean; automation: ZernioCommentAutomation }>("/comment-automations", {
      method: "POST",
      body,
    });
    return { ok: res.success, automation: res.automation };
  } catch (e) {
    console.error("[zernio] createCommentAutomation error", e);
    return { ok: false };
  }
}

/**
 * Обновить Comment-to-DM автоматизацию
 */
export async function updateCommentAutomation(automationId: string, data: Partial<ZernioCommentAutomation>): Promise<{ ok: boolean; automation?: ZernioCommentAutomation }> {
  try {
    const body: Record<string, any> = { ...data };
    
    if (body.keywords) {
      body.keywords = body.keywords.map((k: string) => k.toLowerCase());
    }

    const res = await zernioRequest<{ success: boolean; automation: ZernioCommentAutomation }>(`/comment-automations/${automationId}`, {
      method: "PATCH",
      body,
    });
    return { ok: res.success, automation: res.automation };
  } catch (e) {
    console.error("[zernio] updateCommentAutomation error", e);
    return { ok: false };
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
