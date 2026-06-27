import { tg, downloadTelegramFile } from "./telegram.server";
import { convertAmount } from "./currency.server";

type BotUser = {
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  language_code: string | null;
  contact_phone: string | null;
  state: { mode?: string; pending_order_id?: number } | null;
};

async function db() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

function originFromState(): string {
  // Use stable preview URL as image origin. Project ID hardcoded in env at deploy.
  return (
    process.env.PUBLIC_APP_URL ||
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
    ],
    resize_keyboard: true,
  };
}

async function sendMain(chat_id: number, text = "Выберите раздел:") {
  await tg("sendMessage", { chat_id, text, reply_markup: mainMenu() });
}

async function showCategories(chat_id: number, parentId: string | null) {
  const s = await db();
  const q = s.from("categories").select("id, name").order("sort_order").order("name");
  const { data: cats } = parentId ? await q.eq("parent_id", parentId) : await q.is("parent_id", null);
  const productsQuery = s
    .from("products")
    .select("id, name, price, currency")
    .eq("is_active", true)
    .order("sort_order")
    .order("name");
  const { data: products } = parentId
    ? await productsQuery.eq("category_id", parentId)
    : await productsQuery.is("category_id", null);

  const buttons: Array<Array<{ text: string; callback_data: string }>> = [];
  for (const c of cats ?? []) {
    buttons.push([{ text: `📁 ${c.name as string}`, callback_data: `cat:${c.id}` }]);
  }
  for (const p of products ?? []) {
    buttons.push([
      {
        text: `📦 ${p.name as string} — ${p.price} ${p.currency}`,
        callback_data: `prod:${p.id}`,
      },
    ]);
  }
  if (parentId) {
    // find parent's parent for back nav
    const { data: cur } = await s
      .from("categories")
      .select("parent_id")
      .eq("id", parentId)
      .single();
    const back = cur?.parent_id ? `cat:${cur.parent_id as string}` : "cat:root";
    buttons.push([{ text: "« Назад", callback_data: back }]);
  }
  if (!buttons.length) {
    await tg("sendMessage", { chat_id, text: "📂 Здесь пока пусто." });
    return;
  }
  await tg("sendMessage", {
    chat_id,
    text: parentId ? "📁 Подкатегории и товары:" : "📚 Каталог:",
    reply_markup: { inline_keyboard: buttons },
  });
}

async function showProduct(chat_id: number, product_id: string) {
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
  const imgs = ((p as any).product_images as Array<{ image_path: string; sort_order: number }>)
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order);

  const caption = `📦 *${escapeMd(p.name as string)}*\n\n${escapeMd((p.description as string) || "")}\n\n💰 *${p.price} ${p.currency}*`;

  if (imgs.length === 0) {
    await tg("sendMessage", {
      chat_id,
      text: caption,
      parse_mode: "Markdown",
    });
  } else if (imgs.length === 1) {
    await tg("sendPhoto", {
      chat_id,
      photo: imageUrl(imgs[0].image_path),
      caption,
      parse_mode: "Markdown",
    });
  } else {
    await tg("sendMediaGroup", {
      chat_id,
      media: imgs.slice(0, 10).map((im, i) => ({
        type: "photo",
        media: imageUrl(im.image_path),
        ...(i === 0 ? { caption, parse_mode: "Markdown" } : {}),
      })),
    });
  }

  await tg("sendMessage", {
    chat_id,
    text: "Что дальше?",
    reply_markup: {
      inline_keyboard: [
        [{ text: "➕ В корзину", callback_data: `add:${p.id}` }],
        [{ text: "« К каталогу", callback_data: p.category_id ? `cat:${p.category_id}` : "cat:root" }],
      ],
    },
  });
}

function escapeMd(t: string): string {
  return t.replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1");
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

async function showCart(chat_id: number, telegram_id: number) {
  const s = await db();
  const { data: items } = await s
    .from("cart_items")
    .select("id, quantity, products(id, name, price, currency)")
    .eq("telegram_id", telegram_id);
  if (!items?.length) {
    await tg("sendMessage", { chat_id, text: "🛒 Корзина пуста." });
    return;
  }
  let total = 0;
  let currency = "KZT";
  let text = "🛒 *Ваша корзина:*\n\n";
  const buttons: Array<Array<{ text: string; callback_data: string }>> = [];
  for (const it of items as any[]) {
    const p = it.products;
    if (!p) continue;
    const line = Number(p.price) * Number(it.quantity);
    total += line;
    currency = p.currency;
    text += `• ${p.name} × ${it.quantity} — ${line} ${p.currency}\n`;
    buttons.push([
      { text: `❌ Убрать «${p.name}»`, callback_data: `rem:${it.id}` },
    ]);
  }
  text += `\n*Итого: ${total} ${currency}*`;
  buttons.push([
    { text: "💳 Оформить заказ", callback_data: "checkout" },
    { text: "🗑 Очистить", callback_data: "clear" },
  ]);
  await tg("sendMessage", {
    chat_id,
    text,
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: buttons },
  });
}

async function startCheckout(chat_id: number, telegram_id: number) {
  const s = await db();
  const { count } = await s
    .from("cart_items")
    .select("id", { count: "exact", head: true })
    .eq("telegram_id", telegram_id);
  if (!count) {
    await tg("sendMessage", { chat_id, text: "🛒 Корзина пуста." });
    return;
  }
  const { data: user } = await s
    .from("bot_users")
    .select("contact_phone")
    .eq("telegram_id", telegram_id)
    .single();
  if (!user?.contact_phone) {
    await setState(telegram_id, { mode: "awaiting_contact" });
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
  await askCountry(chat_id, telegram_id);
}

async function askCountry(chat_id: number, telegram_id: number) {
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
  await tg("sendMessage", {
    chat_id,
    text: "Выберите вашу страну для отображения реквизитов:",
    reply_markup: {
      inline_keyboard: methods.map((m) => [
        { text: m.country_name as string, callback_data: `country:${m.country_code}` },
      ]),
    },
  });
}

async function placeOrder(chat_id: number, telegram_id: number, country_code: string) {
  const s = await db();
  const { data: method } = await s
    .from("payment_methods")
    .select("*")
    .eq("country_code", country_code)
    .single();
  const { data: items } = await s
    .from("cart_items")
    .select("id, quantity, products(id, name, price, currency, file_path, file_name)")
    .eq("telegram_id", telegram_id);
  if (!items?.length) {
    await tg("sendMessage", { chat_id, text: "🛒 Корзина пуста." });
    return;
  }
  const { data: user } = await s
    .from("bot_users")
    .select("*")
    .eq("telegram_id", telegram_id)
    .single();

  let total = 0;
  let currency = (method?.currency as string) || "KZT";
  for (const it of items as any[]) {
    if (!it.products) continue;
    const line = Number(it.products.price) * Number(it.quantity);
    const converted = await convertAmount(line, it.products.currency || "KZT", currency);
    total += converted;
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
    (items as any[]).map(async (it) => ({
      order_id: order.id,
      product_id: it.products?.id,
      name_snapshot: it.products?.name,
      price_snapshot: await convertAmount(
        Number(it.products?.price ?? 0),
        it.products?.currency || "KZT",
        currency,
      ),
      quantity: it.quantity,
      file_path_snapshot: it.products?.file_path ?? null,
      file_name_snapshot: it.products?.file_name ?? null,
    })),
  );
  await s.from("order_items").insert(rows);
  await s.from("cart_items").delete().eq("telegram_id", telegram_id);

  await setState(telegram_id, { mode: "awaiting_proof", pending_order_id: order.id as number });

  await tg("sendMessage", {
    chat_id,
    text: `🧾 *Заказ #${order.id}* создан.\n\nСумма к оплате: *${total} ${currency}*\n\n${escapeMd(method!.instructions as string)}\n\nПосле оплаты *пришлите скриншот* (фото) в этот чат — продавец проверит и пришлёт файлы.`,
    parse_mode: "Markdown",
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

  const text = `🆕 *Новый заказ #${order.id}*

👤 ${escapeMd(order.display_name as string)}${order.username ? ` (@${order.username})` : ""}
📞 ${escapeMd((order.contact as string) || "—")}
🌍 ${escapeMd((order.country_name as string) || "—")}

${escapeMd(itemsText)}

💰 *Итого: ${order.total} ${order.currency}*`;

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
      parse_mode: "Markdown",
      reply_markup,
    });
  } else {
    await tg("sendMessage", { chat_id: adminChatId, text, parse_mode: "Markdown", reply_markup });
  }
}

async function showSearch(chat_id: number, telegram_id: number, query: string) {
  const s = await db();
  const term = `%${query.replace(/[%_]/g, "")}%`;
  const { data } = await s
    .from("products")
    .select("id, name, price, currency")
    .eq("is_active", true)
    .or(`name.ilike.${term},description.ilike.${term},keywords.ilike.${term}`)
    .limit(20);
  await setState(telegram_id, { mode: "idle" });
  if (!data?.length) {
    await tg("sendMessage", { chat_id, text: "Ничего не нашлось. Попробуйте другое слово." });
    return;
  }
  await tg("sendMessage", {
    chat_id,
    text: `🔍 Найдено: ${data.length}`,
    reply_markup: {
      inline_keyboard: data.map((p) => [
        { text: `${p.name} — ${p.price} ${p.currency}`, callback_data: `prod:${p.id}` },
      ]),
    },
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

      if (data === "cat:root") return showCategories(chat_id, null);
      if (data.startsWith("cat:")) return showCategories(chat_id, data.slice(4));
      if (data.startsWith("prod:")) return showProduct(chat_id, data.slice(5));
      if (data.startsWith("add:")) {
        await addToCart(from_id, data.slice(4));
        await tg("sendMessage", { chat_id, text: "✅ Добавлено в корзину." });
        return;
      }
      if (data.startsWith("rem:")) {
        const s = await db();
        await s.from("cart_items").delete().eq("id", data.slice(4));
        return showCart(chat_id, from_id);
      }
      if (data === "clear") {
        const s = await db();
        await s.from("cart_items").delete().eq("telegram_id", from_id);
        await tg("sendMessage", { chat_id, text: "🗑 Корзина очищена." });
        return;
      }
      if (data === "checkout") return startCheckout(chat_id, from_id);
      if (data.startsWith("country:")) return placeOrder(chat_id, from_id, data.slice(8));

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
      await sendMain(chat_id, `Привет, ${user.first_name || "друг"}! Добро пожаловать в магазин.`);
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
        await setState(from.id, { mode: "idle" });
        await askCountry(chat_id, from.id);
      }
      return;
    }

    // Payment proof (photo) while awaiting
    if (msg.photo && user.state?.mode === "awaiting_proof" && user.state.pending_order_id) {
      const orderId = user.state.pending_order_id;
      const biggest = msg.photo[msg.photo.length - 1];
      const file = await downloadTelegramFile(biggest.file_id);
      if (file) {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
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
      await setState(from.id, { mode: "idle" });
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
      return showSearch(chat_id, from.id, msg.text);
    }

    // Main menu buttons
    switch (msg.text) {
      case "📚 Каталог":
        return showCategories(chat_id, null);
      case "🔍 Поиск":
        await setState(from.id, { mode: "search" });
        await tg("sendMessage", {
          chat_id,
          text: "Напишите название или ключевое слово:",
        });
        return;
      case "🛒 Корзина":
        return showCart(chat_id, from.id);
      case "📋 Мои заказы":
        return showMyOrders(chat_id, from.id);
    }

    // Fallback
    await sendMain(chat_id);
  } catch (e: any) {
    console.error("[bot] handleUpdate error", e);
  }
}