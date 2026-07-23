import { tg, tgSendMultipart } from "./telegram.server";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Files per serverless run. Override with DELIVERY_BATCH_SIZE (1–20). */
const BATCH_SIZE = Math.min(20, Math.max(1, Number(process.env.DELIVERY_BATCH_SIZE) || 8));
const ITEM_DELAY_MS = 350;

/** Max file size for auto send (MB). Default 100. Cloud Bot API often rejects >50MB unless TELEGRAM_API_BASE=Local Bot API. */
const MAX_FILE_BYTES =
  Math.min(200, Math.max(1, Number(process.env.DELIVERY_MAX_FILE_MB) || 100)) * 1024 * 1024;

const DELIVERABLE_STATUSES = ["awaiting_confirmation", "awaiting_payment"] as const;

type OrderItem = {
  name_snapshot: string;
  file_path_snapshot: string | null;
  file_name_snapshot: string | null;
  file_path_kz_snapshot?: string | null;
  file_name_kz_snapshot?: string | null;
  quantity: number;
};

async function claimOrderForDelivery(orderId: number) {
  const { supabaseAdmin } = await import("@/integrations-supabase/client.server");

  const { data: order, error } = await supabaseAdmin
    .from("orders")
    .update({ status: "delivering", delivery_index: 0 })
    .eq("id", orderId)
    .in("status", [...DELIVERABLE_STATUSES])
    .select("*, order_items(*)")
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (order) return order;

  const { data: existing, error: readErr } = await supabaseAdmin
    .from("orders")
    .select("status")
    .eq("id", orderId)
    .maybeSingle();
  if (readErr) throw new Error(readErr.message);
  if (!existing) throw new Error("Order not found");
  if (existing.status === "delivered" || existing.status === "delivering") {
    return null;
  }
  throw new Error(`Заказ #${orderId} нельзя выдать (статус: ${existing.status})`);
}

async function releaseDeliveryClaim(orderId: number) {
  const { supabaseAdmin } = await import("@/integrations-supabase/client.server");
  await supabaseAdmin
    .from("orders")
    .update({ status: "awaiting_confirmation", delivery_index: 0 })
    .eq("id", orderId)
    .eq("status", "delivering");
}

async function setDeliveryIndex(orderId: number, index: number) {
  const { supabaseAdmin } = await import("@/integrations-supabase/client.server");
  await supabaseAdmin.from("orders").update({ delivery_index: index }).eq("id", orderId);
}

/**
 * Deliver product files as Telegram documents (not links), in small batches.
 * Large carts continue via cron / «Продолжить выдачу» until delivery_index covers all items.
 */
export async function deliverOrder(
  orderId: number,
  options?: { force?: boolean; resume?: boolean },
) {
  const { supabaseAdmin } = await import("@/integrations-supabase/client.server");

  let order: any;
  const isResume = Boolean(options?.force && options?.resume);
  const isFullRedeliver = Boolean(options?.force && !options?.resume);

  if (options?.force) {
    const patch: Record<string, unknown> = { status: "delivering" };
    if (isFullRedeliver) patch.delivery_index = 0;

    const { data, error } = await supabaseAdmin
      .from("orders")
      .update(patch)
      .eq("id", orderId)
      .select("*, order_items(*)")
      .single();
    if (error || !data) throw new Error(error?.message || "Order not found");
    order = data;
  } else {
    order = await claimOrderForDelivery(orderId);
    if (!order) return { ok: true as const, alreadyDelivered: true };
  }

  const items = ((order.order_items as OrderItem[]) || []).slice().sort((a: any, b: any) => {
    const ai = String(a.id || "");
    const bi = String(b.id || "");
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });

  let startIdx = Math.max(0, Number(order.delivery_index) || 0);
  if (isFullRedeliver) startIdx = 0;
  if (startIdx > items.length) startIdx = items.length;

  try {
    if (startIdx === 0) {
      await tg("sendMessage", {
        chat_id: order.telegram_id,
        text: `✅ Оплата подтверждена! Заказ #${order.id}.\nОтправляю ваши материалы файлами (${items.length} шт.)…`,
      });
    } else {
      await tg("sendMessage", {
        chat_id: order.telegram_id,
        text: `📤 Продолжаю выдачу заказа #${order.id}: позиции ${startIdx + 1}–${Math.min(startIdx + BATCH_SIZE, items.length)} из ${items.length}…`,
      });
    }

    const endIdx = Math.min(startIdx + BATCH_SIZE, items.length);

    for (let idx = startIdx; idx < endIdx; idx++) {
      const item = items[idx];
      const path_ru = item.file_path_snapshot;
      const path_kz = item.file_path_kz_snapshot;

      try {
        if (!path_ru && !path_kz) {
          await tg("sendMessage", {
            chat_id: order.telegram_id,
            text: `⚠️ Файл для «${item.name_snapshot}» не настроен. Продавец вышлет вручную.`,
          });
        } else if (path_ru && path_kz) {
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
          const path = path_ru || path_kz!;
          const name =
            (path_ru ? item.file_name_snapshot : item.file_name_kz_snapshot) ||
            item.file_name_snapshot ||
            "file.bin";
          await sendFileToUser(
            order.telegram_id,
            path,
            name,
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

      await setDeliveryIndex(orderId, idx + 1);
      if (idx + 1 < endIdx) await sleep(ITEM_DELAY_MS);
    }

    if (endIdx >= items.length) {
      await tg("sendMessage", {
        chat_id: order.telegram_id,
        text: `🙏 Спасибо за покупку! Заказ #${orderId} выдан (${items.length} материалов). Если что-то не так — напишите продавцу.`,
      });
      const { error: upErr } = await supabaseAdmin
        .from("orders")
        .update({ status: "delivered", delivery_index: items.length })
        .eq("id", orderId);
      if (upErr) throw new Error(upErr.message);
      return { ok: true as const, pending: false, sent: endIdx - startIdx, total: items.length };
    }

    return {
      ok: true as const,
      pending: true,
      sent: endIdx - startIdx,
      next: endIdx,
      total: items.length,
    };
  } catch (e) {
    // Keep status=delivering + delivery_index so cron / «Продолжить» can resume
    console.error(`[orders] deliverOrder #${orderId} interrupted`, e);
    throw e;
  }
}

/** Continue all orders stuck in delivering (called from cron). */
export async function processPendingDeliveries(limit = 5) {
  const { supabaseAdmin } = await import("@/integrations-supabase/client.server");
  const { data: rows, error } = await supabaseAdmin
    .from("orders")
    .select("id")
    .eq("status", "delivering")
    .order("updated_at", { ascending: true })
    .limit(limit);

  if (error) throw new Error(error.message);
  if (!rows?.length) return { processed: 0, continued: 0, finished: 0 };

  let continued = 0;
  let finished = 0;
  for (const row of rows) {
    try {
      const res = await deliverOrder(row.id as number, { force: true, resume: true });
      if ((res as any).pending) continued++;
      else if (!(res as any).alreadyDelivered) finished++;
    } catch (e) {
      console.error("[orders] pending delivery failed", row.id, e);
    }
  }
  return { processed: rows.length, continued, finished };
}

export async function sendFileToUser(
  chat_id: number,
  path: string,
  downloadName: string,
  caption: string,
  quantity: number,
) {
  const { supabaseAdmin } = await import("@/integrations-supabase/client.server");
  const filename = downloadName || "file.bin";
  const ext = (filename.split(".").pop() || "").toLowerCase();
  // Telegram accepts remote URL for these types and still delivers a document (not a text link)
  const telegramUrlTypes = new Set(["pdf", "zip", "gif"]);

  const { data: signed, error: signErr } = await supabaseAdmin.storage
    .from("product-files")
    .createSignedUrl(path, 60 * 60 * 24 * 7);

  let fileSize = 0;
  if (!signErr && signed?.signedUrl) {
    try {
      const headRes = await fetch(signed.signedUrl, { method: "HEAD" });
      fileSize = Number(headRes.headers.get("content-length")) || 0;
    } catch {
      /* ignore */
    }
  }

  const TG_MAX = MAX_FILE_BYTES;
  const MULTIPART_COMFORT = 20 * 1024 * 1024;

  async function sendViaTelegramUrl() {
    if (!signed?.signedUrl || !telegramUrlTypes.has(ext)) return false;
    for (let i = 0; i < (quantity || 1); i++) {
      const res = await tg("sendDocument", {
        chat_id,
        document: signed.signedUrl,
        caption,
      });
      if (!res?.ok) {
        console.error("[orders] sendDocument URL failed", res);
        return false;
      }
      if (i + 1 < (quantity || 1)) await sleep(300);
    }
    return true;
  }

  // Large PDF/ZIP: Telegram downloads the file itself — buyer still gets a document attachment
  if (fileSize > MULTIPART_COMFORT && fileSize <= TG_MAX && telegramUrlTypes.has(ext)) {
    if (await sendViaTelegramUrl()) return;
  }

  const { data: dl, error: dlErr } = await supabaseAdmin.storage.from("product-files").download(path);
  if (dlErr || !dl) {
    // Download failed — last try via URL for pdf/zip
    if (await sendViaTelegramUrl()) return;
    await tg("sendMessage", {
      chat_id,
      text: `⚠️ Не удалось получить файл «${caption}». Продавец вышлет вручную.`,
    });
    return;
  }

  const bytes = new Uint8Array(await dl.arrayBuffer());
  const mime = dl.type || "application/octet-stream";

  if (bytes.byteLength === 0) {
    await tg("sendMessage", {
      chat_id,
      text: `⚠️ Файл «${caption}» пустой. Продавец вышлет вручную.`,
    });
    return;
  }

  // Over configured limit
  if (bytes.byteLength > TG_MAX) {
    if (await sendViaTelegramUrl()) return;
    await tg("sendMessage", {
      chat_id,
      text: `⚠️ Файл «${caption}» слишком большой (${Math.round(bytes.byteLength / (1024 * 1024))} МБ, лимит ${Math.round(TG_MAX / (1024 * 1024))} МБ). Продавец вышлет вручную.`,
    });
    return;
  }

  // Multipart upload — works up to ~50MB on api.telegram.org, up to 100MB+ on Local Bot API
  for (let i = 0; i < (quantity || 1); i++) {
    const res = await tgSendMultipart(
      "sendDocument",
      { chat_id, caption },
      { field: "document", filename, bytes, contentType: mime },
    );
    if (!res?.ok) {
      console.error("[orders] sendDocument multipart failed", res);
      if (await sendViaTelegramUrl()) return;
      const hint =
        bytes.byteLength > 50 * 1024 * 1024
          ? " Для файлов >50 МБ нужен Local Bot API (TELEGRAM_API_BASE)."
          : "";
      await tg("sendMessage", {
        chat_id,
        text: `⚠️ Не удалось отправить файл «${caption}» (${Math.round(bytes.byteLength / (1024 * 1024))} МБ).${hint}`,
      });
      return;
    }
    if (i + 1 < (quantity || 1)) await sleep(300);
  }
}
