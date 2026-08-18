import {
  sendZernioInboxMessage,
  replyToInstagramComment,
  sendInstagramPrivateReply,
  type ZernioDmButton,
} from "./zernio.server";
import crypto from "node:crypto";
import type { Json, TablesUpdate } from "@/integrations-supabase/types";

async function db() {
  const { supabaseAdmin } = await import("@/integrations-supabase/client.server");
  return supabaseAdmin;
}

// The legacy cart/order schema uses bot_users.telegram_id as its customer key.
// Reserve negative, deterministic IDs for Instagram so a Direct customer can
// safely use the same cart and order tables without colliding with Telegram.
function instagramCustomerId(userKey: string): number {
  const hex = crypto.createHash("sha256").update(userKey).digest("hex").slice(0, 13);
  return -parseInt(hex, 16);
}

/**
 * Ответ покупателю в Direct.
 *
 * Все ответы бота идут через эту точку, а не напрямую в sendZernioInboxMessage,
 * ровно по одной причине: два одинаковых сообщения подряд отправляться не
 * должны (см. sendDirectReply). В живой переписке человек получил «Корзина
 * пуста» дважды и «Передал ваш вопрос продавцу» дважды — четыре сообщения, из
 * которых половина была дословным повтором.
 */
async function reply(
  user: { user_key: string },
  conversationId: string,
  accountId: string,
  text: string,
  buttons?: ZernioDmButton[],
) {
  const flow = await import("./direct-purchase.server");
  return flow.sendDirectReply({
    conversationId,
    accountId,
    userKey: user.user_key,
    text,
    buttons,
  });
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
      // `metadata` в базе — jsonb, то есть с точки зрения типов это Json:
      // строка, число и массив там столь же допустимы, как объект. Разворачивать
      // спредом можно только объект, поэтому всё остальное (включая null и
      // случайно записанный скаляр) считаем «накопленного нет» и начинаем с
      // пустого — иначе на такой строке падал бы весь разбор входящего сообщения.
      const prev = existing.metadata;
      const base = prev && typeof prev === "object" && !Array.isArray(prev) ? prev : {};
      updates.metadata = { ...base, ...metadata };
    }

    await s.from("bot_users").update(updates).eq("user_key", userKey);
    return { ...existing, ...updates };
  }

  const newUser = {
    telegram_id: instagramCustomerId(userKey),
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
  const { parseZernioMessage } = await import("./zernio-message");
  const {
    conversationId,
    accountId,
    userKey,
    senderUsername,
    senderName,
    text,
    metadata,
    postbackPayload,
  } = parseZernioMessage(payload);

  if (!conversationId || !accountId) {
    console.warn("[zernio-bot] message.received missing conversationId or accountId:", payload);
    return;
  }

  const s = await db();

  /**
   * Все настройки автоответчика — одним запросом.
   *
   * Их было три подряд, каждая за своим ключом, и на каждое входящее сообщение
   * приходилось три обращения к базе вместо одного. Ключи лежат в одной
   * таблице у одного арендатора, так что выбрать их сразу ничего не стоит.
   */
  const { data: settingRows } = await s
    .from("app_settings")
    .select("key, value")
    .eq("bot_id", process.env.BOT_ID?.trim() || "")
    .in("key", [
      "instagram_direct_bot_enabled",
      "instagram_direct_bot_features",
      "instagram_direct_bot_scope",
      "instagram_direct_bot_script",
      "instagram_direct_bot_triggers",
    ]);

  const setting = (key: string) =>
    (settingRows ?? []).find((row) => row.key === key)?.value?.trim() || "";

  if (setting("instagram_direct_bot_enabled") === "false") {
    console.log("[zernio-bot] Direct assistant is disabled; event recorded without a reply");
    return;
  }

  let features = { catalog: true, search: true, cart: true, checkout: true };
  try {
    features = { ...features, ...JSON.parse(setting("instagram_direct_bot_features") || "{}") };
  } catch { /* defaults */ }

  /**
   * Область ответов. По умолчанию — только покупки.
   *
   * Отвечая, бот неизбежно помечает переписку прочитанной: управлять этим у
   * Instagram нельзя, в API такого нет. Для продавца это значило, что он
   * перестал видеть в приложении, кому нужно ответить, — приходилось смотреть
   * ник в админке и вручную искать человека в Instagram. Поэтому по обычной
   * переписке бот теперь молчит: непрочитанное остаётся непрочитанным.
   */
  const answersEverything = setting("instagram_direct_bot_scope") === "all";

  // Логируем сообщение
  console.log(`[zernio-bot] DM from ${userKey} (${senderUsername}): "${text}"`);

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

  /**
   * Пошаговая покупка. Стоит раньше всех прочих разборов: пока диалог на шаге
   * сценария, реплика покупателя — это ответ на заданный вопрос, а не команда
   * и не поисковый запрос. Раньше состояния не было вовсе, и «Казахстан» в
   * ответ на «из какой вы страны» уходило искать товар с таким названием.
   */
  // Чеком считаем только картинку или файл — см. pickReceiptAttachment: там же
  // и разбор того, почему голосовое сообщение чеком быть не должно.
  const { pickReceiptAttachment } = await import("./direct-flow");
  const attachmentUrl =
    pickReceiptAttachment(payload.message?.attachments as Array<{ url?: string; type?: string }>) ??
    undefined;

  /**
   * Пустое событие — не сообщение, и отвечать на него нечем.
   *
   * Instagram присылает эхо шаблонов: direction incoming, текста нет, вложение
   * типа template без ссылки и с пустыми elements. Таких событий в логах 513 из
   * 8265, и каждое доходило до разбора свободной реплики — то есть в режиме
   * «отвечать на всё» человек мог получить приветствие и «передал ваш вопрос
   * продавцу» с пустым вопросом, ни о чём никого не спросив.
   */
  if (!text.trim() && postbackPayload === null && !attachmentUrl) {
    console.log(`[zernio-bot] пустое событие от ${userKey} — отвечать нечем`);
    return;
  }

  /**
   * Человек попросил сам — значит ответ уйдёт, даже если он совпадёт с прошлым.
   *
   * Решается один раз здесь, а не в каждой отправке. Просьба — это кнопка,
   * команда, слово-вызов, номер товара, «убрать 018», присланный чек и ответ на
   * вопрос, который бот только что задал (то есть любой шаг сценария). Всё
   * остальное — обычная переписка, и в ней дословный повтор бота гасится.
   *
   * Появилось после живой проверки: на второй «/start» и на «Купить» бот
   * промолчал, потому что текст меню совпал с отправленным минуту назад.
   */
  const { readDirectState } = await import("./direct-purchase.server");
  const priorState = readDirectState(user.state);
  const {
    matchDirectCommand: asCommand,
    extractProductNumber,
    parseRemoveCommand: asRemoval,
    isCancel: asCancel,
  } = await import("./direct-flow");
  const askedForSomething =
    postbackPayload !== null ||
    Boolean(attachmentUrl) ||
    Boolean(priorState.mode) ||
    asCommand(text) !== null ||
    extractProductNumber(text) !== null ||
    asRemoval(text) !== null ||
    asCancel(text) ||
    parseTriggerWords(setting("instagram_direct_bot_triggers")).includes(
      lower.trim().replace(/[.!?]+$/, ""),
    );

  if (askedForSomething) {
    const { markExplicitRequest } = await import("./zernio-event-context.server");
    markExplicitRequest();
  }

  const handledByFlow = await handlePurchaseFlow({
    conversationId,
    accountId,
    user,
    text,
    attachmentUrl,
    answersEverything,
  });
  if (handledByFlow) return;

  /**
   * Нажатие кнопки обрабатывается всегда, в любом режиме.
   *
   * Кнопка в DM появляется только потому, что её отправили мы — в
   * автоматизации воронки или в ответе бота. Человек по ней осознанно
   * постучался: это самый однозначный сигнал «хочу к боту», какой вообще
   * бывает, и путать его с обычной перепиской невозможно. Раньше проверка
   * режима стояла выше этого блока, и в тихом режиме кнопки молчали.
   */
  if (postbackPayload !== null) {
    console.log(`[zernio-bot] postback from ${userKey}: "${postbackPayload}"`);
    if (postbackPayload.startsWith("BUY:")) {
      await addProductToCart(conversationId, accountId, user, postbackPayload.slice(4));
      return;
    }
    if (features.cart && postbackPayload === "CART") {
      await sendCart(conversationId, accountId, user);
      return;
    }
    if (features.checkout && postbackPayload === "CHECKOUT") {
      await startInstagramCheckout(conversationId, accountId, user);
      return;
    }
    if (features.catalog && postbackPayload === "CATALOG") {
      await sendCatalogMenu(conversationId, accountId, user);
      return;
    }
    if (postbackPayload) return; // handled by the automation that sent the button
  }

  /**
   * Слово-вызов: им человек сам звонит боту.
   *
   * В тихом режиме бот молчит по обычной переписке, и нужен способ его
   * позвать. Список задаёт продавец — он лучше знает, что пишут в его
   * переписках, а значит и какие слова у него не встречаются в обычном
   * разговоре. Сравнение по целому сообщению, а не по вхождению: «а магазин
   * у вас где?» боту не адресовано, а «Магазин» — адресовано.
   */
  const plain = lower.trim().replace(/[.!?]+$/, "");
  const { matchDirectCommand } = await import("./direct-flow");
  const command = matchDirectCommand(text);

  /**
   * Корзина, оформление и «мои заказы» отвечают в любом режиме.
   *
   * Это не болтовня, а обслуживание собственной покупки: человек хочет
   * посмотреть, что набрал, оплатить или узнать, где его материалы. Оставлять
   * такие вопросы продавцу — значит грузить его тем, на что бот отвечает
   * точнее и мгновенно.
   *
   * Команда опознаётся по целому сообщению (см. matchDirectCommand), поэтому
   * «а где мой заказ, я оплатила вчера» командой не считается и уйдёт
   * продавцу, как и должно.
   */
  if (features.cart && command === "cart") {
    await sendCart(conversationId, accountId, user);
    return;
  }
  if (features.checkout && command === "checkout") {
    await startInstagramCheckout(conversationId, accountId, user);
    return;
  }
  if (command === "orders") {
    await sendOrders(conversationId, accountId, user);
    return;
  }

  const triggerWords = parseTriggerWords(setting("instagram_direct_bot_triggers"));
  if (triggerWords.includes(plain)) {
    await sendCatalogMenu(conversationId, accountId, user);
    return;
  }

  /**
   * Дальше идут ответы на всё подряд — команды, поиск, свободные вопросы.
   * В режиме «только покупки» мы сюда не заходим: выше уже отработало всё, что
   * относится к заказу и к осознанному обращению к боту, а остальное — обычная
   * переписка продавца с людьми, и лезть в неё незачем.
   */
  if (!answersEverything) {
    console.log(`[zernio-bot] режим «только покупки»: сообщение от ${userKey} оставлено продавцу`);
    return;
  }

  if (features.catalog && command === "catalog") {
    await sendCatalogMenu(conversationId, accountId, user);
    return;
  }

  /**
   * Поиск остаётся, но только по явной просьбе.
   *
   * Раньше в него проваливалась любая реплика, и это ломало разговор. Сам по
   * себе поиск полезен — покупатель может не знать номера, — поэтому он никуда
   * не делся, просто теперь его надо попросить: «поиск пазлы».
   */
  const searchMatch = lower.match(/^(?:поиск|найти|найди)\s+(.{2,})$/);
  if (features.search && searchMatch) {
    await sendInteractiveProductResults(conversationId, accountId, user, searchMatch[1].trim());
    return;
  }

  /**
   * Свободная реплика — это вопрос, а не поисковый запрос.
   *
   * Здесь была главная поломка Direct: в поиск товаров уходил любой текст
   * длиннее одного символа. «Здравствуйте», «а скидка есть?» и ответ на
   * авто-DM из воронки одинаково превращались в запрос к каталогу и получали
   * «ничего не нашлось» — человек упирался в стену на первой же фразе.
   *
   * Теперь поиском занимается только то, что похоже на номер товара (это
   * разбирает handlePurchaseFlow выше). Сюда доходит именно вопрос: отвечаем
   * заготовленным текстом и зовём продавца — ответить живому человеку он
   * может из админки.
   */
  const flow = await import("./direct-purchase.server");
  const questionState = flow.readDirectState(user.state);
  const now = Date.now();

  /**
   * Здороваемся один раз за разговор.
   *
   * Раньше полное приветствие уходило на каждую реплику: человек писал «не
   * нужно», а в ответ снова получал «Здравствуйте! …напишите номер товара», и
   * так по кругу. Теперь первое сообщение — приветствие, дальше короткое
   * подтверждение, что вопрос передан.
   */
  const greetedRecently =
    Boolean(questionState.greeted_at) &&
    now - Date.parse(questionState.greeted_at!) < 12 * 60 * 60 * 1000;

  /**
   * Продавца зовём не чаще раза в час на собеседника: переписка из пяти реплик
   * не должна превращаться в пять одинаковых уведомлений в Telegram.
   */
  const notifiedRecently =
    Boolean(questionState.notified_at) &&
    now - Date.parse(questionState.notified_at!) < 60 * 60 * 1000;

  if (!notifiedRecently) {
    await flow.notifyAdminAboutQuestion({ question: text, senderName, senderUsername });
  }

  const stamp = new Date().toISOString();
  await flow.setDirectState(user.user_key, {
    ...questionState,
    greeted_at: greetedRecently ? questionState.greeted_at : stamp,
    notified_at: notifiedRecently ? questionState.notified_at : stamp,
  });

  await reply(
    user,
    conversationId,
    accountId,
    greetedRecently
      ? "Передал ваш вопрос продавцу — он ответит здесь же."
      : setting("instagram_direct_bot_script") ||
          `Здравствуйте, ${senderName}! 👋\n\n` +
            "Передал ваш вопрос продавцу — он ответит здесь же.\n\n" +
            "Если хотите что-то купить прямо сейчас, напишите номер товара из публикации — например «196».",
  );
}

/**
 * Отправить главное меню и список категорий
 */
/**
 * Меню в ответ на команду.
 *
 * Было хуже, чем бесполезно, и это видно по живой переписке. Меню печатало
 * нумерованный список разделов и просило «написать название категории или тему
 * для поиска», но:
 *
 *  • названия категорий бот не понимал вовсе, а обычный текст перестал уходить
 *    в поиск (для него теперь нужно «поиск …») — то есть инструкция врала;
 *  • номера разделов сталкивались с номерами товаров. Человек отвечал «1»,
 *    имея в виду первый раздел, а бот находил товар «001» и начинал оформление
 *    заказа на него. Ровно это и произошло при проверке;
 *  • кнопка «Корзина» вела в старый путь с оплатой через Robokassa, тогда как
 *    заказы теперь оформляются по чеку с выдачей на почту.
 *
 * Теперь меню говорит ровно то, что бот действительно умеет: принять номер
 * товара. Разбирать каталог удобнее в Telegram-боте — туда и ведём.
 */
async function sendCatalogMenu(conversationId: string, accountId: string, user: any) {
  const botLink = await telegramBotLink();

  const lines = [
    "Здесь можно оформить заказ по номеру материала.",
    "",
    "Напишите номер из публикации — например «018», — и я подскажу, как оплатить.",
  ];

  if (botLink) {
    lines.push(
      "",
      `А чтобы посмотреть весь каталог, поискать по теме и получить файлы, заходите в наш бот: ${botLink}`,
    );
  }

  await reply(user, conversationId, accountId, lines.join("\n"));
}

/**
 * Поиск и отправка товаров в DM
 */
async function sendInteractiveProductResults(conversationId: string, accountId: string, user: any, query: string) {
  const s = await db();
  const { data: products } = await s
    .from("products")
    // country_prices нужен для расчёта цены: в выдаче поиска показывалась
    // базовая цена товара, а она у клиента намеренно завышена.
    .select("id, name, price, currency, country_prices, description, is_active")
    .eq("is_active", true)
    .or(`name.ilike.%${query}%,description.ilike.%${query}%,keywords.ilike.%${query}%`)
    .limit(5);

  if (!products?.length) {
    await reply(
      user,
      conversationId,
      accountId,
      `По запросу «${query}» ничего не найдено. Попробуйте другое слово или откройте каталог в нашем боте: ${(await telegramBotLink()) ?? ""}`,
      [{ type: "postback", title: "Каталог", payload: "CATALOG" }],
    );
    return;
  }

  // Список идёт отдельными сообщениями с кнопками у каждого товара — через
  // защиту от повторов их не гоняем: тексты и так все разные.
  await sendZernioInboxMessage(conversationId, accountId, `🔎 Нашли ${products.length} вариантов:`);
  const flow = await import("./direct-purchase.server");
  const country = flow.readDirectState(user.state).country_code ?? null;
  for (const product of products) {
    const description = product.description ? `\n${String(product.description).slice(0, 180)}` : "";
    const money = await flow.resolveProductPrice(product, country);
    await sendZernioInboxMessage(
      conversationId,
      accountId,
      `📌 ${product.name}\n💰 ${money.amount} ${money.currency}${description}`,
      undefined,
      undefined,
      [
        { type: "postback", title: "Добавить в корзину", payload: `BUY:${product.id}` },
        { type: "postback", title: "Корзина", payload: "CART" },
      ],
    );
  }
}

/**
 * Добавление по кнопке «Купить» из автоматизации воронки.
 *
 * Ведёт в ту же корзину, что и номер материала: путей оформления должно быть
 * ровно столько, сколько путей выдачи, то есть один. Прежняя версия
 * увеличивала количество при повторном нажатии — для цифрового материала это
 * бессмысленно, второй экземпляр того же файла человеку не нужен.
 */
async function addProductToCart(
  conversationId: string,
  accountId: string,
  user: any,
  productId: string,
) {
  const flow = await import("./direct-purchase.server");
  const s = await db();
  const { data: product } = await s
    .from("products")
    .select("id, name, is_active")
    .eq("id", productId)
    .maybeSingle();

  if (!product?.is_active) {
    await reply(user, conversationId, accountId, "Этот материал больше недоступен.");
    return;
  }
  if (!(await flow.productHasFiles(product.id))) {
    await reply(
      user,
      conversationId,
      accountId,
      `«${product.name}» сейчас недоступен для скачивания. Продавец подскажет, когда он появится.`,
    );
    return;
  }

  await flow.addToCart(user, product.id);
  // Товар в корзине — счётчик непонятых реплик обнуляем: человек явно понял,
  // что от него нужно, и прежние промахи к делу больше не относятся.
  await flow.setDirectState(user.user_key, { misses: 0 });
  await sendCart(conversationId, accountId, user);
}

/** Показывает корзину и кнопку оформления. */
async function sendCart(conversationId: string, accountId: string, user: any) {
  const flow = await import("./direct-purchase.server");
  const cart = await flow.readCart(user);

  if (cart.length === 0) {
    await reply(
      user,
      conversationId,
      accountId,
      "В заказе пока ничего нет. Напишите номер материала из публикации — например «018».",
    );
    return;
  }

  const state = flow.readDirectState(user.state);
  const total = await flow.priceCart(cart, state.country_code ?? null);
  await reply(
    user,
    conversationId,
    accountId,
    `В заказе ${cart.length === 1 ? "материал" : `${cart.length} материала`}:\n\n` +
      `${flow.renderCart(total.lines)}\n\n` +
      (cart.length > 1 && !total.mixedCurrency ? `Итого: ${total.total} ${total.currency}\n\n` : "") +
      (cart.length > 1
        ? "Можно добавить ещё номер или убрать лишнее — напишите «убрать 018».\n"
        : "Можно добавить ещё — напишите следующий номер.\n"),
    [{ type: "postback", title: "Оформить заказ", payload: "CHECKOUT" }],
  );
}
async function sendOrders(conversationId: string, accountId: string, user: any) {
  const s = await db();
  const { data: orders } = await s
    .from("orders")
    .select("*")
    .eq("telegram_id", user.telegram_id)
    .order("created_at", { ascending: false })
    .limit(5);

  if (!orders || orders.length === 0) {
    await reply(user, conversationId, accountId, `У вас пока нет заказов. 📋`);
    return;
  }

  /**
   * Названия статусов для покупателя.
   *
   * Прежний набор был из другой жизни: «paid» и «cancelled» в базе не
   * встречаются вовсе, зато не было awaiting_confirmation — а именно в нём
   * заказ и проводит время, пока продавец сверяет чек. Покупатель видел просто
   * технический код и не понимал, ждать ему или писать.
   */
  const statusMap: Record<string, string> = {
    awaiting_confirmation: "⏳ Проверяем оплату",
    awaiting_payment: "⏳ Ожидает оплаты",
    delivering: "📤 Отправляем материалы",
    delivered: "✅ Материалы отправлены на почту",
    rejected: "❌ Отклонён",
  };

  let msg = `📋 Ваши заказы:\n\n`;
  orders.forEach((o: any) => {
    msg += `Заказ #${o.order_no ?? o.id} — ${o.total} ${o.currency} [${statusMap[o.status] || o.status}]\n`;
  });

  await reply(user, conversationId, accountId, msg);
}

/**
 * Обработать входящий комментарий к публикации/Reels (Comment-to-DM).
 * Соответствует спецификации Zernio Webhooks: payload.comment, payload.post, payload.account
 */
/**
 * Переход к оплате: спрашиваем страну, дальше сценарий с чеком.
 *
 * Здесь была ловушка. Прежняя версия оформляла заказ через корзину и Robokassa,
 * ставила статус awaiting_payment и **не спрашивала почту** — а заказы из
 * Instagram выдаются письмом. Дальше тупик был в любом случае: подтверждение
 * продавцом падало с «не указана почта покупателя», а автовыдача после
 * Robokassa пыталась отправить документ вложением в Instagram, чего Instagram
 * не принимает. Попасть туда можно было прямо сейчас — кнопкой «Оформить
 * заказ» из старых автоматизаций воронки.
 *
 * Теперь путь один: корзина → страна → реквизиты → чек → почта → подтверждение
 * продавцом → материалы письмом.
 */
async function startInstagramCheckout(conversationId: string, accountId: string, user: any) {
  const flow = await import("./direct-purchase.server");
  const cart = await flow.readCart(user);

  /**
   * Оформлять нечего — и это не повод отвечать одно и то же.
   *
   * В живой переписке покупательница получила «Корзина пуста» на жалобу о
   * неполученном материале, нажала «Оформить заказ» — и получила тот же текст
   * второй раз. Разбор команд уже исправлен, но сама тупиковая ветка осталась:
   * кнопка живёт в старых автоматизациях воронки, и по ней приходят люди с
   * пустой корзиной.
   *
   * Поэтому здесь одна подсказка, а на второй раз — продавец. Если человек
   * дважды не понял, чего от него хотят, третья попытка бота не поможет.
   */
  if (cart.length === 0) {
    const state = flow.readDirectState(user.state);

    // Разговор уже у продавца — кнопку человек мог нажать от растерянности, и
    // очередная подсказка от бота ему сейчас не нужна.
    if (flow.handedToHuman(state)) {
      console.log(`[zernio-bot] «Оформить» при пустой корзине от ${user.user_key} — молчим`);
      return;
    }

    const attempts = (state.misses ?? 0) + 1;

    if (attempts >= flow.MAX_STEP_MISSES) {
      await flow.clearDirectFlow(user.user_key);
      await reply(
        user,
        conversationId,
        accountId,
        "Похоже, я не помогаю — не буду мешать. Продавец увидит переписку и ответит сам.",
      );
      await flow.notifyAdminAboutQuestion({
        question: "Нажимает «Оформить заказ», но в корзине ничего нет — не может выбрать материал.",
        senderName: user.first_name || "покупатель",
        senderUsername: user.username || "",
      });
      return;
    }

    await flow.setDirectState(user.user_key, { misses: attempts });
    await reply(
      user,
      conversationId,
      accountId,
      "Чтобы оформить заказ, сначала напишите номер материала из публикации — например «018».\n\n" +
        "Я посчитаю сумму и пришлю реквизиты.",
    );
    return;
  }

  const options = await flow.listCountries();
  if (options.length === 0) {
    await reply(
      user,
      conversationId,
      accountId,
      "Реквизиты для оплаты пока не заведены. Продавец свяжется с вами.",
    );
    return;
  }

  /**
   * Страну помним между заказами и второй раз не спрашиваем.
   *
   * Она не меняется, а каждый лишний вопрос на пути к оплате — это место, где
   * человек передумает. Постоянный покупатель теперь идёт короче: номер →
   * «Оформить» → реквизиты. Название страны бот проговаривает, чтобы можно было
   * возразить, и напоминает про «отмена», если она всё-таки другая.
   */
  const state = flow.readDirectState(user.state);
  const remembered = state.country_code
    ? options.find((option) => option.code === state.country_code)
    : undefined;

  if (remembered) {
    await sendDirectPaymentDetails({
      conversationId,
      accountId,
      user,
      country: remembered,
      remembered: true,
    });
    return;
  }

  /**
   * Пока страна неизвестна, цены считаются по домашней стране продавца — так
   * покупатель видит настоящую цену, а не завышенную базовую. Если он назовёт
   * другую страну, сумма пересчитается в её валюте на следующем шаге.
   */
  await flow.setDirectState(user.user_key, { mode: "awaiting_country" });
  const shown = await flow.priceCart(cart, null);
  await reply(
    user,
    conversationId,
    accountId,
    `В заказе:\n${flow.renderCart(shown.lines)}\n\n` + flow.renderCountryPrompt(options),
  );
}

/**
 * Реквизиты и итог по корзине. Общий шаг для обоих путей: когда страну только
 * что назвали и когда взяли из памяти.
 */
async function sendDirectPaymentDetails(params: {
  conversationId: string;
  accountId: string;
  user: any;
  country: { code: string; name: string };
  remembered: boolean;
}) {
  const { conversationId, accountId, user, country, remembered } = params;
  const flow = await import("./direct-purchase.server");
  const say = (message: string) => reply(user, conversationId, accountId, message);

  const requisites = await flow.paymentInstructionsFor(country.code);
  if (!requisites) {
    await say(
      "Для этой страны реквизиты пока не заведены. Продавец свяжется с вами и подскажет, как оплатить.",
    );
    await flow.clearDirectFlow(user.user_key);
    return;
  }

  const cart = await flow.readCart(user);
  if (cart.length === 0) {
    await say("Корзина опустела. Напишите номер материала, и начнём заново.");
    await flow.clearDirectFlow(user.user_key);
    return;
  }

  // Цены — в валюте выбранной страны: покупателю из России сумма и реквизиты
  // должны совпадать по валюте, иначе он платит непонятно сколько.
  const { lines: pricedLines, total: amount, currency, mixedCurrency } = await flow.priceCart(
    cart,
    country.code,
  );
  if (mixedCurrency) {
    // Складывать разные валюты нельзя: сумма получилась бы бессмысленной.
    await say(
      "В заказе материалы в разных валютах — оформите их по отдельности.\n\n" +
        "Напишите «отмена», а потом номер одного материала.",
    );
    return;
  }

  await flow.setDirectState(user.user_key, {
    mode: "awaiting_proof",
    country_code: country.code,
  });

  await say(
    `${flow.renderCart(pricedLines)}\n\n` +
      (remembered ? `Реквизиты для ${country.name} — если страна другая, напишите «отмена».\n\n` : "") +
      `${requisites.instructions}\n\n` +
      `К оплате: ${amount} ${currency}\n` +
      "После оплаты пришлите чек сюда — картинкой или файлом.",
  );
}


/**
 * Автовыдача после онлайн-оплаты — одним путём с ручной.
 *
 * Прежняя версия отправляла материалы вложениями прямо в переписку, с
 * `attachmentType: "file"`. Instagram документов вложением не принимает вовсе —
 * только картинки, видео и аудио, — так что эта выдача не могла работать ни при
 * каких условиях. Заказов через неё не проходило ни одного, поэтому никто и не
 * замечал.
 *
 * Теперь она передаёт заказ общей выдаче, а та для площадки instagram
 * отправляет письмо со ссылками. Если почты у заказа нет (такое возможно только
 * у старых заказов, оформленных до перехода на сценарий с чеком), выдача честно
 * скажет об этом продавцу, а не сделает вид, что всё ушло.
 */
export async function deliverInstagramOrder(orderId: number) {
  const { deliverOrder } = await import("./orders.server");
  return await deliverOrder(orderId);
}

/*
 * Обработчика комментариев здесь намеренно нет. Ответы на комментарии и DM по
 * ключевым словам делают родные Comment-to-DM автоматизации Zernio — им наше
 * участие не нужно, и прежний handleZernioComment сводился к console.log.
 * Вместе с ним снята и подписка на `comment.received` (см. комментарий к
 * событиям в registerZernioWebhook): она давала 69 % всего трафика вебхука без
 * единого полезного действия.
 */

/**
 * Шаги сценария покупки. Возвращает true, если реплика обработана и дальше её
 * разбирать не надо.
 *
 * Порядок здесь и есть весь смысл: сначала смотрим, на каком шаге стоит
 * диалог, и только если ни на каком — пытаемся понять свободную реплику. До
 * появления состояния бот делал наоборот и потому отправлял в поиск товаров
 * и «Здравствуйте», и «Казахстан», и односложный ответ на авто-DM воронки.
 */
async function handlePurchaseFlow(params: {
  conversationId: string;
  accountId: string;
  user: any;
  text: string;
  attachmentUrl?: string;
  /** false — режим «только покупки»: на всё, кроме заказа, бот молчит. */
  answersEverything: boolean;
}): Promise<boolean> {
  const { conversationId, accountId, user, text, attachmentUrl, answersEverything } = params;
  const flow = await import("./direct-purchase.server");
  const { classifyIncoming, isCancel, isPaymentComplaint, matchDirectCommand } = await import(
    "./direct-flow"
  );
  const state = flow.readDirectState(user.state);
  const say = (message: string) => reply(user, conversationId, accountId, message);

  /**
   * Выход из сценария — на любом шаге, а не только на ожидании чека.
   *
   * Раньше «отмена» понималась лишь при ожидании чека, а на выборе страны
   * человек оказывался запертым: при проверке отправили «/start» и получили
   * «Не понял страну» — и так по кругу, потому что любая реплика на этом шаге
   * считалась попыткой назвать страну.
   *
   * Слова здесь заданы прямо, а не через настраиваемый список команд: выход
   * должен работать всегда и одинаково, даже если продавец переопределил
   * команды вызова.
   */
  if (state.mode && isCancel(text)) {
    // Корзину чистим вместе с шагом. Иначе набранное оставалось лежать: человек
    // добавлял не тот номер, отменял, добавлял верный — и в заказ попадали оба.
    const had = (await flow.readCart(user)).length;
    await flow.clearDirectFlow(user.user_key);
    await flow.clearCart(user);
    /**
     * Говорим ровно то, что произошло. Прежний текст всегда сообщал «корзина
     * пуста» — и при отмене на пустой корзине выглядел объявлением о пустоте,
     * которую человек не создавал. На живой проверке это и получилось: на
     * «/start» пришло «Отменил, корзина пуста».
     */
    await say(
      had > 0
        ? "Отменил заказ, корзину очистил. Напишите номер материала, когда будете готовы — например «018»."
        : "Хорошо, начнём с начала. Напишите номер материала из публикации — например «018».",
    );
    return true;
  }

  /**
   * Вопрос по оплате — сразу человеку, без единой заготовленной фразы.
   *
   * Это исправление настоящей переписки. Покупательница написала: «Я оплатила
   * 400тг вам, вы материал мне не отправили». Бот увидел в этом «оплат»,
   * принял за команду «оформить заказ» и ответил «Корзина пуста — напишите
   * номер материала». Дважды. На «верните мои деньги» — «Передал ваш вопрос
   * продавцу», тоже дважды. Разбор команд по вхождению уже исправлен, но одного
   * этого мало: такая реплика вообще не должна попадать в сценарий продажи.
   *
   * Что здесь важно:
   *  • шаг сценария не сбрасываем. Человек мог жаловаться на прошлый заказ, а
   *    сам стоять на ожидании чека — сбросив шаг, мы потеряли бы и корзину, и
   *    присланный следом чек;
   *  • продавца зовём один раз в шесть часов, зато с фактами: его заказы,
   *    статусы, есть ли чек и почта (см. notifyAdminAboutComplaint);
   *  • в тихом режиме покупателю не отвечаем вовсе — переписка останется
   *    непрочитанной, и продавец увидит её в Instagram сам.
   */
  if (!attachmentUrl && matchDirectCommand(text) === null && isPaymentComplaint(text)) {
    const complainedRecently = flow.handedToHuman(state);

    if (!complainedRecently) {
      await flow.notifyAdminAboutComplaint({
        text,
        senderName: user.first_name || "покупатель",
        senderUsername: user.username || "",
        telegramId: user.telegram_id,
      });
      await flow.setDirectState(user.user_key, { complained_at: new Date().toISOString() });
    }

    // Отвечаем только если бот в этом разговоре уже говорил: молчать после
    // собственных сообщений — значит бросить человека на полуслове.
    if (answersEverything || state.mode) {
      await say(
        "Вижу, что вопрос по оплате. Это решает продавец — я его уже позвал, " +
          "он ответит вам здесь же.\n\nБольше отвечать не буду, чтобы не мешать.",
      );
    } else {
      console.log(`[zernio-bot] жалоба по оплате от ${user.user_key} передана продавцу молча`);
    }
    return true;
  }

  /**
   * «Убрать 018» — передумать по одной позиции, не разбирая заказ целиком.
   *
   * Работает в любом режиме: это обслуживание собственной корзины, а не
   * болтовня. На шаге ожидания чека сумма после удаления меняется, поэтому
   * реквизиты с новым итогом уходят заново — иначе человек заплатил бы по
   * старому счёту.
   */
  const removeNumber = flow.parseRemoveCommand(text);
  if (removeNumber && state.mode !== "awaiting_email") {
    const cart = await flow.readCart(user);
    if (cart.length === 0) {
      await say("Убирать пока нечего — в заказе ничего нет.");
      return true;
    }

    const index = flow.pickCartLineToRemove(
      removeNumber,
      cart.map((line) => line.name),
    );
    if (index === null) {
      const shown = await flow.priceCart(cart, state.country_code ?? null);
      await say(
        `Материала с номером ${removeNumber} в заказе нет. Сейчас в нём:\n\n` +
          `${flow.renderCart(shown.lines)}\n\n` +
          "Чтобы убрать всё, напишите «отмена».",
      );
      return true;
    }

    const removed = cart[index];
    await flow.removeFromCart(user, removed.productId);
    const rest = await flow.readCart(user);

    if (rest.length === 0) {
      await flow.clearDirectFlow(user.user_key);
      await say(
        `Убрал «${removed.name}». В заказе больше ничего нет — напишите номер материала, когда будете готовы.`,
      );
      return true;
    }

    await say(`Убрал «${removed.name}».`);

    // Реквизиты уже отправлены — значит, названная сумма устарела, и её надо
    // назвать заново, вместе с обновлённым составом заказа.
    if (state.mode === "awaiting_proof" && state.country_code) {
      const options = await flow.listCountries();
      const country = options.find((option) => option.code === state.country_code);
      if (country) {
        await sendDirectPaymentDetails({
          conversationId,
          accountId,
          user,
          country,
          remembered: false,
        });
        return true;
      }
    }

    await sendCart(conversationId, accountId, user);
    return true;
  }

  // ── Ждём чек ────────────────────────────────────────────────────────────
  if (state.mode === "awaiting_proof") {
    if (!attachmentUrl) {
      await flow.handleStepMiss({
        user,
        state,
        text,
        hint:
          "Жду чек об оплате — пришлите его сюда картинкой или файлом.\n\n" +
          "Если передумали, напишите «отмена».",
        say,
      });
      return true;
    }

    /**
     * Порядок важен: сначала чек, потом заказ.
     *
     * Раньше заказ создавался первым, продавцу тут же уходило уведомление, и
     * только потом сохранялся чек — при сбое загрузки в базе оставался заказ
     * без вложения, а продавец уже шёл его проверять.
     */
    const proofPath = await flow.storeReceipt(attachmentUrl, user.user_key);
    if (!proofPath) {
      await say(
        "Чек не удалось сохранить. Пришлите его, пожалуйста, ещё раз — картинкой или файлом.",
      );
      return true;
    }

    const order = await flow.createOrderFromCart({ user, countryCode: state.country_code! });
    if (!order) {
      await say("Не получилось оформить заказ. Напишите номер материала ещё раз, пожалуйста.");
      await flow.clearDirectFlow(user.user_key);
      return true;
    }

    const s = await db();
    const { data: created } = await s
      .from("orders")
      .update({ payment_proof_path: proofPath.path })
      .eq("id", order.id)
      .select("total, currency")
      .single();

    // Корзину освобождаем только после успешного заказа — иначе при сбое
    // человек потерял бы всё, что набрал.
    await flow.clearCart(user);
    const displayNo = order.order_no || order.id;

    /**
     * Распознаём чек сразу, пока байты под рукой.
     *
     * Это то, ради чего вообще стоит городить бота: если сумма в чеке сходится,
     * материалы уходят сами и покупатель получает их через минуту, а не когда
     * продавец доберётся до разбора. Не сошлось или не распознали — заказ
     * уходит на ручную проверку с причиной, и продавец решает сам. Ошибка в эту
     * сторону единственно верная: выдать по чужому чеку хуже, чем задержать
     * выдачу на пару часов.
     */
    const verdict = await flow.verifyDirectReceipt({
      bytes: proofPath.bytes,
      mime: proofPath.mime,
      expectedAmount: Number(created?.total ?? 0),
      currency: String(created?.currency ?? "KZT"),
    });
    await s
      .from("orders")
      .update({ admin_note: `Instagram, чек: ${verdict.note}`.slice(0, 500) })
      .eq("id", order.id);

    const email = user.email as string | null;

    // Почта известна и чек сошёлся — отдаём материалы сразу, ничего не спрашивая.
    if (email && verdict.autoDeliver) {
      await s.from("orders").update({ customer_email: email }).eq("id", order.id);
      await flow.clearDirectFlow(user.user_key);
      try {
        const { deliverOrder } = await import("./orders.server");
        await deliverOrder(order.id);
        // Продавец должен знать о продаже, даже когда делать ничего не нужно.
        await flow.notifyAdminAboutDirectOrder(order.id, displayNo, {
          verdict: verdict.note,
          needsAction: false,
        });
        return true; // о письме покупателю сообщает сама выдача
      } catch (e) {
        console.error("[zernio-bot] автовыдача не удалась, отдаём продавцу", e);
        await flow.notifyAdminAboutDirectOrder(order.id, displayNo, { verdict: verdict.note });
        await say(
          `Чек получил, заказ №${displayNo} принят. Отправим материалы на ${email} после проверки.`,
        );
        return true;
      }
    }

    await flow.notifyAdminAboutDirectOrder(order.id, displayNo, { verdict: verdict.note });

    if (email) {
      await s.from("orders").update({ customer_email: email }).eq("id", order.id);
      await flow.setDirectState(user.user_key, {
        mode: "awaiting_email",
        pending_order_id: order.id,
        email_optional: true,
      });
      await say(
        `Чек получил, заказ №${displayNo} принят. Проверим оплату и пришлём материалы на ${email}.\n\n` +
          "Если нужен другой адрес — напишите его сюда. По остальным вопросам ответит продавец.",
      );
      return true;
    }

    await flow.setDirectState(user.user_key, {
      mode: "awaiting_email",
      pending_order_id: order.id,
    });
    await say(
      `Чек получил, заказ №${displayNo} принят.\n\n` +
        "На какую почту прислать материалы? Instagram не умеет пересылать документы, поэтому файлы уходят письмом.",
    );
    return true;
  }

  // ── Ждём страну ─────────────────────────────────────────────────────────
  if (state.mode === "awaiting_country") {
    const options = await flow.listCountries();
    const chosen = flow.matchCountry(text, options);
    if (!chosen) {
      await flow.handleStepMiss({
        user,
        state,
        text,
        hint:
          "Не понял страну. Ответьте номером из списка или названием — например «1» или «Казахстан».\n\n" +
          "Чтобы выйти, напишите «отмена».",
        say,
      });
      return true;
    }

    // Дальше — общий шаг с тем случаем, когда страну взяли из памяти.
    await sendDirectPaymentDetails({
      conversationId,
      accountId,
      user,
      country: chosen,
      remembered: false,
    });
    return true;
  }

  // ── Ждём почту ──────────────────────────────────────────────────────────
  if (state.mode === "awaiting_email") {
    const email = flow.extractEmail(text);

    /**
     * Пришла ещё одна картинка вместо адреса — это второй чек, а не ошибка.
     *
     * Так и было при живой проверке: человек, уже отправив чек, прислал его
     * ещё раз (или скриншот перевода вдогонку) — и получил «это не похоже на
     * адрес почты». Ответ формально верный и совершенно бесполезный: человек
     * прислал доказательство оплаты, а ему сказали, что он неправильно написал
     * почту.
     *
     * Сохраняем вложение к тому же заказу, говорим продавцу и остаёмся на шаге
     * почты — она всё ещё нужна, чтобы отправить материалы.
     */
    if (!email && attachmentUrl) {
      const extra = await flow.storeReceipt(attachmentUrl, user.user_key);
      const s = await db();
      if (extra && state.pending_order_id) {
        const { data: order } = await s
          .from("orders")
          .select("payment_proof_path, order_no, admin_note")
          .eq("id", state.pending_order_id)
          .maybeSingle();

        await s
          .from("orders")
          .update(
            order?.payment_proof_path
              ? {
                  admin_note: `${order.admin_note ?? ""}; ещё один чек: ${extra.path}`.slice(0, 500),
                }
              : { payment_proof_path: extra.path },
          )
          .eq("id", state.pending_order_id);

        await flow.notifyAdminAboutQuestion({
          question: `Прислал ещё один чек к заказу №${order?.order_no ?? state.pending_order_id}. Посмотрите вложения заказа.`,
          senderName: user.first_name || "покупатель",
          senderUsername: user.username || "",
        });
      }
      await say(
        "Чек получил, он уже у продавца. Осталось одно: напишите почту, " +
          "на которую отправить материалы — например anna@mail.ru",
      );
      return true;
    }

    if (!email) {
      /**
       * Шаг был необязательным — адрес мы уже знали и лишь предложили его
       * заменить. Значит, человек написал о чём-то другом: выходим из сценария
       * и отдаём сообщение обычному разбору, а не требуем почту.
       */
      if (state.email_optional) {
        await flow.clearDirectFlow(user.user_key);
        return false;
      }
      await flow.handleStepMiss({
        user,
        state,
        text,
        hint:
          "Это не похоже на адрес почты. Напишите его целиком, например anna@mail.ru\n\n" +
          "Чтобы выйти, напишите «отмена».",
        say,
      });
      return true;
    }
    const s = await db();
    await s.from("bot_users").update({ email }).eq("user_key", user.user_key);
    if (state.pending_order_id) {
      await s.from("orders").update({ customer_email: email }).eq("id", state.pending_order_id);
    }
    await flow.clearDirectFlow(user.user_key);

    /**
     * Чек уже проверен при получении, и вердикт лежит в заметке заказа. Если он
     * сошёлся, ждать продавца незачем — адрес теперь известен, отдаём материалы
     * сразу. Именно это и превращает бота из посредника в настоящую автовыдачу:
     * человек получает файлы через минуту после оплаты, ночью и в выходной.
     */
    if (state.pending_order_id) {
      const { data: order } = await s
        .from("orders")
        .select("admin_note, status")
        .eq("id", state.pending_order_id)
        .maybeSingle();

      const verified = (order?.admin_note ?? "").includes("чек распознан");
      if (verified && order?.status === "awaiting_confirmation") {
        try {
          const { deliverOrder } = await import("./orders.server");
          await deliverOrder(state.pending_order_id);
          const { data: shown } = await s
            .from("orders")
            .select("order_no")
            .eq("id", state.pending_order_id)
            .maybeSingle();
          await flow.notifyAdminAboutDirectOrder(
            state.pending_order_id,
            shown?.order_no ?? state.pending_order_id,
            { verdict: "распознан, выдано автоматически", needsAction: false },
          );
          return true; // о письме покупателю сообщает сама выдача
        } catch (e) {
          console.error("[zernio-bot] автовыдача после ввода почты не удалась", e);
        }
      }
    }

    /**
     * Дальше разговор ведёт продавец, и это сказано прямо.
     *
     * Продавец боялась именно этого: человек оформил заказ, у него возник
     * вопрос, а сообщение «прошло через бота» и до неё не дошло. Теперь после
     * оформления бот выходит из сценария и по обычной переписке молчит —
     * непрочитанное в Instagram снова видно, а покупатель предупреждён, что
     * ответит живой человек, и не ждёт от бота невозможного.
     */
    await say(
      `Записал: ${email}\n\n` +
        "Проверим оплату и пришлём материалы на этот адрес.\n\n" +
        "Если появятся вопросы — просто напишите здесь, дальше отвечает продавец.",
    );
    return true;
  }

  /**
   * Вложение пришло вне сценария — почти всегда это чек «на опережение».
   *
   * Так и появляются истории вида «я оплатила, а материал не отправили»:
   * человек увидел реквизиты в публикации, заплатил и прислал чек в Direct,
   * ничего у бота не заказывая. Заказа под такой чек нет, шага сценария нет —
   * прежде это вложение просто пропадало из виду бота целиком.
   *
   * Сохраняем чек в хранилище и зовём продавца: даже если это не чек, а
   * случайная картинка, потеря невелика, а цена обратной ошибки — потерянная
   * оплата и разбирательство.
   */
  if (attachmentUrl) {
    const notifiedRecently =
      Boolean(state.notified_at) && Date.now() - Date.parse(state.notified_at!) < 60 * 60 * 1000;

    if (!notifiedRecently) {
      const stored = await flow.storeReceipt(attachmentUrl, `${user.user_key}/unmatched`);
      await flow.notifyAdminAboutQuestion({
        question:
          "Прислал вложение (похоже на чек), но заказа у него нет — оплатил, минуя бота." +
          (stored ? `\nФайл: payment-proofs/${stored.path}` : "\nФайл сохранить не удалось."),
        senderName: user.first_name || "покупатель",
        senderUsername: user.username || "",
      });
      await flow.setDirectState(user.user_key, { notified_at: new Date().toISOString() });
    }

    if (answersEverything) {
      await say(
        "Вижу вложение. Если это чек об оплате — передал продавцу, он проверит и ответит здесь же.\n\n" +
          "Если хотите заказать материал через меня, напишите его номер из публикации.",
      );
    }
    return true;
  }

  // ── Сценарий не начат: разбираем свободную реплику ──────────────────────
  if (!text.trim()) return false;

  const incoming = classifyIncoming(text);

  /**
   * Разговор уже передан продавцу — молчим, как и обещали.
   *
   * Исключение одно: номер материала. Если после разбирательства человек всё же
   * решил купить, помочь ему надо — это действие, а не разговор. Всё остальное
   * (вопросы, «спасибо», односложные ответы) ждёт продавца, и переписка
   * остаётся у него непрочитанной.
   */
  if (flow.handedToHuman(state) && incoming.kind !== "product_number") {
    console.log(`[zernio-bot] разговор с ${user.user_key} у продавца — бот молчит`);
    return true;
  }

  if (incoming.kind === "product_number") {
    const lookup = await flow.findProductByNumber(incoming.number);

    if (lookup.kind === "ambiguous") {
      // Под одним номером несколько товаров. Не угадываем: продать не тот
      // материал хуже, чем задать лишний вопрос.
      const names = lookup.products.map((p, i) => `${i + 1}. ${p.name}`).join("\n");
      await say(
        `Под номером ${incoming.number} у нас несколько материалов:\n\n${names}\n\n` +
          "Напишите точное название нужного или уточните номер у продавца.",
      );
      return true;
    }

    const product = lookup.kind === "found" ? lookup.product : null;
    if (!product) {
      /**
       * Номер есть, а товара по нему нет.
       *
       * В тихом режиме молчим: человек мог написать «5» в обычном разговоре
       * («штук 5 хватит»), и «товар №5 не нашёл» в ответ выглядит дико. Пусть
       * продавец разберётся сам — переписка останется непрочитанной.
       */
      if (!answersEverything) return false;
      await say(
        `Товар с номером ${incoming.number} не нашёл. Проверьте номер в публикации — ` +
          "или напишите, что ищете, и продавец подскажет.",
      );
      return true;
    }
    // Материал без файла продавать нельзя: заказ дошёл бы до подтверждения и
    // упёрся бы там — уже после того, как человек заплатил. Таких в каталоге 8.
    if (!(await flow.productHasFiles(product.id))) {
      await say(
        `«${product.name}» сейчас недоступен для скачивания. Продавец подскажет, когда он появится.`,
      );
      return true;
    }

    await flow.addToCart(user, product.id);
    const cart = await flow.readCart(user);

    /**
     * Складываем в корзину, а не оформляем сразу.
     *
     * Методички берут по нескольку за раз, а прежний сценарий умел ровно один
     * материал: за вторым надо было заново проходить весь путь и присылать
     * второй чек. Корзина в базе была и раньше — ею пользовался старый путь с
     * Robokassa, — теперь она общий накопитель.
     *
     * Кнопка «Оформить» здесь важнее текста: одиночному покупателю не хочется
     * печатать лишнее слово, а тап работает и в папке «Запросы сообщений».
     */
    /**
     * Цену называем сразу.
     *
     * «Сколько стоит?» — самый частый вопрос в переписках, и молчать о цене,
     * когда человек уже назвал номер, значит гарантированно получить этот
     * вопрос следующим сообщением.
     *
     * Если страна известна с прошлого заказа — считаем по ней, в её валюте.
     * Если нет — по домашней стране продавца, а не по базовой цене товара:
     * базовая у клиента намеренно завышена (500 ₸ настоящих против 700 в
     * основном поле), и именно её покупатели видели раньше.
     */
    const state = flow.readDirectState(user.state);
    const shown = await flow.priceCart(cart, state.country_code ?? null);
    const line = shown.lines.find((item) => item.productId === product.id);
    const priceLine = line ? `${line.sum} ${line.currency}` : "";

    const added =
      cart.length === 1
        ? `Добавил «${product.name}» — ${priceLine}.`
        : `Добавил «${product.name}» — ${priceLine}.\n\nВ заказе ${cart.length}:\n${flow.renderCart(shown.lines)}`;

    await reply(
      user,
      conversationId,
      accountId,
      `${added}\n\nМожно добавить ещё — просто напишите следующий номер. Или оформляйте заказ.`,
      [{ type: "postback", title: "Оформить заказ", payload: "CHECKOUT" }],
    );
    return true;
  }

  if (incoming.kind === "affirmative") {
    // Односложный ответ — почти всегда реакция на автоматический DM из
    // воронки. Но такое же «да» звучит и в обычном разговоре с продавцом,
    // поэтому в тихом режиме не вмешиваемся.
    if (!answersEverything) return false;
    await say(
      "Отлично! Напишите номер товара из публикации — например «196», — и я подскажу, как оплатить.",
    );
    return true;
  }

  if (incoming.kind === "dismissal") {
    /**
     * Разговор закрывают: «не нужно», «спасибо», «понятно».
     *
     * Отвечаем коротко и на этом замолкаем. Раньше такая реплика попадала в
     * разбор вопросов и человек получал полное приветствие с предложением
     * назвать номер товара — то есть бот здоровался с ним заново после того,
     * как тот вежливо отказался. Продавца тут не зовём: звать его на «спасибо»
     * незачем.
     */
    if (!answersEverything) return false;
    await say("Хорошо! Если что-то понадобится — просто напишите сюда. 🙂");
    return true;
  }

  return false;
}

/** Слова по умолчанию, которыми человек зовёт бота. Продавец может задать свои. */
export const DEFAULT_TRIGGER_WORDS = ["заказать", "купить", "магазин", "каталог", "/start"];

/**
 * Список слов-вызовов из настройки. Пустая настройка не должна оставлять бота
 * без единого способа его позвать, поэтому падаем на значения по умолчанию.
 */
function parseTriggerWords(raw: string): string[] {
  const words = raw
    .split(",")
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean);
  return words.length > 0 ? words : DEFAULT_TRIGGER_WORDS;
}

/**
 * Ссылка на Telegram-бота этого клиента.
 *
 * Раньше в Direct уходила ссылка на веб-адрес деплоя — а это админка, и
 * покупателю там делать нечего. Правильный адресат — Telegram-бот: в нём
 * каталог, поиск и выдача файлов, ради которых из Instagram и приходят.
 *
 * Юзернейм спрашиваем у самого Telegram по токену, который у деплоя и так
 * есть: так его не надо прописывать руками ни в панели, ни в переменных, и он
 * не разъедется с действительностью, если бота переименуют. Ответ кешируем на
 * процесс — он меняется раз в никогда, а дёргать getMe на каждое сообщение
 * незачем. Переопределить можно переменной TELEGRAM_BOT_USERNAME.
 */
let cachedBotUsername: string | null = null;

export async function telegramBotLink(): Promise<string | null> {
  const override = process.env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "");
  if (override) return `https://t.me/${override}`;
  if (cachedBotUsername) return `https://t.me/${cachedBotUsername}`;

  try {
    const { tg } = await import("./telegram.server");
    const response = (await tg("getMe", {})) as { ok?: boolean; result?: { username?: string } };
    const username = response?.result?.username?.trim();
    if (!username) return null;
    cachedBotUsername = username;
    return `https://t.me/${username}`;
  } catch (e) {
    console.error("[zernio-bot] не удалось узнать юзернейм Telegram-бота", e);
    return null;
  }
}
