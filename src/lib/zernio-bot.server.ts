import {
  sendZernioInboxMessage,
  replyToInstagramComment,
  sendInstagramPrivateReply,
} from "./zernio.server";
import { convertAmount } from "./currency.server";
import type { TablesUpdate } from "@/integrations-supabase/types";

async function db() {
  const { supabaseAdmin } = await import("@/integrations-supabase/client.server");
  return supabaseAdmin;
}

function appUrl(): string {
  return (
    process.env.PUBLIC_APP_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "") ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "") ||
    "https://tg-bot-ashen-one.vercel.app"
  ).replace(/\/$/, "");
}

/**
 * Создать или обновить пользователя Instagram в базе данных.
 */
export async function upsertZernioUser(
  userKey: string,
  conversationId?: string,
  accountId?: string,
  username?: string,
  firstName?: string,
  metadata?: Record<string, any>,
) {
  const s = await db();
  const { data: existing } = await s
    .from("bot_users")
    .select("*")
    .eq("user_key", userKey)
    .maybeSingle();

  if (existing) {
    const updates: TablesUpdate<"bot_users"> = {
      updated_at: new Date().toISOString(),
    };
    if (conversationId) updates.zernio_conversation_id = conversationId;
    if (accountId) updates.zernio_account_id = accountId;
    if (username) updates.username = username;
    if (firstName) updates.first_name = firstName;
    if (metadata) {
      const existingMetadata =
        existing.metadata && typeof existing.metadata === "object" && !Array.isArray(existing.metadata)
          ? (existing.metadata as Record<string, unknown>)
          : {};
      updates.metadata = { ...existingMetadata, ...metadata } as any;
    }

    await s.from("bot_users").update(updates).eq("user_key", userKey);
    return { ...existing, ...updates };
  }

  const newUser = {
    user_key: userKey,
    platform: "instagram",
    zernio_conversation_id: conversationId,
    zernio_account_id: accountId,
    username: username || null,
    first_name: firstName || "Инста-гость",
    state: {},
    metadata: metadata || {},
  };

  const { data: inserted, error } = await s.from("bot_users").insert(newUser).select().single();
  if (error) {
    console.error("[zernio-bot] error upserting user:", error);
    return newUser;
  }
  return inserted;
}

/**
 * Обработать входящее личное сообщение (DM) из Instagram Direct.
 * Соответствует спецификации Zernio Webhooks: payload.message, payload.conversation, payload.account
 */
export async function handleZernioMessage(payload: any) {
  const msgObj = payload.message || {};
  const convObj = payload.conversation || {};
  const accObj = payload.account || {};

  const conversationId = msgObj.conversationId || convObj.id;
  const accountId = accObj.accountId || accObj.id || msgObj.accountId;
  const senderObj = msgObj.sender || {};
  const senderId = senderObj.id || senderObj.username || convObj.participantId || "unknown";
  const senderUsername = senderObj.username || convObj.participantUsername || "";
  const senderName = senderObj.name || convObj.participantName || senderUsername || "друг";
  const userKey = `ig_${senderId}`;
  const text = (msgObj.text || "").trim();

  if (!conversationId || !accountId) {
    console.warn("[zernio-bot] message.received missing conversationId or accountId:", payload);
    return;
  }

  // Логируем сообщение
  console.log(`[zernio-bot] DM from ${userKey} (${senderUsername}): "${text}"`);

  // Извлекаем метаданные профиля Instagram
  const metadata = payload.data?.instagramProfile || {};
  
  // Обновляем/создаем пользователя
  const user = await upsertZernioUser(
    userKey,
    conversationId,
    accountId,
    senderUsername,
    senderName,
    metadata,
  );

  const lower = text.toLowerCase();

  // Команда /start или каталог / меню
  if (lower === "/start" || lower.includes("старт") || lower.includes("меню") || lower.includes("каталог")) {
    await sendCatalogMenu(conversationId, accountId, user);
    return;
  }

  // Команда "корзина"
  if (lower.includes("корзин")) {
    await sendCart(conversationId, accountId, userKey);
    return;
  }

  // Команда "заказы"
  if (lower.includes("заказ")) {
    await sendOrders(conversationId, accountId, userKey);
    return;
  }

  // Если пользователь отправил текстовый запрос — ищем товары
  if (text.length > 1) {
    await searchAndSendProducts(conversationId, accountId, text);
    return;
  }

  // Дефолтный приветственный ответ
  const defaultReply =
    `Здравствуйте, ${senderName}! 👋\n` +
    `Добро пожаловать в наш магазин учебных материалов.\n\n` +
    `Напишите название предмета или темы для поиска материалов, или отправьте "Каталог" для просмотра категорий.\n\n` +
    `Ссылка на наш веб-каталог: ${appUrl()}`;

  await sendZernioInboxMessage(conversationId, accountId, defaultReply);
}

/**
 * Отправить главное меню и список категорий
 */
async function sendCatalogMenu(conversationId: string, accountId: string, user: any) {
  const s = await db();
  const { data: categories } = await s
    .from("categories")
    .select("*")
    .eq("is_visible", true)
    .is("parent_id", null)
    .order("sort_order", { ascending: true })
    .limit(8);

  let msg = `📚 Каталог цифровых учебных материалов\n\n`;
  if (categories && categories.length > 0) {
    msg += `Разделы каталога:\n`;
    categories.forEach((cat: any, i: number) => {
      msg += `${i + 1}. 📁 ${cat.name}\n`;
    });
    msg += `\nНапишите название категории или тему для поиска материалов.\n`;
  } else {
    msg += `В данный момент каталог обновляется.\n`;
  }

  msg += `\nВы также можете открыть веб-версию: ${appUrl()}`;

  await sendZernioInboxMessage(conversationId, accountId, msg);
}

/**
 * Поиск и отправка товаров в DM
 */
async function searchAndSendProducts(conversationId: string, accountId: string, query: string) {
  const s = await db();

  const { data: products } = await s
    .from("products")
    .select("*, categories(name)")
    .eq("is_active", true)
    .or(`name.ilike.%${query}%,description.ilike.%${query}%,keywords.ilike.%${query}%`)
    .limit(5);

  if (!products || products.length === 0) {
    await sendZernioInboxMessage(
      conversationId,
      accountId,
      `К сожалению, по запросу "${query}" ничего не найдено.\nПопробуйте другое ключевое слово или перейдите в веб-каталог: ${appUrl()}`,
    );
    return;
  }

  let msg = `🔍 Результаты поиска по запросу "${query}":\n\n`;

  for (const p of products) {
    msg += `📌 **${p.name}**\n`;
    msg += `💰 Цена: ${p.price} ${p.currency}\n`;
    if (p.description) {
      msg += `📝 ${p.description.slice(0, 100)}...\n`;
    }
    msg += `🔗 Подробнее: ${appUrl()}\n\n`;
  }

  msg += `Для заказа перейдите в наш онлайн-магазин: ${appUrl()}`;

  await sendZernioInboxMessage(conversationId, accountId, msg);
}

/**
 * Показать корзину пользователя
 */
async function sendCart(conversationId: string, accountId: string, userKey: string) {
  const s = await db();
  const { data: items } = await s
    .from("cart_items")
    .select("*, products(*)")
    .eq("user_key", userKey);

  if (!items || items.length === 0) {
    await sendZernioInboxMessage(
      conversationId,
      accountId,
      `Ваша корзина пуста. 🛒\nВы можете выбрать товары на нашем сайте: ${appUrl()}`,
    );
    return;
  }

  let total = 0;
  let currency = "KZT";
  let msg = `🛒 Ваша корзина:\n\n`;

  items.forEach((item: any, i: number) => {
    const p = item.products;
    if (p) {
      const sum = Number(p.price) * item.quantity;
      total += sum;
      currency = p.currency;
      msg += `${i + 1}. ${p.name} (${item.quantity} шт.) — ${sum} ${p.currency}\n`;
    }
  });

  msg += `\n💵 **Итого: ${total} ${currency}**\n`;
  msg += `\nДля оформления заказа перейдите по ссылке: ${appUrl()}`;

  await sendZernioInboxMessage(conversationId, accountId, msg);
}

/**
 * Показать историю заказов
 */
async function sendOrders(conversationId: string, accountId: string, userKey: string) {
  const s = await db();
  const { data: orders } = await s
    .from("orders")
    .select("*")
    .eq("user_key", userKey)
    .order("created_at", { ascending: false })
    .limit(5);

  if (!orders || orders.length === 0) {
    await sendZernioInboxMessage(
      conversationId,
      accountId,
      `У вас пока нет заказов. 📋`,
    );
    return;
  }

  const statusMap: Record<string, string> = {
    awaiting_payment: "⏳ Ожидает оплаты",
    paid: "✅ Оплачен",
    delivered: "📦 Выдан",
    cancelled: "❌ Отменен",
  };

  let msg = `📋 Ваши заказы:\n\n`;
  orders.forEach((o: any) => {
    msg += `Заказ #${o.order_no ?? o.id} — ${o.total} ${o.currency} [${statusMap[o.status] || o.status}]\n`;
  });

  await sendZernioInboxMessage(conversationId, accountId, msg);
}

/**
 * Обработать входящий комментарий к публикации/Reels (Comment-to-DM).
 * Соответствует спецификации Zernio Webhooks: payload.comment, payload.post, payload.account
 */
export async function handleZernioComment(payload: any) {
  const commentObj = payload.comment || {};
  const commentText = (commentObj.text || commentObj.content || "").trim();
  const commentId = commentObj.id;
  
  // Zernio's native Comment-to-DM automations will automatically handle
  // matching keywords and sending DMs / Public Replies.
  // Here we just log the event for our records.
  
  console.log(`[zernio-bot] Received comment (handled by Zernio Automations): "${commentText}" (ID: ${commentId})`);
}
