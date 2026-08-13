import { tg, downloadTelegramFile } from "./telegram.server";
import { convertAmount } from "./currency.server";

type BotUser = {
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  language_code: string | null;
  contact_phone: string | null;
  state: {
    mode?: string;
    pending_order_id?: number;
    country_code?: string;
    country_name?: string;
    last_search?: string;
    /** When true, attaching a payment receipt auto-delivers files (RU/KZ with Robokassa on). */
    proof_auto?: boolean;
  } | null;
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
    "https://tg-bot-ashen-one.vercel.app"
  ).replace(/\/$/, "");
}

function isCountryRF(countryCode?: string | null): boolean {
  if (!countryCode) return false;
  const code = countryCode.trim().toUpperCase();
  return code === "RU" || code === "RUS" || code === "РФ" || code === "РОССИЯ";
}

/** Countries that only pay by receipt with auto-delivery when Robokassa is on (no Robokassa link). */
function isProofAutoOnlyCountry(countryCode?: string | null): boolean {
  if (isCountryRF(countryCode)) return true;
  const code = (countryCode || "").trim().toUpperCase();
  return code === "BY" || code === "OTHER";
}

/** Robokassa: согласие + ссылки на оферту и политику (HTML для сообщений в чате). */
function legalConsentHtml(base: string): string {
  return (
    `Нажимая /start, вы соглашаетесь с:\n` +
    `• <a href="${base}/legal/offer">Условиями использования</a>\n` +
    `${base}/legal/offer\n` +
    `• <a href="${base}/legal/privacy">Политикой конфиденциальности</a>\n` +
    `${base}/legal/privacy`
  );
}

/** Текст профиля бота («Что умеет этот бот?») — plain text, лимит Telegram 512. */
export function botPublicDescription(base = originFromState()): string {
  const text =
    `📚 Каталог цифровых учебных материалов.\n` +
    `→ Выбор материалов и мгновенная выдача файлов после оплаты\n` +
    `→ Оплата картой / по реквизитам\n` +
    `→ Поддержка автора\n\n` +
    `Нажимая /start, вы соглашаетесь с:\n` +
    `• Условиями использования\n` +
    `${base}/legal/offer\n` +
    `• Политикой конфиденциальности\n` +
    `${base}/legal/privacy`;
  return text.slice(0, 512);
}

export async function syncBotPublicDescription() {
  const description = botPublicDescription();
  try {
    await tg("setMyDescription", { description });
    await tg("setMyShortDescription", {
      short_description: "Каталог материалов. Нажимая /start, вы принимаете оферту и политику конфиденциальности.".slice(
        0,
        120,
      ),
    });
  } catch (e) {
    console.error("[bot] setMyDescription failed", e);
  }
}

function welcomeStartHtml(firstName: string | null, withCountryHint: boolean): string {
  const base = originFromState();
  const name = firstName || "друг";
  const hint = withCountryHint
    ? `\n\nСначала выберите страну — или откройте «ℹ️ Информация».`
    : "";
  return (
    `Привет, ${escapeHtml(name)}! Добро пожаловать в магазин.\n\n` +
    `→ Каталог учебных материалов\n` +
    `→ Оплата и выдача файлов\n` +
    `→ Документы и реквизиты — в «ℹ️ Информация»\n\n` +
    legalConsentHtml(base) +
    hint
  );
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
  
  // 1. Try to get existing user
  const { data: existing } = await s
    .from("bot_users")
    .select("*")
    .eq("telegram_id", from.id)
    .maybeSingle();

  if (existing) {
    // 2. Update profile if changed (don't touch state)
    const { data: updated, error } = await s
      .from("bot_users")
      .update({
        username: from.username ?? existing.username,
        first_name: from.first_name ?? existing.first_name,
        last_name: from.last_name ?? existing.last_name,
        language_code: from.language_code ?? existing.language_code,
      })
      .eq("telegram_id", from.id)
      .select("*")
      .single();
    
    if (error) console.error("[bot] updateUser error", error);
    console.log(`[bot] upsertUser(tg_${from.id}): state in DB is ${JSON.stringify(existing.state)}`);
    return (updated || existing) as BotUser;
  }

  // 3. New user: insert
  const userKey = `tg_${from.id}`;
  const { data: inserted, error } = await s
    .from("bot_users")
    .insert({
      telegram_id: from.id,
      user_key: userKey,
      platform: "telegram",
      username: from.username ?? null,
      first_name: from.first_name ?? null,
      last_name: from.last_name ?? null,
      language_code: from.language_code ?? null,
      state: {},
    })
    .select("*")
    .single();

  if (error) {
    console.error("[bot] insertUser error", error);
  }

  return (inserted || {
    telegram_id: from.id,
    username: from.username ?? null,
    first_name: from.first_name ?? null,
    last_name: from.last_name ?? null,
    language_code: from.language_code ?? null,
    contact_phone: null,
    state: null,
  }) as BotUser;
}

async function setState(telegram_id: number, state: BotUser["state"]) {
  const s = await db();
  
  // Если в state нет country_code, попробуем сохранить старый из базы, чтобы не затереть
  if (state && !state.country_code) {
    const { data: existing } = await s
      .from("bot_users")
      .select("state")
      .eq("telegram_id", telegram_id)
      .maybeSingle();
    
    if (existing?.state?.country_code) {
      state.country_code = existing.state.country_code;
      state.country_name = existing.state.country_name;
    }
  }

  console.log(`[bot] setState(tg_${telegram_id}): saving state ${JSON.stringify(state)}`);
  // Обновляем по user_key если он существует, иначе по telegram_id (обратная совместимость)
  const userKey = `tg_${telegram_id}`;
  const { data: byKey } = await s.from("bot_users").select("user_key").eq("user_key", userKey).maybeSingle();
  if (byKey) {
    await s.from("bot_users").update({ state: state ?? {} }).eq("user_key", userKey);
  } else {
    await s.from("bot_users").update({ state: state ?? {} }).eq("telegram_id", telegram_id);
  }
}

async function setContact(telegram_id: number, phone: string) {
  const s = await db();
  const userKey = `tg_${telegram_id}`;
  const { data: byKey } = await s.from("bot_users").select("user_key").eq("user_key", userKey).maybeSingle();
  if (byKey) {
    await s.from("bot_users").update({ contact_phone: phone }).eq("user_key", userKey);
  } else {
    await s.from("bot_users").update({ contact_phone: phone }).eq("telegram_id", telegram_id);
  }
}

function mainMenu() {
  return {
    keyboard: [
      [{ text: "📚 Каталог" }, { text: "🔍 Поиск" }],
      [{ text: "🛒 Корзина" }, { text: "📋 Мои заказы" }],
      [{ text: "📖 Инструкция" }, { text: "ℹ️ Информация" }],
      [{ text: "💬 Связаться с автором" }],
    ],
    resize_keyboard: true,
  };
}

async function sendMain(chat_id: number, text = "Выберите раздел:", opts?: { parse_mode?: "HTML" }) {
  await tg("sendMessage", {
    chat_id,
    text,
    reply_markup: mainMenu(),
    disable_web_page_preview: true,
    ...(opts?.parse_mode ? { parse_mode: opts.parse_mode } : {}),
  });
}

function legalInlineKeyboard(base: string) {
  return {
    inline_keyboard: [
      [{ text: "📄 Условия использования", url: `${base}/legal/offer` }],
      [{ text: "🔒 Политика конфиденциальности", url: `${base}/legal/privacy` }],
    ],
  };
}

async function sendInstruction(chat_id: number) {
  const s = await db();
  const { data: rows } = await s
    .from("app_settings")
    .select("key, value")
    .in("key", ["instruction_video_path", "instruction_video_file_id", "instruction_caption"]);
  const get = (key: string) =>
    (rows?.find((r) => r.key === key)?.value as string | undefined)?.trim() || "";

  const caption =
    get("instruction_caption") ||
    "📖 Как пользоваться ботом: каталог → корзина → оплата → чек. Файлы придут после оплаты (картой или по чеку).";
  const fileId = get("instruction_video_file_id");
  const path = get("instruction_video_path");

  async function cacheFileId(newId: string) {
    if (!newId || newId === fileId) return;
    await s.from("app_settings").upsert({
      key: "instruction_video_file_id",
      value: newId,
      updated_at: new Date().toISOString(),
    });
  }

  function extractVideoFileId(result: unknown): string | null {
    const r = result as { video?: { file_id?: string }; document?: { file_id?: string } } | undefined;
    return r?.video?.file_id || r?.document?.file_id || null;
  }

  if (fileId) {
    const res = await tg("sendVideo", { chat_id, video: fileId, caption });
    if (res?.ok) return;
    // stale file_id — fall through to re-upload
  }

  if (!path) {
    await tg("sendMessage", {
      chat_id,
      text:
        "📖 Инструкция скоро появится.\nПока: «Каталог» или «Поиск» → корзина → оплата → чек или Robokassa. Файлы придут после оплаты.",
      reply_markup: mainMenu(),
    });
    return;
  }

  const { data: pub } = s.storage.from("instruction-videos").getPublicUrl(path);
  const publicUrl = pub?.publicUrl;
  if (publicUrl) {
    const res = await tg("sendVideo", { chat_id, video: publicUrl, caption });
    if (res?.ok) {
      const id = extractVideoFileId(res.result);
      if (id) await cacheFileId(id);
      return;
    }
  }

  const { data: blob, error } = await s.storage.from("instruction-videos").download(path);
  if (error || !blob) {
    await tg("sendMessage", {
      chat_id,
      text: "⚠️ Не удалось загрузить видео инструкции. Напишите продавцу.",
      reply_markup: mainMenu(),
    });
    return;
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const filename = path.split("/").pop() || "instruction.mp4";
  const { tgSendMultipart } = await import("./telegram.server");
  const res = await tgSendMultipart(
    "sendVideo",
    { chat_id, caption },
    {
      field: "video",
      filename,
      bytes,
      contentType: blob.type || "video/mp4",
    },
  );
  if (res?.ok) {
    const id = extractVideoFileId(res.result);
    if (id) await cacheFileId(id);
    return;
  }

  // Fallback as document
  const doc = await tgSendMultipart(
    "sendDocument",
    { chat_id, caption },
    {
      field: "document",
      filename,
      bytes,
      contentType: blob.type || "video/mp4",
    },
  );
  if (doc?.ok) {
    const id = extractVideoFileId(doc.result);
    if (id) await cacheFileId(id);
    return;
  }

  await tg("sendMessage", {
    chat_id,
    text: caption,
    reply_markup: mainMenu(),
  });
}

async function showCategories(chat_id: number, parentId: string | null, userCountryCode?: string, offset = 0) {
  const s = await db();
  const q = s
    .from("categories")
    .select("id, name")
    .eq("is_visible", true)
    .order("sort_order")
    .order("name");
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

/**
 * Сквозной номер заказа в пределах одного бота — то, что видит покупатель.
 * Внутренний orders.id остаётся глобальным (FK, callback_data, InvId Robokassa),
 * поэтому показывать его нельзя: у разных клиентов номера шли бы вперемешку.
 */
async function displayNoFor(orderId: number): Promise<number> {
  const s = await db();
  const { data } = await s.from("orders").select("order_no").eq("id", orderId).maybeSingle();
  return ((data as any)?.order_no as number) ?? orderId;
}

async function sendCoverPreviews(adminChatId: string, displayNo: number, coverUrls: string[]) {
  if (coverUrls.length === 0) return;
  const shortCaption = `📦 <b>Материалы заказа #${displayNo}</b> (${coverUrls.length} шт.)`;
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
      console.error(`[bot] cover preview batch failed for order #${displayNo}`, err);
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

  // Prevent duplicate double-clicks
  if (user.state.mode === "placing_order") return;
  await setState(telegram_id, { ...user.state, mode: "placing_order" });

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

function materialsForProduct(
  product: any,
  lang: "ru" | "kz",
): Array<{ file_path?: string; file_name?: string | null; url?: string }> {
  const rows = ((product?.product_material_files as any[]) || [])
    .filter((file) => file.language === lang)
    .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0))
    .map((file) => ({ file_path: file.file_path as string, file_name: (file.file_name as string) ?? null }));
  if (rows.length) return rows;
  const legacyUrl = lang === "ru" ? product?.file_url : product?.file_url_kz;
  const legacyPath = lang === "ru" ? product?.file_path : product?.file_path_kz;
  const legacyName = lang === "ru" ? product?.file_name : product?.file_name_kz;
  if (legacyUrl) return [{ url: legacyUrl }];
  if (legacyPath) return [{ file_path: legacyPath, file_name: legacyName ?? null }];
  return [];
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
    .select("id, quantity, products(id, name, price, currency, file_path, file_name, file_path_kz, file_name_kz, file_url, file_url_kz, country_prices, product_material_files(language, file_path, file_name, sort_order))")
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
      
      const materialsRu = materialsForProduct(it.products, "ru");
      const materialsKz = materialsForProduct(it.products, "kz");
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
        file_url_snapshot: it.products?.file_url ?? null,
        file_url_kz_snapshot: it.products?.file_url_kz ?? null,
        material_files_snapshot: materialsRu.map((material) => ({
          path: material.file_path ?? null,
          name: material.file_name ?? null,
          url: material.url ?? null,
        })),
        material_files_kz_snapshot: materialsKz.map((material) => ({
          path: material.file_path ?? null,
          name: material.file_name ?? null,
          url: material.url ?? null,
        })),
      };
    }),
  );
  await s.from("order_items").insert(rows);
  await s.from("cart_items").delete().eq("telegram_id", telegram_id);

  const rk = await loadRobokassaSettings();
  const cc = String(method?.country_code ?? country_code ?? "").toUpperCase();
  const instructions = (method?.instructions as string) || "Свяжитесь с продавцом для уточнения реквизитов.";

  // Robokassa off (or misconfigured) → all countries: receipt + manual admin confirm
  if (!rk.ready) {
    await startManualProofPath({
      chat_id,
      telegram_id,
      userState: user.state,
      orderId: order.id as number,
      displayNo: ((order as any).order_no ?? order.id) as number,
      total,
      currency,
      instructions,
      autoDeliver: false,
    });
    return;
  }

  // Robokassa on + RU/BY/OTHER → receipt with auto-delivery (no Robokassa)
  if (isProofAutoOnlyCountry(cc)) {
    await startManualProofPath({
      chat_id,
      telegram_id,
      userState: user.state,
      orderId: order.id as number,
      displayNo: ((order as any).order_no ?? order.id) as number,
      total,
      currency,
      instructions,
      autoDeliver: true,
    });
    return;
  }

  // Robokassa on + KZ → choose Robokassa or receipt (auto-delivery)
  if (cc === "KZ") {
    await sendKzPaymentChoice({
      chat_id,
      telegram_id,
      userState: user.state,
      orderId: order.id as number,
      displayNo: ((order as any).order_no ?? order.id) as number,
      total,
      currency,
    });
    return;
  }

  // Robokassa on + other countries → Robokassa only
  await sendRobokassaPayLink({
    chat_id,
    telegram_id,
    userState: user.state,
    orderId: order.id as number,
    displayNo: ((order as any).order_no ?? order.id) as number,
    total,
    currency,
    rk,
  });
}

/** Re-send payment instructions for a stuck awaiting_payment order (admin nudge). */
export async function remindOrderPayment(orderId: number) {
  const s = await db();
  const { data: order, error } = await s
    .from("orders")
    .select("id, order_no, telegram_id, status, total, currency, country_code, country_name")
    .eq("id", orderId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!order) throw new Error("Заказ не найден");
  if (order.status !== "awaiting_payment") {
    throw new Error(`Напомнить можно только заказам «Ждёт оплаты» (сейчас: ${order.status})`);
  }

  const telegram_id = Number(order.telegram_id);
  const chat_id = telegram_id;
  const { data: botUser } = await s.from("bot_users").select("*").eq("telegram_id", telegram_id).maybeSingle();
  const userState = (botUser?.state as BotUser["state"]) ?? {};

  const cc = String(order.country_code ?? "").toUpperCase();
  const { data: method } = await s.from("payment_methods").select("*").eq("country_code", cc || "OTHER").maybeSingle();
  const instructions =
    (method?.instructions as string) ||
    "Свяжитесь с продавцом для уточнения реквизитов.";
  const total = Number(order.total);
  const currency = (order.currency as string) || (method?.currency as string) || "USD";

  await tg("sendMessage", {
    chat_id,
    text:
      `🔔 <b>Напоминание по заказу #${(order as any).order_no ?? orderId}</b>\n\n` +
      `Заказ ещё ожидает оплаты (${formatMoney(total, currency)}).\n` +
      `Ниже — актуальный способ оплаты. Если уже платили — пришлите чек в этот чат.`,
    parse_mode: "HTML",
    reply_markup: mainMenu(),
  });

  const rk = await loadRobokassaSettings();

  if (!rk.ready) {
    await startManualProofPath({
      chat_id,
      telegram_id,
      userState,
      orderId,
      displayNo: (order as any).order_no ?? orderId,
      total,
      currency,
      instructions,
      autoDeliver: false,
      reminder: true,
    });
    return { ok: true as const };
  }

  if (isProofAutoOnlyCountry(cc)) {
    await startManualProofPath({
      chat_id,
      telegram_id,
      userState,
      orderId,
      displayNo: (order as any).order_no ?? orderId,
      total,
      currency,
      instructions,
      autoDeliver: true,
      reminder: true,
    });
    return { ok: true as const };
  }

  if (cc === "KZ") {
    await sendKzPaymentChoice({
      chat_id,
      telegram_id,
      userState,
      orderId,
      displayNo: (order as any).order_no ?? orderId,
      total,
      currency,
      reminder: true,
    });
    return { ok: true as const };
  }

  await sendRobokassaPayLink({
    chat_id,
    telegram_id,
    displayNo: (order as any).order_no ?? orderId,
    userState,
    orderId,
    total,
    currency,
    rk,
    reminder: true,
  });
  return { ok: true as const };
}

async function sendKzPaymentChoice(params: {
  chat_id: number;
  telegram_id: number;
  userState: BotUser["state"];
  orderId: number;
  displayNo: number;
  total: number;
  currency: string;
  reminder?: boolean;
}) {
  await setState(params.telegram_id, {
    ...params.userState,
    mode: "choose_pay",
    pending_order_id: params.orderId,
    proof_auto: false,
  });
  const title = params.reminder
    ? `🔔 <b>Заказ #${params.displayNo}</b> — выберите способ оплаты`
    : `🧾 <b>Заказ #${params.displayNo}</b> создан.`;
  await tg("sendMessage", {
    chat_id: params.chat_id,
    text:
      `${title}\n\n` +
      `Сумма к оплате: <b>${formatMoney(params.total, params.currency)}</b>\n\n` +
      `Выберите способ оплаты:\n` +
      `• <b>Robokassa</b> — оплата картой, файлы придут сразу после оплаты\n` +
      `• <b>По реквизитам</b> — перевод вручную, пришлите чек — файлы придут сразу`,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "💳 Оплатить через Robokassa", callback_data: `pay:rk:${params.orderId}` }],
        [{ text: "🧾 Оплатить по реквизитам", callback_data: `pay:manual:${params.orderId}` }],
      ],
    },
  });
}

async function loadRobokassaSettings() {
  const s = await db();
  const { data: allSettings } = await s.from("app_settings").select("key, value");
  const getSetting = (key: string) => allSettings?.find((r) => r.key === key)?.value;
  const enabled = getSetting("robokassa_enabled") === "true";
  const testMode = getSetting("robokassa_test_mode") === "true";
  const login = getSetting("robokassa_login")?.trim() || "";
  const pass1 = (testMode ? getSetting("robokassa_pass1_test") : getSetting("robokassa_pass1"))?.trim() || "";
  return { enabled, testMode, login, pass1, ready: enabled && Boolean(login && pass1) };
}

async function sendRobokassaPayLink(params: {
  chat_id: number;
  telegram_id: number;
  userState: BotUser["state"];
  orderId: number;
  displayNo: number;
  total: number;
  currency: string;
  rk: Awaited<ReturnType<typeof loadRobokassaSettings>>;
  reminder?: boolean;
}) {
  const { buildRobokassaPaymentUrl } = await import("./robokassa.server");
  const outSum = Number(params.total).toFixed(2);
  const paymentUrl = buildRobokassaPaymentUrl({
    login: params.rk.login,
    pass1: params.rk.pass1,
    outSum,
    invId: params.orderId,
    description: `Заказ #${params.displayNo}`,
    isTest: params.rk.testMode,
  });

  await setState(params.telegram_id, {
    ...params.userState,
    mode: "awaiting_payment",
    pending_order_id: params.orderId,
    proof_auto: false,
  });
  const title = params.reminder
    ? `🔔 <b>Заказ #${params.displayNo}</b> — оплата`
    : `🧾 <b>Заказ #${params.displayNo}</b>`;
  await tg("sendMessage", {
    chat_id: params.chat_id,
    text:
      `${title}\n\n` +
      `Сумма к оплате: <b>${formatMoney(params.total, params.currency)}</b>\n\n` +
      `Нажмите кнопку ниже для оплаты через Robokassa — после оплаты файлы придут автоматически.`,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[{ text: "💳 Оплатить через Robokassa", url: paymentUrl }]],
    },
  });
}

async function startManualProofPath(params: {
  chat_id: number;
  telegram_id: number;
  userState: BotUser["state"];
  orderId: number;
  displayNo: number;
  total: number;
  currency: string;
  instructions: string;
  autoDeliver: boolean;
  reminder?: boolean;
}) {
  const s = await db();
  if (params.autoDeliver) {
    await s.from("orders").update({ admin_note: "proof_auto" }).eq("id", params.orderId);
  }

  await setState(params.telegram_id, {
    ...params.userState,
    mode: "awaiting_proof",
    pending_order_id: params.orderId,
    proof_auto: params.autoDeliver,
  });

  const afterProof = params.autoDeliver
    ? `После оплаты <b>пришлите чек</b> (фото или PDF) в этот чат — бот сразу отправит файлы.`
    : `После оплаты <b>пришлите скриншот</b> (фото) в этот чат — продавец проверит и пришлёт файлы.`;

  const title = params.reminder
    ? `🔔 <b>Заказ #${params.displayNo}</b> — оплата по реквизитам`
    : `🧾 <b>Заказ #${params.displayNo}</b> создан.`;

  await tg("sendMessage", {
    chat_id: params.chat_id,
    text:
      `${title}\n\n` +
      `Сумма к оплате: <b>${formatMoney(params.total, params.currency)}</b>\n\n` +
      `${params.instructions}\n\n` +
      afterProof,
    parse_mode: "HTML",
  });
}

async function notifyAdminNewOrder(
  orderId: number,
  proofFileId: string | null,
  proofKind: "photo" | "document" | null,
  options?: { autoDelivered?: boolean; reviewReason?: string },
) {
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
  // Покупателю и админу показывается сквозной номер этого бота, а не глобальный
  // id (id остаётся во внутренних ссылках, callback_data и InvId Robokassa).
  const displayNo = (order as any).order_no ?? order.id;
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

  const autoDelivered = Boolean(options?.autoDelivered);
  const reviewReason = options?.reviewReason?.trim();
  const summaryText =
    (autoDelivered
      ? `🆕 <b>Заказ #${displayNo}</b> — автовыдача по чеку\n\n`
      : reviewReason
        ? `🆕 <b>Заказ #${displayNo}</b> — нужна проверка чека\n\n`
        : `🆕 <b>Новый заказ #${displayNo}</b>\n\n`) +
    `👤 ${escapeHtml(order.display_name as string)}${order.username ? ` (@${escapeHtml(order.username)})` : ""}
📞 ${escapeHtml((order.contact as string) || "—")}
🌍 ${escapeHtml((order.country_name as string) || "—")}
📦 Позиций: ${items.length}

💰 <b>Итого: ${order.total} ${order.currency}</b>` +
    (autoDelivered
      ? `\n\n⚡ Файлы выданы автоматически после проверки чека (OCR).`
      : reviewReason
        ? `\n\n⚠️ <b>Причина:</b> ${escapeHtml(reviewReason)}`
        : "");

  const itemsMessage =
    items.length > 0
      ? `📋 <b>Состав заказа #${displayNo}</b>\n\n${items.map((i) => `• ${escapeHtml(i.name_snapshot)} × ${i.quantity} — ${i.price_snapshot} ${order.currency}`).join("\n")}`
      : "";

  const reply_markup = autoDelivered
    ? undefined
    : {
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
        ...(reply_markup ? { reply_markup } : {}),
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
    const proofCaption = `🧾 <b>Чек оплаты — заказ #${displayNo}</b>`;
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
      await sendCoverPreviews(adminChatId, displayNo as number, coverUrls);
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
    .select("id, order_no, status, total, currency, created_at")
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
        `#${o.order_no ?? o.id} — ${o.total} ${o.currency} — ${statusMap[o.status as string] || o.status}`,
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
      if (!user) return;
      
      // Before allowing navigation, require country code
      if (
        !data.startsWith("setcountry:") &&
        !data.startsWith("confirm:") &&
        !data.startsWith("reject:") &&
        !data.startsWith("pay:") &&
        data !== "clear" &&
        !data.startsWith("rem:") &&
        !data.startsWith("add:") &&
        !data.startsWith("lang_ru:") &&
        !data.startsWith("lang_kz:") &&
        !data.startsWith("searchmore:") &&
        !data.startsWith("prod:")
      ) {
        if (!user.state?.country_code) {
          await askCountry(chat_id, from_id);
          return;
        }
      }

      if (data.startsWith("pay:rk:") || data.startsWith("pay:manual:")) {
        const isRk = data.startsWith("pay:rk:");
        const orderId = Number(data.slice(isRk ? 7 : 11));
        if (!orderId) return;

        const s = await db();
        const { data: order } = await s
          .from("orders")
          .select("id, telegram_id, status, total, currency, country_code")
          .eq("id", orderId)
          .maybeSingle();
        if (!order || Number(order.telegram_id) !== Number(from_id)) {
          await tg("sendMessage", { chat_id, text: "Заказ не найден." });
          return;
        }
        if (order.status !== "awaiting_payment") {
          await tg("sendMessage", { chat_id, text: `Заказ #${orderId} уже обрабатывается или закрыт.` });
          return;
        }

        if (cq.message?.message_id) {
          await tg("editMessageReplyMarkup", {
            chat_id,
            message_id: cq.message.message_id,
            reply_markup: { inline_keyboard: [] },
          }).catch(() => {});
        }

        if (isRk) {
          const rk = await loadRobokassaSettings();
          if (!rk.ready) {
            await tg("sendMessage", { chat_id, text: "Robokassa временно недоступна. Выберите оплату по реквизитам." });
            return;
          }
          await sendRobokassaPayLink({
            chat_id,
            telegram_id: from_id,
            userState: user.state,
            orderId,
      displayNo: (order as any).order_no ?? orderId,
            total: Number(order.total),
            currency: (order.currency as string) || "KZT",
            rk,
          });
          return;
        }

        const { data: method } = await s
          .from("payment_methods")
          .select("instructions")
          .eq("country_code", order.country_code || "KZ")
          .maybeSingle();
        await startManualProofPath({
          chat_id,
          telegram_id: from_id,
          userState: user.state,
          orderId,
      displayNo: (order as any).order_no ?? orderId,
          total: Number(order.total),
          currency: (order.currency as string) || "KZT",
          instructions: (method?.instructions as string) || "Свяжитесь с продавцом для уточнения реквизитов.",
          autoDeliver: true,
        });
        return;
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
        await s.from("cart_items").delete().eq("id", data.slice(4)).eq("telegram_id", from_id);
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
        
        // Security: verify the order belongs to the user clicking the button
        if (order.telegram_id !== from_id) {
          await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "⛔ Доступ запрещён." });
          return;
        }

        // Sort items to match server delivery index logic
        const items = ((order.order_items as any[]) || []).slice().sort((a, b) => {
          const ai = String(a.id || "");
          const bi = String(b.id || "");
          return ai < bi ? -1 : ai > bi ? 1 : 0;
        });

        const item = items[idx];
        if (!item) return;

        // Check if this language was already delivered
        if (item.delivered_language === lang || item.delivered_language === "both") {
          await tg("sendMessage", { chat_id, text: "⚠️ Этот файл уже был отправлен." });
          return;
        }

        const { sendMaterialsToUser } = await import("./orders.server");
        const snapshot = lang === "ru" ? item.material_files_snapshot : item.material_files_kz_snapshot;
        const legacyPath = lang === "ru" ? item.file_path_snapshot : item.file_path_kz_snapshot;
        const legacyName = lang === "ru" ? item.file_name_snapshot : item.file_name_kz_snapshot;
        const legacyUrl = lang === "ru" ? item.file_url_snapshot : item.file_url_kz_snapshot;
        const materials = Array.isArray(snapshot) && snapshot.length
          ? snapshot
          : legacyUrl
            ? [{ url: legacyUrl }]
            : legacyPath
              ? [{ path: legacyPath, name: legacyName }]
              : [];

        await tg("sendMessage", { chat_id, text: `⏳ Загружаю файлы (${lang === "ru" ? "Русский" : "Қазақша"})...` });
        await sendMaterialsToUser(order.telegram_id, materials, item.name_snapshot, 1);

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
        // Админу показываем сквозной номер этого бота, а не внутренний id.
        const { data: ordRow } = await (await db())
          .from("orders").select("order_no").eq("id", orderId).maybeSingle();
        const shownNo = (ordRow as any)?.order_no ?? orderId;
        await tg("sendMessage", { chat_id, text: `⏳ Выдаю заказ #${shownNo}...` });
        const { deliverOrder } = await import("./orders.server");
        try {
          const result = await deliverOrder(orderId);
          if (result.alreadyDelivered) {
            await tg("sendMessage", { chat_id, text: `ℹ️ Заказ #${shownNo} уже выдаётся или выдан.` });
          } else {
            await tg("sendMessage", { chat_id, text: `✅ Заказ #${shownNo} выдан.` });
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
    if (!user) return;

    // /start - special: also detect if sender is the admin and offer to bind
    if (msg.text === "/start") {
      await setState(from.id, { ...user.state, mode: "idle" });
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

      const base = originFromState();
      const needCountry = !user.state?.country_code;
      await tg("sendMessage", {
        chat_id,
        text: welcomeStartHtml(user.first_name, needCountry),
        parse_mode: "HTML",
        reply_markup: legalInlineKeyboard(base),
        disable_web_page_preview: true,
      });
      await sendMain(chat_id, "Выберите раздел:");
      if (needCountry) {
        await askCountry(chat_id, from.id);
      }
      // Keep BotFather profile text in sync (Robokassa / «Что умеет этот бот?»)
      void syncBotPublicDescription();
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
      if (["📚 Каталог", "🔍 Поиск", "🛒 Корзина", "📋 Мои заказы", "📖 Инструкция", "ℹ️ Информация"].includes(msg.text)) {
        await setState(from.id, { ...user.state, mode: "idle" });
        // Fallthrough to the main menu switch below
      } else {
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
    }

    // Payment proof (photo OR document).
    // Robokassa sets mode=awaiting_payment; manual path uses awaiting_proof.
    // Accept receipts in both modes, and for any open awaiting_payment order.
    const proofModes = new Set(["awaiting_proof", "awaiting_payment"]);
    let proofOrderId: number | undefined =
      proofModes.has(String(user.state?.mode || "")) && user.state?.pending_order_id
        ? Number(user.state.pending_order_id)
        : undefined;

    if (!proofOrderId && (msg.photo || msg.document)) {
      const s = await db();
      const { data: openOrder } = await s
        .from("orders")
        .select("id")
        .eq("telegram_id", from.id)
        .eq("status", "awaiting_payment")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (openOrder?.id) proofOrderId = Number(openOrder.id);
    }

    if (user.state?.mode === "awaiting_proof" && user.state.pending_order_id && !msg.photo && !msg.document) {
      if (msg.text && ["📚 Каталог", "🔍 Поиск", "🛒 Корзина", "📋 Мои заказы", "📖 Инструкция", "ℹ️ Информация"].includes(msg.text)) {
        await setState(from.id, { ...user.state, mode: "idle" });
        // Fallthrough to the main menu switch below
      } else {
        await tg("sendMessage", {
          chat_id,
          text: "📨 Пришлите, пожалуйста, чек об оплате — фото или файл (например, PDF).",
        });
        return;
      }
    }

    if (proofOrderId && (msg.photo || msg.document)) {
      const orderId = proofOrderId;

      const sOrder = await db();
      const { data: orderRow } = await sOrder
        .from("orders")
        .select("id, status, admin_note, country_code, telegram_id, total, currency")
        .eq("id", orderId)
        .maybeSingle();

      if (!orderRow || Number(orderRow.telegram_id) !== Number(from.id)) {
        await tg("sendMessage", { chat_id, text: "Заказ не найден." });
        return;
      }
      if (orderRow.status === "delivered" || orderRow.status === "rejected" || orderRow.status === "delivering") {
        await tg("sendMessage", {
          chat_id,
          text: `Заказ #${orderId} уже обрабатывается или закрыт.`,
          reply_markup: mainMenu(),
        });
        return;
      }

      const note = String(orderRow.admin_note || "");
      const autoDeliver =
        user.state?.proof_auto === true || note === "proof_auto" || note.startsWith("proof_auto");

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

      // Сохраняем чек в storage.
      // Даже если storage недоступен — пересылаем file_id админу, чтобы чек не потерялся.
      let proofSaved = false;
      let proofPath: string | null = null;
      const { supabaseAdmin } = await import("@/integrations-supabase/client.server");
      if (dl) {
        try {
          const { data: buckets } = await supabaseAdmin.storage.listBuckets();
          if (!buckets?.some((b) => b.name === "payment-proofs")) {
            await supabaseAdmin.storage.createBucket("payment-proofs", {
              public: false,
              fileSizeLimit: 20 * 1024 * 1024,
            });
          }
        } catch (e) {
          console.error("[bot] ensure payment-proofs bucket", e);
        }

        const key = `order-${orderId}/${Date.now()}.${fileExt}`;
        const body = new Blob([dl.bytes as BlobPart], { type: dl.mime || "application/octet-stream" });
        const upRes = await supabaseAdmin.storage.from("payment-proofs").upload(key, body, {
          contentType: dl.mime || "application/octet-stream",
          upsert: true,
        });
        if (!upRes.error) {
          proofPath = key;
          proofSaved = true;
        } else {
          console.error("[bot] payment-proofs upload failed", upRes.error);
        }
      } else {
        console.error("[bot] failed to download proof from Telegram", { orderId, proofKind });
      }

      if (autoDeliver) {
        // OCR check before auto-delivery
        if (!dl) {
          await setState(from.id, {
            ...user.state,
            mode: "awaiting_proof",
            pending_order_id: orderId,
            proof_auto: true,
          });
          await tg("sendMessage", {
            chat_id,
            text: "⚠️ Не удалось загрузить файл. Пришлите чек ещё раз — фото или PDF.",
          });
          return;
        }

        const { verifyPaymentReceipt } = await import("./receipt-verify.server");
        const verify = await verifyPaymentReceipt({
          bytes: dl.bytes,
          mime: dl.mime || (fileExt === "pdf" ? "application/pdf" : "image/jpeg"),
          expectedAmount: Number(orderRow.total),
          currency: (orderRow.currency as string) || undefined,
        });

        if (!verify.ok && verify.reason === "not_receipt") {
          // Keep order open; ask for a real receipt
          await setState(from.id, {
            ...user.state,
            mode: "awaiting_proof",
            pending_order_id: orderId,
            proof_auto: true,
          });
          if (proofPath) {
            await supabaseAdmin
              .from("orders")
              .update({
                payment_proof_path: proofPath,
                admin_note: note.startsWith("proof_auto") ? note : "proof_auto",
                status: "awaiting_payment",
              })
              .eq("id", orderId);
          }
          await tg("sendMessage", {
            chat_id,
            text:
              `⚠️ Это не похоже на чек оплаты.\n\n` +
              `Пришлите, пожалуйста, скриншот перевода / чека с суммой заказа #${orderId}.`,
          });
          return;
        }

        if (!verify.ok) {
          // amount_mismatch or ocr_unavailable → manual review
          await setState(from.id, {
            ...user.state,
            mode: "idle",
            pending_order_id: undefined,
            proof_auto: false,
          });
          await supabaseAdmin
            .from("orders")
            .update({
              status: "awaiting_confirmation",
              admin_note: `proof_auto; OCR: ${verify.detail}`.slice(0, 500),
              ...(proofPath ? { payment_proof_path: proofPath } : {}),
            })
            .eq("id", orderId);

          await tg("sendMessage", {
            chat_id,
            text:
              `📨 Чек получен по заказу #${orderId}, но автоматическая проверка не прошла.\n` +
              `Заказ отправлен продавцу на ручную проверку — файлы придут после подтверждения.`,
            reply_markup: mainMenu(),
          });
          await notifyAdminNewOrder(orderId, proofFileId, proofKind, {
            reviewReason: verify.detail,
          });
          return;
        }

        await setState(from.id, {
          ...user.state,
          mode: "idle",
          pending_order_id: undefined,
          proof_auto: false,
        });

        await supabaseAdmin
          .from("orders")
          .update({
            status: "awaiting_payment",
            admin_note: `proof_auto; OCR ok amount=${verify.matchedAmount}`,
            ...(proofPath ? { payment_proof_path: proofPath } : {}),
          })
          .eq("id", orderId);

        await tg("sendMessage", {
          chat_id,
          text: `📨 Спасибо! Чек проверен. Заказ #${orderId} — отправляю файлы…`,
          reply_markup: mainMenu(),
        });

        try {
          const { deliverOrder } = await import("./orders.server");
          await deliverOrder(orderId);
          await notifyAdminNewOrder(orderId, proofFileId, proofKind, { autoDelivered: true });
        } catch (e: any) {
          console.error("[bot] auto-deliver after proof failed", orderId, e);
          await supabaseAdmin
            .from("orders")
            .update({ status: "awaiting_confirmation" })
            .eq("id", orderId);
          await tg("sendMessage", {
            chat_id,
            text: `⚠️ Чек принят, но автоматическая выдача заказа #${orderId} не завершилась. Продавец проверит и отправит файлы.`,
          });
          await notifyAdminNewOrder(orderId, proofFileId, proofKind, {
            reviewReason: "Ошибка выдачи после успешного OCR",
          });
        }
        return;
      }

      await setState(from.id, {
        ...user.state,
        mode: "idle",
        pending_order_id: undefined,
        proof_auto: false,
      });

      // Manual path: await seller confirmation
      if (proofSaved && proofPath) {
        await supabaseAdmin
          .from("orders")
          .update({ payment_proof_path: proofPath, status: "awaiting_confirmation" })
          .eq("id", orderId);
      } else {
        await supabaseAdmin.from("orders").update({ status: "awaiting_confirmation" }).eq("id", orderId);
      }

      if (proofSaved || proofFileId) {
        await tg("sendMessage", {
          chat_id,
          text: proofSaved
            ? `📨 Спасибо! Чек получен. Заказ #${orderId} отправлен на проверку. Как только продавец подтвердит оплату — бот пришлёт файлы.`
            : `📨 Чек получен и переслан продавцу. Заказ #${orderId} на проверке. Если нужно — можно отправить чек ещё раз.`,
          reply_markup: mainMenu(),
        });
        await notifyAdminNewOrder(orderId, proofFileId, proofKind);
      } else {
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
      case "📖 Инструкция":
        return sendInstruction(chat_id);
      case "ℹ️ Информация": {
        const base = originFromState();
        await tg("sendMessage", {
          chat_id,
          text:
            `ℹ️ <b>Информация о магазине</b>\n\n` +
            `Обязательные документы и реквизиты (требование платёжных систем):\n\n` +
            legalConsentHtml(base),
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "📄 Условия использования (оферта)", url: `${base}/legal/offer` }],
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