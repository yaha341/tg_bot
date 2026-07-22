import { tg, downloadTelegramFile } from "./telegram.server";
import { convertAmount } from "./currency.server";

type BotUser = {
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  language_code: string | null;
  contact_phone: string | null;
  state: { mode?: string; pending_order_id?: number; country_code?: string; country_name?: string; last_search?: string } | null;
};

async function db() {
  const { supabaseAdmin } = await import("@/integrations-supabase/client.server");
  return supabaseAdmin;
}

function originFromState(): string {
  return (
    process.env.PUBLIC_APP_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "") ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "") ||
    "http://localhost:3000"
  ).replace(/\/$/, "");
}

function imageUrl(path: string): string {
  return `${originFromState()}/api/public/img/${path}`;
}

function formatMoney(amount: number | string, currency: string): string {
  const n = typeof amount === "number" ? amount : Number(amount);
  const value = Number.isFinite(n) ? (Number.isInteger(n) ? String(n) : n.toFixed(2)) : String(amount);
  const cur = (currency || "").toUpperCase();
  if (cur === "KZT") return `${value} ₸`;
  return `${value} ${currency}`;
}

function categoryButtonLabel(name: string): string {
  const trimmed = name.trim();
  if (/^(\p{Extended_Pictographic}|\p{Emoji_Presentation})/u.test(trimmed)) return trimmed;
  return `📁 ${trimmed}`;
}

async function upsertUser(from: {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  language_code?: string;
}): Promise<BotUser> {
  const s = await db();
  const { data } = await s
    .from("bot_users")
    .upsert(
      {
        telegram_id: from.id,
        username: from.username ?? null,
        first_name: from.first_name ?? null,
        last_name: from.last_name ?? null,
        language_code: from.language_code ?? null,
      },
      { onConflict: "telegram_id" },
    )
    .select("*")
    .single();
  return data as BotUser;
}

async function setState(telegram_id: number, state: BotUser["state"]) {
  const s = await db();
  await s.from("bot_users").update({ state: state ?? {} }).eq("telegram_id", telegram_id);
}

async function setContact(telegram_id: number, phone: string) {
  const s = await db();
  await s.from("bot_users").update({ contact_phone: phone }).eq("telegram_id", telegram_id);
}

function mainMenu() {
  return {
    keyboard: [
      [{ text: "📚 Каталог" }, { text: "🔍 Поиск" }],
      [{ text: "🛒 Корзина" }, { text: "📋 Мои заказы" }],
      [{ text: "ℹ️ Информация" }, { text: "💬 Связаться с автором" }],
    ],
    resize_keyboard: true,
  };
}

async function sendMain(chat_id: number, text = "Выберите раздел:") {
  await tg("sendMessage", { chat_id, text, reply_markup: mainMenu() });
}

async function showCategories(chat_id: number, parentId: string | null, userCountryCode?: string, offset = 0) {
  const s = await db();
  const q = s.from("categories").select("id, name").order("sort_order").order("name");
  const { data: cats } = parentId ? await q.eq("parent_id", parentId) : await q.is("parent_id", null);
  const productsQuery = s
    .from("products")
    .select("*, product_images(image_path, sort_order)")
    .eq("is_active", true)
    .order("sort_order")
    .order("name");
  const { data: products } = parentId
    ? await productsQuery.contains("category_ids", JSON.stringify([parentId]))
    : await productsQuery.eq("category_ids", "[]");

  let targetCurrency = "KZT";
  if (userCountryCode) {
    const { data: m } = await s.from("payment_methods").select("currency").eq("country_code", userCountryCode).maybeSingle();
    if (m) targetCurrency = m.currency;
  }

  if (offset === 0 && cats && cats.length > 0) {
    const catButtons: Array<Array<{ text: string; callback_data: string }>> = [];
    for (const c of cats) {
      catButtons.push([{ text: categoryButtonLabel(c.name as string), callback_data: `cat:${c.id}:0` }]);
    }
    if (parentId) {
      const { data: cur } = await s.from("categories").select("parent_id").eq("id", parentId).single();
      const back = cur?.parent_id ? `cat:${cur.parent_id}:0` : "cat:root:0";
      catButtons.push([{ text: "« Назад", callback_data: back }]);
    }
    await tg("sendMessage", {
      chat_id,
      text: parentId ? "📁 Подкатегории:" : "📚 Каталог:",
      reply_markup: { inline_keyboard: catButtons },
    });
  }

  const allProds = products ?? [];
  const page = allProds.slice(offset, offset + 5);

  if (allProds.length === 0 && (!cats || cats.length === 0)) {
    if (offset === 0) {
      const navButtons = [];
      if (parentId) {
        const { data: cur } = await s.from("categories").select("parent_id").eq("id", parentId).single();
        const back = cur?.parent_id ? `cat:${cur.parent_id}:0` : "cat:root:0";
        navButtons.push([{ text: "« Назад", callback_data: back }]);
      }
      await tg("sendMessage", { chat_id, text: "📂 Здесь пока пусто.", reply_markup: navButtons.length ? { inline_keyboard: navButtons } : undefined });
    }
    return;
  }

  for (const p of page) {
    await sendProductCard(chat_id, p, userCountryCode, s, targetCurrency);
  }

  const navButtons = [];
  if (offset + 5 < allProds.length) {
    navButtons.push([{ text: "⬇️ Показать ещё", callback_data: parentId ? `cat:${parentId}:${offset + 5}` : `cat:root:${offset + 5}` }]);
  }
  
  // Show back button at the end of products if we didn't show categories
  if (parentId && (!cats || cats.length === 0 || offset > 0)) {
    const { data: cur } = await s.from("categories").select("parent_id").eq("id", parentId).single();
    const back = cur?.parent_id ? `cat:${cur.parent_id}:0` : "cat:root:0";
    navButtons.push([{ text: "« Назад в категории", callback_data: back }]);
  }

  if (navButtons.length > 0) {
    await tg("sendMessage", { chat_id, text: "Навигация:", reply_markup: { inline_keyboard: navButtons } });
  }
}

async function sendProductCard(chat_id: number, p: any, userCountryCode: string | undefined, s: any, targetCurrency: string) {
  const imgs = (p.product_images || [])
    .slice()
    .sort((a: any, b: any) => a.sort_order - b.sort_order);

  let displayPrice = p.price;
  let displayCurrency = p.currency;
  
  if (userCountryCode) {
    displayCurrency = targetCurrency;
    const cp = p.country_prices ? (p.country_prices as Record<string, number>)[userCountryCode] : null;
    if (cp) {
      displayPrice = cp;
    } else {
      displayPrice = await convertAmount(p.price, p.currency, targetCurrency);
    }
  }

  const desc = p.description
    ? `\n\n${escapeHtml(p.description as string)}`
    : `\n\n<i>Подробное описание уточняется у продавца.</i>`;
  const caption = `📦 <b>${escapeHtml(p.name as string)}</b>${desc}\n\n💰 <b>${formatMoney(displayPrice, displayCurrency)}</b>`;
  const reply_markup = {
    inline_keyboard: [
      [{ text: "➕ В корзину", callback_data: `add:${p.id}` }]
    ],
  };

  if (imgs.length === 0) {
    await tg("sendMessage", { chat_id, text: caption, parse_mode: "HTML", reply_markup });
  } else {
    // Send single photo with button
    await tg("sendPhoto", {
      chat_id,
      photo: imageUrl(imgs[0].image_path),
      caption,
      parse_mode: "HTML",
      reply_markup,
    });
  }
}

async function showProduct(chat_id: number, product_id: string, userCountryCode?: string) {
  const s = await db();
  const { data: p } = await s
    .from("products")
    .select("*, product_images(image_path, sort_order)")
    .eq("id", product_id)
    .eq("is_active", true)
    .single();
  if (!p) {
    await tg("sendMessage", { chat_id, text: "Товар не найден." });
    return;
  }
  let targetCurrency = "KZT";
  if (userCountryCode) {
    const { data: m } = await s.from("payment_methods").select("currency").eq("country_code", userCountryCode).maybeSingle();
    if (m) targetCurrency = m.currency;
  }
  await sendProductCard(chat_id, p, userCountryCode, s, targetCurrency);
}
function escapeHtml(t: string): string {
  if (!t) return "";
  return t
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("+")) {
    const num = trimmed.replace(/[^\d+]/g, "").slice(1);
    if (num.length < 10 || num.length > 15) return null;
    return `+${num}`;
  }

  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("8")) return `+7${digits.slice(1)}`;
  if (digits.length === 10) return `+7${digits}`;
  if (digits.length >= 10 && digits.length <= 15) return `+${digits}`;
  return null;
}

async function saveContactAndContinueCheckout(chat_id: number, user: BotUser, phone: string) {
  await setContact(user.telegram_id, phone);
  const updatedUser = { ...user, contact_phone: phone };
  const nextState = { ...user.state, mode: "idle" as const };
  await setState(user.telegram_id, nextState);

  await tg("sendMessage", {
    chat_id,
    text: "✅ Номер сохранён.",
    reply_markup: mainMenu(),
  });

  if (!user.state?.country_code) {
    await askCountry(chat_id, user.telegram_id, true);
    return;
  }

  await placeOrder(chat_id, updatedUser, user.state.country_code);
}

const TELEGRAM_MEDIA_GROUP_MAX = 10;
const TELEGRAM_MESSAGE_MAX = 4000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendLongHtmlMessage(chat_id: number, text: string) {
  if (text.length <= TELEGRAM_MESSAGE_MAX) {
    await tg("sendMessage", { chat_id, text, parse_mode: "HTML" });
    return;
  }
  const lines = text.split("\n");
  let chunk = "";
  for (const line of lines) {
    const next = chunk ? `${chunk}\n${line}` : line;
    if (next.length > TELEGRAM_MESSAGE_MAX) {
      if (chunk) await tg("sendMessage", { chat_id, text: chunk, parse_mode: "HTML" });
      chunk = line;
    } else {
      chunk = next;
    }
  }
  if (chunk) await tg("sendMessage", { chat_id, text: chunk, parse_mode: "HTML" });
}

async function sendCoverPreviews(adminChatId: string, orderId: number, coverUrls: string[]) {
  if (coverUrls.length === 0) return;
  const shortCaption = `📦 <b>Материалы заказа #${orderId}</b> (${coverUrls.length} шт.)`;
  for (let offset = 0; offset < coverUrls.length; offset += TELEGRAM_MEDIA_GROUP_MAX) {
    const batch = coverUrls.slice(offset, offset + TELEGRAM_MEDIA_GROUP_MAX);
    try {
      if (batch.length === 1) {
        await tg("sendPhoto", {
          chat_id: adminChatId,
          photo: batch[0],
          caption: offset === 0 ? shortCaption : undefined,
          parse_mode: "HTML",
        });
      } else {
        await tg("sendMediaGroup", {
          chat_id: adminChatId,
          media: batch.map((u, idx) => ({
            type: "photo",
            media: u,
            ...(offset === 0 && idx === 0 ? { caption: shortCaption, parse_mode: "HTML" } : {}),
          })),
        });
      }
    } catch (err) {
      console.error(`[bot] cover preview batch failed for order #${orderId}`, err);
    }
    if (offset + TELEGRAM_MEDIA_GROUP_MAX < coverUrls.length) await sleep(300);
  }
}

async function addToCart(telegram_id: number, product_id: string) {
  const s = await db();
  const { data: existing } = await s
    .from("cart_items")
    .select("id, quantity")
    .eq("telegram_id", telegram_id)
    .eq("product_id", product_id)
    .maybeSingle();
  if (existing) {
    await s
      .from("cart_items")
      .update({ quantity: (existing.quantity as number) + 1 })
      .eq("id", existing.id);
  } else {
    await s.from("cart_items").insert({ telegram_id, product_id, quantity: 1 });
  }
}

async function showCart(chat_id: number, user: BotUser) {
  const telegram_id = user.telegram_id;
  const s = await db();
  const { data: items } = await s
    .from("cart_items")
    .select("id, quantity, products(id, name, price, currency, country_prices)")
    .eq("telegram_id", telegram_id);
  if (!items?.length) {
    await tg("sendMessage", { chat_id, text: "🛒 Корзина пуста." });
    return;
  }
  let total = 0;
  let currency = "KZT";
  
  // get user country currency
  if (user.state?.country_code) {
    const { data: m } = await s.from("payment_methods").select("currency").eq("country_code", user.state.country_code).maybeSingle();
    if (m) currency = m.currency;
  }

  let text = "🛒 <b>Ваша корзина:</b>\n\n";
  const buttons: Array<Array<{ text: string; callback_data: string }>> = [];
  for (const it of items as any[]) {
    const p = it.products;
    if (!p) continue;
    
    let displayPrice = p.price;
    if (user.state?.country_code && p.country_prices) {
      const cp = (p.country_prices as Record<string, number>)[user.state.country_code];
      if (cp) displayPrice = cp;
      else displayPrice = await convertAmount(p.price, p.currency, currency); // fallback conversion if manual price missing
    } else {
      displayPrice = await convertAmount(p.price, p.currency, currency);
    }
    
    const line = Number(displayPrice) * Number(it.quantity);
    total += line;
    text += `• ${escapeHtml(p.name)} × ${it.quantity} — ${formatMoney(line, currency)}\n`;
    buttons.push([
      { text: `❌ Убрать «${p.name}»`, callback_data: `rem:${it.id}` },
    ]);
  }
  text += `\n<b>Итого: ${formatMoney(total, currency)}</b>`;
  buttons.push([
    { text: "💳 Оформить заказ", callback_data: "checkout" },
    { text: "🗑 Очистить", callback_data: "clear" },
  ]);
  await tg("sendMessage", {
    chat_id,
    text,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buttons },
  });
}

async function startCheckout(chat_id: number, user: BotUser) {
  const telegram_id = user.telegram_id;
  const s = await db();
  const { count } = await s
    .from("cart_items")
    .select("id", { count: "exact", head: true })
    .eq("telegram_id", telegram_id);
  if (!count) {
    await tg("sendMessage", { chat_id, text: "🛒 Корзина пуста." });
    return;
  }
  if (!user.contact_phone) {
    await setState(telegram_id, { ...user.state, mode: "awaiting_contact" });
    await tg("sendMessage", {
      chat_id,
      text:
        "Для оформления заказа укажите номер телефона — <b>просто напишите его в этот чат</b>, например:\n<code>+7 900 123-45-67</code>\n\nИли нажмите кнопку ниже, чтобы поделиться контактом автоматически.",
      parse_mode: "HTML",
      reply_markup: {
        keyboard: [[{ text: "📱 Поделиться контактом", request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    });
    return;
  }
  
  if (!user.state?.country_code) {
    await askCountry(chat_id, telegram_id, true);
    return;
  }

  // user has contact and country, proceed directly to placeOrder
  await placeOrder(chat_id, user, user.state.country_code);
}

async function askCountry(chat_id: number, telegram_id: number, forCheckout = false) {
  const s = await db();
  const { data: methods } = await s
    .from("payment_methods")
    .select("country_code, country_name")
    .eq("is_active", true)
    .order("sort_order");
  if (!methods?.length) {
    await tg("sendMessage", {
      chat_id,
      text: "Способы оплаты ещё не настроены. Свяжитесь с продавцом.",
    });
    return;
  }
  
  const prefix = forCheckout ? "country:" : "setcountry:";
  
  await tg("sendMessage", {
    chat_id,
    text: "Пожалуйста, выберите вашу страну (для отображения цен и реквизитов):",
    reply_markup: {
      inline_keyboard: methods.map((m) => [
        { text: m.country_name as string, callback_data: `${prefix}${m.country_code}` },
      ]),
    },
  });
}

async function placeOrder(chat_id: number, user: BotUser, country_code: string) {
  const telegram_id = user.telegram_id;
  const s = await db();
  const { data: method } = await s
    .from("payment_methods")
    .select("*")
    .eq("country_code", country_code)
    .single();
  const { data: items } = await s
    .from("cart_items")
    .select("id, quantity, products(id, name, price, currency, file_path, file_name, file_path_kz, file_name_kz, country_prices)")
    .eq("telegram_id", telegram_id);
  if (!items?.length) {
    await tg("sendMessage", { chat_id, text: "🛒 Корзина пуста." });
    return;
  }

  let total = 0;
  let currency = (method?.currency as string) || "KZT";
  for (const it of items as any[]) {
    if (!it.products) continue;
    
    let displayPrice = it.products.price;
    if (it.products.country_prices) {
      const cp = (it.products.country_prices as Record<string, number>)[country_code];
      if (cp) displayPrice = cp;
      else displayPrice = await convertAmount(it.products.price, it.products.currency, currency);
    } else {
      displayPrice = await convertAmount(it.products.price, it.products.currency, currency);
    }
    
    const line = Number(displayPrice) * Number(it.quantity);
    total += line;
  }

  const display = [user?.first_name, user?.last_name].filter(Boolean).join(" ").trim() || (user?.username ? `@${user.username}` : `id${telegram_id}`);

  const { data: order, error } = await s
    .from("orders")
    .insert({
      telegram_id,
      username: user?.username ?? null,
      display_name: display,
      contact: user?.contact_phone ?? null,
      country_code: method?.country_code ?? country_code,
      country_name: method?.country_name ?? country_code,
      total,
      currency,
      status: "awaiting_payment",
    })
    .select("*")
    .single();
  if (error || !order) {
    await tg("sendMessage", { chat_id, text: "Не удалось создать заказ. Попробуйте позже." });
    return;
  }

  const rows = await Promise.all(
    (items as any[]).map(async (it) => {
      let displayPrice = it.products?.price ?? 0;
      if (it.products?.country_prices) {
        const cp = (it.products.country_prices as Record<string, number>)[country_code];
        if (cp) displayPrice = cp;
        else displayPrice = await convertAmount(it.products?.price ?? 0, it.products?.currency || "KZT", currency);
      } else {
        displayPrice = await convertAmount(it.products?.price ?? 0, it.products?.currency || "KZT", currency);
      }
      
      return {
        order_id: order.id,
        product_id: it.products?.id,
        name_snapshot: it.products?.name,
        price_snapshot: displayPrice,
        quantity: it.quantity,
        file_path_snapshot: it.products?.file_path ?? null,
        file_name_snapshot: it.products?.file_name ?? null,
        file_path_kz_snapshot: it.products?.file_path_kz ?? null,
        file_name_kz_snapshot: it.products?.file_name_kz ?? null,
      };
    }),
  );
  await s.from("order_items").insert(rows);
  await s.from("cart_items").delete().eq("telegram_id", telegram_id);

  const { data: allSettings } = await s.from("app_settings").select("key, value");
  const getSetting = (key: string) => allSettings?.find((r) => r.key === key)?.value;

  const rkEnabled = getSetting("robokassa_enabled") === "true";
  if (rkEnabled) {
    const testMode = getSetting("robokassa_test_mode") === "true";
    const login = getSetting("robokassa_login")?.trim();
    const pass1 = (testMode ? getSetting("robokassa_pass1_test") : getSetting("robokassa_pass1"))?.trim();
    if (login && pass1) {
      const { buildRobokassaPaymentUrl } = await import("./robokassa.server");
      const outSum = Number(total).toFixed(2);
      const paymentUrl = buildRobokassaPaymentUrl({
        login,
        pass1,
        outSum,
        invId: order.id as number,
        description: `Заказ #${order.id}`,
        isTest: testMode,
      });

      await setState(telegram_id, { mode: "awaiting_payment", pending_order_id: order.id as number });
      await tg("sendMessage", {
        chat_id,
        text:
          `🧾 <b>Заказ #${order.id}</b> создан.\n\n` +
          `Сумма к оплате: <b>${formatMoney(total, currency)}</b>\n\n` +
          `Нажмите кнопку ниже для оплаты через Robokassa — после оплаты файлы придут автоматически.`,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[{ text: "💳 Оплатить через Robokassa", url: paymentUrl }]],
        },
      });
      return;
    }
  }

  await setState(telegram_id, { mode: "awaiting_proof", pending_order_id: order.id as number });

  await tg("sendMessage", {
    chat_id,
    text: `🧾 <b>Заказ #${order.id}</b> создан.\n\nСумма к оплате: <b>${formatMoney(total, currency)}</b>\n\n${method!.instructions}\n\nПосле оплаты <b>пришлите скриншот</b> (фото) в этот чат — продавец проверит и пришлёт файлы.`,
    parse_mode: "HTML",
  });
}

async function notifyAdminNewOrder(orderId: number, proofFileId: string | null, proofKind: "photo" | "document" | null) {
  const s = await db();
  const { data: setting } = await s
    .from("app_settings")
    .select("value")
    .eq("key", "admin_chat_id")
    .maybeSingle();
  const adminChatIdStr = setting?.value;
  if (!adminChatIdStr) {
    console.warn("[bot] admin_chat_id not configured");
    return;
  }
  const adminIds = adminChatIdStr.split(",").map((s: string) => s.trim()).filter(Boolean);
  if (adminIds.length === 0) return;

  const { data: order } = await s
    .from("orders")
    .select("*, order_items(*)")
    .eq("id", orderId)
    .single();
  if (!order) return;
  const items = ((order as any).order_items as Array<{ product_id: string | null; name_snapshot: string; price_snapshot: number; quantity: number }>) || [];

  // --- Задача 4: обложки товаров отдельным сообщением (чтобы админ сразу видел, что продаётся) ---
  const productIds = items.map((i) => i.product_id).filter(Boolean) as string[];
  const coverUrls: string[] = [];
  if (productIds.length > 0) {
    const { data: imgs } = await s
      .from("product_images")
      .select("product_id, image_path, sort_order")
      .in("product_id", productIds)
      .order("sort_order");
    // Берём первую (по sort_order) обложку для каждого товара, без дублей по product_id
    const seen = new Set<string>();
    for (const im of imgs ?? []) {
      const pid = im.product_id as string;
      if (seen.has(pid)) continue;
      seen.add(pid);
      coverUrls.push(imageUrl(im.image_path as string));
    }
  }

  const summaryText = `🆕 <b>Новый заказ #${order.id}</b>

👤 ${escapeHtml(order.display_name as string)}${order.username ? ` (@${escapeHtml(order.username)})` : ""}
📞 ${escapeHtml((order.contact as string) || "—")}
🌍 ${escapeHtml((order.country_name as string) || "—")}
📦 Позиций: ${items.length}

💰 <b>Итого: ${order.total} ${order.currency}</b>`;

  const itemsMessage =
    items.length > 0
      ? `📋 <b>Состав заказа #${order.id}</b>\n\n${items.map((i) => `• ${escapeHtml(i.name_snapshot)} × ${i.quantity} — ${i.price_snapshot} ${order.currency}`).join("\n")}`
      : "";

  const reply_markup = {
    inline_keyboard: [
      [
        { text: "✅ Подтвердить и выдать", callback_data: `confirm:${order.id}` },
        { text: "❌ Отклонить", callback_data: `reject:${order.id}` },
      ],
    ],
  };

  for (const adminChatId of adminIds) {
    // 1) Главное: краткое уведомление с кнопками — отдельно от превью и чека.
    try {
      await tg("sendMessage", {
        chat_id: adminChatId,
        text: summaryText,
        parse_mode: "HTML",
        reply_markup,
      });
    } catch (err) {
      console.error(`[bot] failed to notify admin ${adminChatId} (summary)`, err);
    }

    // 2) Полный список позиций — отдельным сообщением (без лимита caption 1024).
    if (itemsMessage) {
      try {
        await sendLongHtmlMessage(adminChatId, itemsMessage);
      } catch (err) {
        console.error(`[bot] failed to notify admin ${adminChatId} (items list)`, err);
      }
    }

    // 3) Чек оплаты — короткая подпись, без длинного списка товаров.
    const proofCaption = `🧾 <b>Чек оплаты — заказ #${order.id}</b>`;
    try {
      if (proofFileId && proofKind === "document") {
        await tg("sendDocument", {
          chat_id: adminChatId,
          document: proofFileId,
          caption: proofCaption,
          parse_mode: "HTML",
        });
      } else if (proofFileId) {
        await tg("sendPhoto", {
          chat_id: adminChatId,
          photo: proofFileId,
          caption: proofCaption,
          parse_mode: "HTML",
        });
      } else {
        await tg("sendMessage", {
          chat_id: adminChatId,
          text: `${proofCaption}\n\n⚠️ <b>Чек не удалось получить автоматически</b> — запросите у покупателя.`,
          parse_mode: "HTML",
        });
      }
    } catch (err) {
      console.error(`[bot] failed to notify admin ${adminChatId} (proof)`, err);
    }

    // 4) Превью обложек — опционально, батчами по 10 (лимит Telegram).
    try {
      await sendCoverPreviews(adminChatId, order.id as number, coverUrls);
    } catch (err) {
      console.error(`[bot] failed to notify admin ${adminChatId} (covers)`, err);
    }
  }
}

async function showSearch(chat_id: number, user: BotUser, query: string, offset = 0) {
  const telegram_id = user.telegram_id;
  const s = await db();
  const term = `%${query.replace(/[%_]/g, "")}%`;
  const { data } = await s
    .from("products")
    .select("*, product_images(image_path, sort_order)")
    .eq("is_active", true)
    .or(`name.ilike.${term},description.ilike.${term},keywords.ilike.${term}`)
    .order("name")
    .limit(30);

  // Запоминаем запрос для пагинации (callback_data ограничена 64 байтами,
  // поэтому сам запрос в payload не кладём, а храним в state).
  await setState(telegram_id, { ...user.state, mode: "idle", last_search: query });

  if (!data?.length) {
    await tg("sendMessage", { chat_id, text: "Ничего не нашлось. Попробуйте другое слово." });
    return;
  }

  let targetCurrency = "KZT";
  if (user.state?.country_code) {
    const { data: m } = await s.from("payment_methods").select("currency").eq("country_code", user.state.country_code).maybeSingle();
    if (m) targetCurrency = m.currency;
  }

  const all = data;
  const page = all.slice(offset, offset + 5);

  if (offset === 0) {
    await tg("sendMessage", { chat_id, text: `🔍 Найдено материалов: ${all.length}` });
  }

  for (const p of page) {
    await sendProductCard(chat_id, p, user.state?.country_code, s, targetCurrency);
  }

  // Кнопка «Показать ещё», если остались результаты
  const nextOffset = offset + 5;
  if (nextOffset < all.length) {
    await tg("sendMessage", {
      chat_id,
      text: `Показано ${nextOffset} из ${all.length}`,
      reply_markup: { inline_keyboard: [[{ text: "⬇️ Показать ещё", callback_data: `searchmore:${nextOffset}` }]] },
    });
  }
}

async function showMyOrders(chat_id: number, telegram_id: number) {
  const s = await db();
  const { data } = await s
    .from("orders")
    .select("id, status, total, currency, created_at")
    .eq("telegram_id", telegram_id)
    .order("created_at", { ascending: false })
    .limit(20);
  if (!data?.length) {
    await tg("sendMessage", { chat_id, text: "У вас пока нет заказов." });
    return;
  }
  const statusMap: Record<string, string> = {
    awaiting_payment: "⏳ ожидает оплаты",
    awaiting_confirmation: "🔎 проверяется",
    delivering: "📤 выдаётся",
    delivered: "✅ выдан",
    rejected: "❌ отклонён",
  };
  const text = data
    .map(
      (o) =>
        `#${o.id} — ${o.total} ${o.currency} — ${statusMap[o.status as string] || o.status}`,
    )
    .join("\n");
  await tg("sendMessage", { chat_id, text: `📋 Ваши заказы:\n\n${text}` });
}

export async function handleUpdate(update: any) {
  try {
    // Callback queries
    if (update.callback_query) {
      const cq = update.callback_query;
      const chat_id = cq.message?.chat?.id;
      const from_id = cq.from?.id;
      const data: string = cq.data || "";
      await tg("answerCallbackQuery", { callback_query_id: cq.id });

      const user = await upsertUser(cq.from as any);
      
      // Before allowing navigation, require country code
      if (!data.startsWith("setcountry:") && !data.startsWith("confirm:") && !data.startsWith("reject:") && data !== "clear" && !data.startsWith("rem:") && !data.startsWith("add:") && !data.startsWith("lang_ru:") && !data.startsWith("lang_kz:") && !data.startsWith("searchmore:") && !data.startsWith("prod:")) {
        if (!user.state?.country_code) {
          await askCountry(chat_id, from_id);
          return;
        }
      }

      if (data.startsWith("cat:root")) {
        const parts = data.split(":");
        return showCategories(chat_id, null, user.state?.country_code, Number(parts[2] || 0));
      }
      if (data.startsWith("cat:")) {
        const parts = data.split(":");
        return showCategories(chat_id, parts[1], user.state?.country_code, Number(parts[2] || 0));
      }
      if (data.startsWith("prod:")) return showProduct(chat_id, data.slice(5), user.state?.country_code);
      if (data.startsWith("searchmore:")) {
        // Пагинация поиска: запрос берём из state.last_search
        const offset = Number(data.slice(11)) || 0;
        const query = user.state?.last_search;
        if (!query) {
          await tg("sendMessage", { chat_id, text: "Сессия поиска устарела. Повторите поиск." });
          return;
        }
        return showSearch(chat_id, user, query, offset);
      }
      if (data.startsWith("add:")) {
        await addToCart(from_id, data.slice(4));
        await tg("sendMessage", { chat_id, text: "✅ Добавлено в корзину." });
        return;
      }
      if (data.startsWith("rem:")) {
        const s = await db();
        await s.from("cart_items").delete().eq("id", data.slice(4));
        return showCart(chat_id, user);
      }
      if (data === "clear") {
        const s = await db();
        await s.from("cart_items").delete().eq("telegram_id", from_id);
        await tg("sendMessage", { chat_id, text: "🗑 Корзина очищена." });
        return;
      }
      if (data === "checkout") return startCheckout(chat_id, user);
      if (data.startsWith("country:")) return placeOrder(chat_id, user, data.slice(8));
      
      if (data.startsWith("setcountry:")) {
        const code = data.slice(11);
        const s = await db();
        const { data: m } = await s.from("payment_methods").select("country_name").eq("country_code", code).maybeSingle();
        await setState(from_id, { ...user.state, country_code: code, country_name: m?.country_name });
        await tg("sendMessage", { chat_id, text: `✅ Ваша страна сохранена: ${m?.country_name}\nТеперь вы видите корректные цены!` });
        await sendMain(chat_id);
        return;
      }

      if (data.startsWith("lang_ru:") || data.startsWith("lang_kz:")) {
        const parts = data.split(":");
        const lang = parts[0] === "lang_ru" ? "ru" : "kz";
        const orderId = Number(parts[1]);
        const idx = Number(parts[2]);
        const s = await db();
        const { data: order } = await s.from("orders").select("*, order_items(*)").eq("id", orderId).single();
        if (!order) return;
        const items = order.order_items as any[];
        const item = items[idx];
        if (!item) return;

        // Check if this language was already delivered
        if (item.delivered_language === lang || item.delivered_language === "both") {
          await tg("sendMessage", { chat_id, text: "⚠️ Этот файл уже был отправлен." });
          return;
        }

        const { sendFileToUser } = await import("./orders.server");
        const path = lang === "ru" ? item.file_path_snapshot : item.file_path_kz_snapshot;
        const name = lang === "ru" ? item.file_name_snapshot : item.file_name_kz_snapshot;

        await tg("sendMessage", { chat_id, text: `⏳ Загружаю файл (${lang === "ru" ? "Русский" : "Қазақша"})...` });

        await sendFileToUser(
          order.telegram_id,
          path,
          name || "file.bin",
          item.name_snapshot,
          item.quantity || 1
        );

        // Update delivered_language tracking
        const newDeliveredLang = item.delivered_language ? "both" : lang;
        await s.from("order_items").update({ delivered_language: newDeliveredLang }).eq("id", item.id);

        // Edit the message to remove buttons
        if (cq.message?.message_id) {
          await tg("editMessageReplyMarkup", {
            chat_id,
            message_id: cq.message.message_id,
            reply_markup: { inline_keyboard: [] }
          });
        }

        return;
      }

      // Admin actions
      if (data.startsWith("confirm:")) {
        const orderId = Number(data.slice(8));
        if (cq.message?.message_id) {
          await tg("editMessageReplyMarkup", {
            chat_id,
            message_id: cq.message.message_id,
            reply_markup: { inline_keyboard: [] },
          });
        }
        await tg("sendMessage", { chat_id, text: `⏳ Выдаю заказ #${orderId}...` });
        const { deliverOrder } = await import("./orders.server");
        try {
          const result = await deliverOrder(orderId);
          if (result.alreadyDelivered) {
            await tg("sendMessage", { chat_id, text: `ℹ️ Заказ #${orderId} уже выдаётся или выдан.` });
          } else {
            await tg("sendMessage", { chat_id, text: `✅ Заказ #${orderId} выдан.` });
          }
        } catch (e: any) {
          await tg("sendMessage", { chat_id, text: `Ошибка: ${e.message}` });
        }
        return;
      }
      if (data.startsWith("reject:")) {
        const orderId = Number(data.slice(7));
        const s = await db();
        const { data: order } = await s
          .from("orders")
          .update({ status: "rejected" })
          .eq("id", orderId)
          .select("telegram_id")
          .single();
        if (order) {
          await tg("sendMessage", {
            chat_id: order.telegram_id,
            text: `❌ Ваш заказ #${orderId} отклонён. Если это ошибка — напишите продавцу.`,
          });
        }
        await tg("sendMessage", { chat_id, text: `Заказ #${orderId} отклонён.` });
        return;
      }
      return;
    }

    const msg = update.message;
    if (!msg) return;
    const chat_id = msg.chat.id;
    const from = msg.from;
    if (!from) return;
    const user = await upsertUser(from);

    // /start - special: also detect if sender is the admin and offer to bind
    if (msg.text === "/start") {
      await setState(from.id, { mode: "idle" });
      const s = await db();
      const { data: setting } = await s
        .from("app_settings")
        .select("value")
        .eq("key", "admin_chat_id")
        .maybeSingle();
      if (!setting?.value) {
        // First user gets a hint with their chat id
        await tg("sendMessage", {
          chat_id,
          text: `Привет! Это бот-каталог.\n\nВаш Telegram ID: <code>${from.id}</code>\nЕсли вы продавец — скопируйте его и вставьте в админ-панель → Настройки, чтобы получать уведомления о заказах.`,
          parse_mode: "HTML",
        });
      }
      if (!user.state?.country_code) {
        await askCountry(chat_id, from.id);
      } else {
        await sendMain(chat_id, `Привет, ${user.first_name || "друг"}! Добро пожаловать в магазин.`);
      }
      return;
    }
    if (msg.text === "/id") {
      await tg("sendMessage", { chat_id, text: `Ваш Telegram ID: ${from.id}` });
      return;
    }

    // Contact share (optional — user can also type phone as text)
    if (msg.contact && user.state?.mode === "awaiting_contact") {
      await saveContactAndContinueCheckout(chat_id, user, msg.contact.phone_number);
      return;
    }

    // Phone number typed as text during checkout
    if (user.state?.mode === "awaiting_contact" && msg.text) {
      if (msg.text === "📱 Поделиться контактом") {
        await tg("sendMessage", {
          chat_id,
          text: "Нажмите кнопку «📱 Поделиться контактом» внизу экрана или просто напишите номер телефона в чат.",
        });
        return;
      }

      const phone = normalizePhone(msg.text);
      if (!phone) {
        await tg("sendMessage", {
          chat_id,
          text: "Не удалось распознать номер. Напишите телефон цифрами, например: <code>+79001234567</code> или <code>89001234567</code>",
          parse_mode: "HTML",
        });
        return;
      }
      await saveContactAndContinueCheckout(chat_id, user, phone);
      return;
    }

    // Payment proof (photo OR document, e.g. PDF) while awaiting
    if (user.state?.mode === "awaiting_proof" && user.state.pending_order_id) {
      const orderId = user.state.pending_order_id;

      // Только фото или документ считаются чеком; иначе подсказка
      if (!msg.photo && !msg.document) {
        await tg("sendMessage", {
          chat_id,
          text: "📨 Пришлите, пожалуйста, чек об оплате — фото или файл (например, PDF).",
        });
        return;
      }

      // Определяем источник чека и расширение сохраняемого файла.
      // Расширение важно: админ-панель определяет тип чека по расширению пути.
      let proofFileId: string | null = null;
      let proofKind: "photo" | "document" | null = null;
      let dl: { bytes: Uint8Array; mime: string } | null = null;
      let fileExt = "jpg";

      if (msg.photo) {
        const biggest = msg.photo[msg.photo.length - 1];
        proofFileId = biggest.file_id;
        proofKind = "photo";
        dl = await downloadTelegramFile(biggest.file_id);
      } else if (msg.document) {
        proofFileId = msg.document.file_id;
        proofKind = "document";
        dl = await downloadTelegramFile(msg.document.file_id);
        const docName = (msg.document.file_name || "").toLowerCase();
        const extMatch = docName.match(/\.([a-z0-9]{1,8})$/);
        if (extMatch) fileExt = extMatch[1];
        else if (msg.document.mime_type === "application/pdf") fileExt = "pdf";
        else fileExt = "bin";
      }

      // Сохраняем чек в storage и переводим заказ в "awaiting_confirmation".
      // Даже если скачивание не удалось — переводим заказ, чтобы покупатель не зависал,
      // и уведомляем админа, что чек нужно запросить вручную.
      let proofSaved = false;
      if (dl) {
        const { supabaseAdmin } = await import("@/integrations-supabase/client.server");
        const key = `order-${orderId}/${Date.now()}.${fileExt}`;
        const upRes = await supabaseAdmin.storage.from("payment-proofs").upload(key, dl.bytes, {
          contentType: dl.mime,
          upsert: true,
        });
        if (!upRes.error) {
          await supabaseAdmin
            .from("orders")
            .update({ payment_proof_path: key, status: "awaiting_confirmation" })
            .eq("id", orderId);
          proofSaved = true;
        }
      }

      await setState(from.id, { ...user.state, mode: "idle", pending_order_id: undefined });

      if (proofSaved) {
        await tg("sendMessage", {
          chat_id,
          text: `📨 Спасибо! Чек получен. Заказ #${orderId} отправлен на проверку. Как только продавец подтвердит оплату — бот пришлёт файлы.`,
          reply_markup: mainMenu(),
        });
        await notifyAdminNewOrder(orderId, proofFileId, proofKind);
      } else {
        const { supabaseAdmin } = await import("@/integrations-supabase/client.server");
        await supabaseAdmin
          .from("orders")
          .update({ status: "awaiting_confirmation" })
          .eq("id", orderId);
        await tg("sendMessage", {
          chat_id,
          text: `⚠️ Не удалось сохранить чек заказа #${orderId}. Продавец проверит заказ вручную. Если хотите — попробуйте отправить чек ещё раз.`,
          reply_markup: mainMenu(),
        });
        await notifyAdminNewOrder(orderId, null, null);
      }
      return;
    }

    // Search text input
    if (user.state?.mode === "search" && msg.text) {
      return showSearch(chat_id, user, msg.text);
    }

    if (!user.state?.country_code && msg.text && ["📚 Каталог", "🔍 Поиск", "🛒 Корзина", "📋 Мои заказы", "ℹ️ Информация"].includes(msg.text)) {
      await askCountry(chat_id, from.id);
      return;
    }

    // Main menu buttons
    switch (msg.text) {
      case "📚 Каталог":
        return showCategories(chat_id, null, user.state?.country_code);
      case "🔍 Поиск":
        await setState(from.id, { ...user.state, mode: "search" });
        await tg("sendMessage", {
          chat_id,
          text: "Напишите название или ключевое слово:",
        });
        return;
      case "🛒 Корзина":
        return showCart(chat_id, user);
      case "📋 Мои заказы":
        return showMyOrders(chat_id, from.id);
      case "ℹ️ Информация": {
        const base = originFromState();
        await tg("sendMessage", {
          chat_id,
          text:
            `ℹ️ <b>Информация о магазине</b>\n\n` +
            `Ниже — обязательные документы и реквизиты.\n` +
            `Откройте ссылки в браузере:`,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "📄 Договор оферты", url: `${base}/legal/offer` }],
              [{ text: "🔒 Политика конфиденциальности", url: `${base}/legal/privacy` }],
              [{ text: "🏦 Реквизиты", url: `${base}/legal/requisites` }],
              [{ text: "👤 О продавце", url: `${base}/legal/about` }],
            ],
          },
          disable_web_page_preview: true,
        });
        return;
      }
      case "💬 Связаться с автором": {
        const s = await db();
        const { data: setting } = await s
          .from("app_settings")
          .select("value")
          .eq("key", "admin_contact_link")
          .maybeSingle();
        if (setting?.value) {
          await tg("sendMessage", {
            chat_id,
            text: `Для связи с автором используйте следующие контакты:\n${setting.value}`,
            disable_web_page_preview: true,
          });
        } else {
          await tg("sendMessage", { chat_id, text: "Контакты автора пока не указаны." });
        }
        return;
      }
    }

    // Fallback
    await sendMain(chat_id);
  } catch (e: any) {
    console.error("[bot] handleUpdate error", e);
  }
}