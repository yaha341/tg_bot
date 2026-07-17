import { tg, tgSendMultipart } from "./telegram.server";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function deliverOrder(orderId: number) {
  const { supabaseAdmin } = await import("@/integrations-supabase/client.server");
  const { data: order, error } = await supabaseAdmin
    .from("orders")
    .select("*, order_items(*)")
    .eq("id", orderId)
    .single();
  if (error || !order) throw new Error(error?.message || "Order not found");
  if (order.status === "delivered") return { ok: true as const, alreadyDelivered: true };

  await tg("sendMessage", {
    chat_id: order.telegram_id,
    text: `✅ Оплата подтверждена! Заказ #${order.id}.\nОтправляю ваши материалы...`,
  });

  const items = order.order_items as Array<{
    name_snapshot: string;
    file_path_snapshot: string | null;
    file_name_snapshot: string | null;
    file_path_kz_snapshot?: string | null;
    file_name_kz_snapshot?: string | null;
    quantity: number;
  }>;

  const throttle = items.length > 5;
  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    const path_ru = item.file_path_snapshot;
    const path_kz = item.file_path_kz_snapshot;

    try {
      if (!path_ru) {
        await tg("sendMessage", {
          chat_id: order.telegram_id,
          text: `⚠️ Файл для «${item.name_snapshot}» не настроен. Продавец вышлет вручную.`,
        });
        continue;
      }

      if (path_kz) {
        await tg("sendMessage", {
          chat_id: order.telegram_id,
          text: `📚 Материал «<b>${item.name_snapshot}</b>»\nВыберите язык, на котором хотите получить файл:`,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "🇷🇺 Русский", callback_data: `lang_ru:${orderId}:${idx}` },
                { text: "🇰🇿 Қазақша", callback_data: `lang_kz:${orderId}:${idx}` },
              ],
            ],
          },
        });
      } else {
        await sendFileToUser(
          order.telegram_id,
          path_ru,
          item.file_name_snapshot || "file.bin",
          item.name_snapshot,
          item.quantity || 1,
        );
      }
    } catch (e) {
      console.error(`[orders] deliver item ${idx} of order #${orderId} failed`, e);
      await tg("sendMessage", {
        chat_id: order.telegram_id,
        text: `⚠️ Не удалось отправить «${item.name_snapshot}». Продавец вышлет вручную.`,
      });
    }

    if (throttle && idx + 1 < items.length) await sleep(200);
  }

  await tg("sendMessage", {
    chat_id: order.telegram_id,
    text: `🙏 Спасибо за покупку! Если что-то не так — напишите продавцу.`,
  });

  const { error: upErr } = await supabaseAdmin
    .from("orders")
    .update({ status: "delivered" })
    .eq("id", orderId);
  if (upErr) throw new Error(upErr.message);
  return { ok: true as const };
}

export async function sendFileToUser(
  chat_id: number,
  path: string,
  downloadName: string,
  caption: string,
  quantity: number,
) {
  const { supabaseAdmin } = await import("@/integrations-supabase/client.server");
  const { data: signed, error: signErr } = await supabaseAdmin.storage
    .from("product-files")
    .createSignedUrl(path, 60 * 60 * 24 * 365 * 10, {
      download: downloadName || "file.bin",
    });

  if (signErr || !signed) {
    await tg("sendMessage", {
      chat_id,
      text: `⚠️ Не удалось получить файл «${caption}». Продавец вышлет вручную.`,
    });
    return;
  }

  let fileSize = 0;
  try {
    const headRes = await fetch(signed.signedUrl, { method: "HEAD" });
    fileSize = Number(headRes.headers.get("content-length")) || 0;
  } catch {
    /* ignore */
  }

  let sentAsFile = false;

  if (fileSize > 0 && fileSize < 15 * 1024 * 1024) {
    try {
      const { data: dl, error: dlErr } = await supabaseAdmin.storage.from("product-files").download(path);

      if (!dlErr && dl) {
        const bytes = new Uint8Array(await dl.arrayBuffer());
        const filename = downloadName || "file.bin";
        const mime = dl.type || "application/octet-stream";

        for (let i = 0; i < (quantity || 1); i++) {
          await tgSendMultipart(
            "sendDocument",
            { chat_id, caption },
            { field: "document", filename, bytes, contentType: mime },
          );
        }
        sentAsFile = true;
      }
    } catch (e) {
      console.error("Failed to upload file to Telegram", e);
    }
  }

  if (!sentAsFile) {
    for (let i = 0; i < (quantity || 1); i++) {
      await tg("sendMessage", {
        chat_id,
        text: `📁 <b>${caption}</b>\n\n📥 <a href="${signed.signedUrl}">Нажмите здесь, чтобы скачать файл</a>\n<i>(Ссылка для скачивания)</i>`,
        parse_mode: "HTML",
      });
    }
  }
}
