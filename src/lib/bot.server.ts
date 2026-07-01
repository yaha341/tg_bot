import { tg, downloadTelegramFile } from "./telegram.server";
import { convertAmount } from "./currency.server";

type BotUser = {
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  language_code: string | null;
  contact_phone: string | null;
  state: { mode?: string; pending_order_id?: number; country_code?: string; country_name?: string } | null;
};

async function db() {
  const { supabaseAdmin } = await import("@/integrations-supabase/client.server");
  return supabaseAdmin;
}

function originFromState(): string {
  // Use stable preview URL as image origin. Project ID hardcoded in env at deploy.
  return (
    process.env.PUBLIC_APP_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "") ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "") ||
    `https://project--79250394-984a-476c-a6aa-efe3efcc4b0e-dev.lovable.app`
  );
}

function imageUrl(path: string): string {
  return `${originFromState()}/api/public/img/${path}`;
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
      [{ text: "💬 Связаться с автором" }],
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
      catButtons.push([{ text: `📁 ${c.name as string}`, callback_data: `cat:${c.id}:0` }]);
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

  const desc = p.description ? `\n\n${escapeHtml(p.description as string)}` : "";
  const caption = `📦 <b>${escapeHtml(p.name as string)}</b>${desc}\n\n💰 <b>${displayPrice} ${displayCurrency}</b>`;
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
    text += `• ${escapeHtml(p.name)} × ${it.quantity} — ${line} ${currency}\n`;
    buttons.push([
      { text: `❌ Убрать «${p.name}»`, callback_data: `rem:${it.id}` },
    ]);
  }
  text += `\n<b>Итого: ${total} ${currency}</b>`;
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
      text: "Для оформления заказа поделитесь, пожалуйста, контактом — продавец свяжется с вами при необходимости.",
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

  await setState(telegram_id, { mode: "awaiting_proof", pending_order_id: order.id as number });

  await tg("sendMessage", {
    chat_id,
    text: `🧾 <b>Заказ #${order.id}</b> создан.\n\nСумма к оплате: <b>${total} ${currency}</b>\n\n${method!.instructions}\n\nПосле оплаты <b>пришлите скриншот</b> (фото) в этот чат — продавец проверит и пришлёт файлы.`,
    parse_mode: "HTML",
  });
}

async function notifyAdminNewOrder(orderId: number, proofFileId: string | null) {
  const s = await db();
  const { data: setting } = await s
    .from("app_settings")
    .select("value")
    .eq("key", "admin_chat_id")
    .maybeSingle();
  const adminChatId = setting?.value;
  if (!adminChatId) {
    console.warn("[bot] admin_chat_id not configured");
    return;
  }
  const { data: order } = await s
    .from("orders")
    .select("*, order_items(*)")
    .eq("id", orderId)
    .single();
  if (!order) return;
  const items = ((order as any).order_items as Array<{ name_snapshot: string; price_snapshot: number; quantity: number }>) || [];
  const itemsText = items
    .map((i) => `• ${i.name_snapshot} × ${i.quantity} — ${i.price_snapshot} ${order.currency}`)
    .join("\n");

  const text = `🆕 <b>Новый заказ #${order.id}</b>

👤 ${escapeHtml(order.display_name as string)}${order.username ? ` (@${escapeHtml(order.username)})` : ""}
📞 ${escapeHtml((order.contact as string) || "—")}
🌍 ${escapeHtml((order.country_name as string) || "—")}

${escapeHtml(itemsText)}

💰 <b>Итого: ${order.total} ${order.currency}</b>`;

  const reply_markup = {
    inline_keyboard: [
      [
        { text: "✅ Подтвердить и выдать", callback_data: `confirm:${order.id}` },
        { text: "❌ Отклонить", callback_data: `reject:${order.id}` },
      ],
    ],
  };

  if (proofFileId) {
    await tg("sendPhoto", {
      chat_id: adminChatId,
      photo: proofFileId,
      caption: text,
      parse_mode: "HTML",
      reply_markup,
    });
  } else {
    await tg("sendMessage", { chat_id: adminChatId, text, parse_mode: "HTML", reply_markup });
  }
}

async function showSearch(chat_id: number, user: BotUser, query: string) {
  const telegram_id = user.telegram_id;
  const s = await db();
  const term = `%${query.replace(/[%_]/g, "")}%`;
  const { data } = await s
    .from("products")
    .select("id, name, price, currency, country_prices")
    .eq("is_active", true)
    .or(`name.ilike.${term},description.ilike.${term},keywords.ilike.${term}`)
    .limit(20);
  await setState(telegram_id, { ...user.state, mode: "idle" });
  if (!data?.length) {
    await tg("sendMessage", { chat_id, text: "Ничего не нашлось. Попробуйте другое слово." });
    return;
  }
  
  let targetCurrency = "KZT";
  if (user.state?.country_code) {
    const { data: m } = await s.from("payment_methods").select("currency").eq("country_code", user.state.country_code).maybeSingle();
    if (m) targetCurrency = m.currency;
  }
  
  const buttons = [];
  for (const p of data) {
    let displayPrice = p.price;
    let curr = p.currency;
    
    if (user.state?.country_code) {
      curr = targetCurrency;
      const cp = p.country_prices ? (p.country_prices as Record<string, number>)[user.state.country_code] : null;
      if (cp) {
        displayPrice = cp;
      } else {
        displayPrice = await convertAmount(p.price, p.currency, targetCurrency);
      }
    }
    buttons.push([{ text: `${p.name} — ${displayPrice} ${curr}`, callback_data: `prod:${p.id}` }]);
  }
  
  await tg("sendMessage", {
    chat_id,
    text: `🔍 Найдено: ${data.length}`,
    reply_markup: { inline_keyboard: buttons },
  });
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
      if (!data.startsWith("setcountry:") && !data.startsWith("confirm:") && !data.startsWith("reject:") && data !== "clear" && !data.startsWith("rem:") && !data.startsWith("add:") && !data.startsWith("lang_ru:") && !data.startsWith("lang_kz:")) {
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

        const { sendFileToUser } = await import("./orders.functions");
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
        const { deliverOrder } = await import("./orders.functions");
        try {
          await deliverOrder(orderId);
          await tg("sendMessage", { chat_id, text: `✅ Заказ #${orderId} выдан.` });
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

    // Contact share
    if (msg.contact && (user.state?.mode === "awaiting_contact" || true)) {
      await setContact(from.id, msg.contact.phone_number);
      await tg("sendMessage", {
        chat_id,
        text: "Спасибо! Контакт сохранён.",
        reply_markup: mainMenu(),
      });
      if (user.state?.mode === "awaiting_contact") {
        await setState(from.id, { ...user.state, mode: "idle" });
        if (!user.state?.country_code) {
          await askCountry(chat_id, from.id, true);
        } else {
          await placeOrder(chat_id, user, user.state.country_code);
        }
      }
      return;
    }

    // Payment proof (photo) while awaiting
    if (msg.photo && user.state?.mode === "awaiting_proof" && user.state.pending_order_id) {
      const orderId = user.state.pending_order_id;
      const biggest = msg.photo[msg.photo.length - 1];
      const file = await downloadTelegramFile(biggest.file_id);
      if (file) {
        const { supabaseAdmin } = await import("@/integrations-supabase/client.server");
        const key = `order-${orderId}/${Date.now()}.jpg`;
        await supabaseAdmin.storage.from("payment-proofs").upload(key, file.bytes, {
          contentType: file.mime,
          upsert: true,
        });
        await supabaseAdmin
          .from("orders")
          .update({ payment_proof_path: key, status: "awaiting_confirmation" })
          .eq("id", orderId);
      }
      await setState(from.id, { ...user.state, mode: "idle", pending_order_id: undefined });
      await tg("sendMessage", {
        chat_id,
        text: `📨 Спасибо! Скриншот получен. Заказ #${orderId} отправлен на проверку. Как только продавец подтвердит оплату — бот пришлёт файлы.`,
        reply_markup: mainMenu(),
      });
      await notifyAdminNewOrder(orderId, biggest.file_id);
      return;
    }

    // Search text input
    if (user.state?.mode === "search" && msg.text) {
      return showSearch(chat_id, user, msg.text);
    }

    if (!user.state?.country_code && msg.text && ["📚 Каталог", "🔍 Поиск", "🛒 Корзина", "📋 Мои заказы"].includes(msg.text)) {
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