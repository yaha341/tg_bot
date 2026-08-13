import { tg, tgSendMultipart } from "./telegram.server";

import type { TablesUpdate } from "@/integrations-supabase/types";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Files per serverless run. Override with DELIVERY_BATCH_SIZE (1–20). */
const BATCH_SIZE = Math.min(20, Math.max(1, Number(process.env.DELIVERY_BATCH_SIZE) || 8));
const ITEM_DELAY_MS = 350;

/** Max file size for auto send (MB). Default 100. */
const MAX_FILE_BYTES =
  Math.min(200, Math.max(1, Number(process.env.DELIVERY_MAX_FILE_MB) || 100)) * 1024 * 1024;

const DELIVERABLE_STATUSES = ["awaiting_confirmation", "awaiting_payment"] as const;

export type MaterialFile = { path?: string | null; name?: string | null; url?: string | null };

type OrderItem = {
  id?: string;
  name_snapshot: string;
  file_path_snapshot: string | null;
  file_name_snapshot: string | null;
  file_path_kz_snapshot?: string | null;
  file_name_kz_snapshot?: string | null;
  file_url_snapshot?: string | null;
  file_url_kz_snapshot?: string | null;
  material_files_snapshot?: MaterialFile[] | null;
  material_files_kz_snapshot?: MaterialFile[] | null;
  quantity: number;
};

function legacyAsMaterials(path?: string | null, name?: string | null, url?: string | null): MaterialFile[] {
  if (url) return [{ url }];
  if (path) return [{ path, name }];
  return [];
}

export async function sendMaterialsToUser(
  chat_id: number,
  materials: MaterialFile[],
  caption: string,
  quantity: number,
): Promise<boolean> {
  for (let index = 0; index < materials.length; index++) {
    const material = materials[index];
    const itemCaption = index === 0 ? caption : "";
    if (material.url) {
      for (let copy = 0; copy < (quantity || 1); copy++) {
        const result = await tg("sendMessage", {
          chat_id,
          text: itemCaption
            ? `📁 <b>${itemCaption}</b>\n\n📥 <a href="${material.url}">Нажмите здесь, чтобы скачать файл</a>`
            : `📥 <a href="${material.url}">Нажмите здесь, чтобы скачать файл</a>`,
          parse_mode: "HTML",
        });
        if (!result?.ok) return false;
      }
    } else if (material.path) {
      const ok = await sendFileToUser(
        chat_id,
        material.path,
        material.name || "file.bin",
        itemCaption,
        quantity,
      );
      if (!ok) return false;
    }
  }
  return true;
}

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



/**
 * Deliver product files as Telegram documents in batches.
 * Each item is claimed with compare-and-swap so parallel cron/admin cannot double-send.
 * Digital goods: always 1 file copy (quantity is for price only).
 */
export async function deliverOrder(
  orderId: number,
  options?: { force?: boolean; resume?: boolean },
) {
  const { supabaseAdmin } = await import("@/integrations-supabase/client.server");

  let order: any;
  const isFullRedeliver = Boolean(options?.force && !options?.resume);

  if (options?.force) {
    const patch: TablesUpdate<"orders"> = { status: "delivering" };
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

  const items = ((order.order_items as OrderItem[]) || []).slice().sort((a, b) => {
    const ai = String(a.id || "");
    const bi = String(b.id || "");
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });

  if (items.length === 0) {
    await supabaseAdmin.from("orders").update({ status: "delivered", delivery_index: 0 }).eq("id", orderId);
    return { ok: true as const, pending: false, sent: 0, total: 0 };
  }

  let sent = 0;
  let announcedContinue = false;

  try {
    for (let n = 0; n < BATCH_SIZE; n++) {
      const { data: fresh, error: readErr } = await supabaseAdmin
        .from("orders")
        .select("status, delivery_index, telegram_id, order_no")
        .eq("id", orderId)
        .single();
      if (readErr || !fresh) throw new Error(readErr?.message || "Order not found");

      if (fresh.status !== "delivering") {
        return { ok: true as const, alreadyDelivered: true, sent, total: items.length };
      }

      const idx = Math.max(0, Number(fresh.delivery_index) || 0);
      if (idx >= items.length) break;

      // Мы не увеличиваем delivery_index заранее (чтобы не пропустить файл при краше Vercel/таймауте).
      // Если файл успешно отправлен, мы делаем CAS-обновление индекса.
      if (idx === 0) {
        await tg("sendMessage", {
          chat_id: fresh.telegram_id,
          text: `✅ Оплата подтверждена! Заказ #${(fresh as any).order_no ?? orderId}.\nОтправляю ваши материалы файлами (${items.length} шт.)…`,
        });
      } else if (!announcedContinue) {
        announcedContinue = true;
        await tg("sendMessage", {
          chat_id: fresh.telegram_id,
          text: `📤 Продолжаю выдачу заказа #${(fresh as any).order_no ?? orderId}: с позиции ${idx + 1} из ${items.length}…`,
        });
      }

      const item = items[idx];
      const materialsRu = item.material_files_snapshot?.length
        ? item.material_files_snapshot
        : legacyAsMaterials(item.file_path_snapshot, item.file_name_snapshot, item.file_url_snapshot);
      const materialsKz = item.material_files_kz_snapshot?.length
        ? item.material_files_kz_snapshot
        : legacyAsMaterials(item.file_path_kz_snapshot, item.file_name_kz_snapshot, item.file_url_kz_snapshot);

      // 1. Продвигаем индекс вперёд с помощью CAS ДО отправки файла
      const { data: updated } = await supabaseAdmin
        .from("orders")
        .update({ delivery_index: idx + 1, updated_at: new Date().toISOString() })
        .eq("id", orderId)
        .eq("status", "delivering")
        .eq("delivery_index", idx)
        .select("id")
        .maybeSingle();

      if (!updated) {
        // Другой воркер уже взял этот файл в работу (состояние гонки предотвращено).
        break;
      }

      let itemOk = true;
      try {
        if (materialsRu.length === 0 && materialsKz.length === 0) {
          // Нет файла — ничего не отправляем
          itemOk = true;
        } else if (materialsKz.length > 0) {
          await tg("sendMessage", {
            chat_id: fresh.telegram_id,
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
          itemOk = true;
        } else {
          // Always 1 copy — quantity is for cart price, not file copies.
          itemOk = await sendMaterialsToUser(fresh.telegram_id, materialsRu, item.name_snapshot, 1);
        }
      } catch (e) {
        itemOk = false;
        console.error(`[orders] deliver item ${idx} of order #${orderId} failed`, e);
      }

      if (!itemOk) {
        // Откат (Rollback) CAS лока с обязательным обновлением updated_at, 
        // чтобы cron подождал 2 минуты до следующей попытки и не спамил
        await supabaseAdmin
          .from("orders")
          .update({ delivery_index: idx, updated_at: new Date().toISOString() })
          .eq("id", orderId);

        await tg("sendMessage", {
          chat_id: fresh.telegram_id,
          text: `⚠️ Не удалось отправить «${item.name_snapshot}». Попробую ещё раз чуть позже; если не придёт — продавец вышлет вручную.`,
        });
        break;
      }


      sent++;
      if (n + 1 < BATCH_SIZE && idx + 1 < items.length) await sleep(ITEM_DELAY_MS);
    }

    const { data: after } = await supabaseAdmin
      .from("orders")
      .select("delivery_index, status, telegram_id")
      .eq("id", orderId)
      .single();

    const doneIdx = Number(after?.delivery_index) || 0;
    if (after?.status === "delivering" && doneIdx >= items.length) {
      const { data: finished } = await supabaseAdmin
        .from("orders")
        .update({ status: "delivered" })
        .eq("id", orderId)
        .eq("status", "delivering")
        .gte("delivery_index", items.length)
        .select("id")
        .maybeSingle();

      if (finished) {
        await tg("sendMessage", {
          chat_id: after.telegram_id,
          text: `🙏 Спасибо за покупку! Заказ #${orderId} выдан (${items.length} материалов). Если что-то не так — напишите продавцу.`,
        });
      }
      return { ok: true as const, pending: false, sent, total: items.length };
    }

    return {
      ok: true as const,
      pending: after?.status === "delivering" && doneIdx < items.length,
      sent,
      next: doneIdx,
      total: items.length,
    };
  } catch (e) {
    console.error(`[orders] deliverOrder #${orderId} interrupted`, e);
    throw e;
  }
}

/** Continue all orders stuck in delivering (called from cron). */
export async function processPendingDeliveries(limit = 3) {
  const { supabaseAdmin } = await import("@/integrations-supabase/client.server");
  const { data: rows, error } = await supabaseAdmin
    .from("orders")
    .select("id")
    .eq("status", "delivering")
    // Подхватывать зависшие только если прошло > 2 минут с последнего действия
    .lte("updated_at", new Date(Date.now() - 2 * 60 * 1000).toISOString())
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

/** Returns true if the document reached Telegram. */
export async function sendFileToUser(
  chat_id: number,
  path: string,
  downloadName: string,
  caption: string,
  quantity: number,
): Promise<boolean> {
  void quantity;
  const { supabaseAdmin } = await import("@/integrations-supabase/client.server");
  const filename = downloadName || "file.bin";
  const ext = (filename.split(".").pop() || "").toLowerCase();
  // Telegram can fetch these by URL — avoids Vercel RAM/timeout on big PDFs
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
  // Cloud Bot API hard limit ~50MB; Local Bot API can go higher via TELEGRAM_API_BASE
  const CLOUD_TG_MAX = 50 * 1024 * 1024;

  async function sendViaTelegramUrl(): Promise<boolean> {
    if (!signed?.signedUrl || !telegramUrlTypes.has(ext)) return false;
    if (fileSize > 0 && fileSize > Math.min(TG_MAX, CLOUD_TG_MAX) && !process.env.TELEGRAM_API_BASE) {
      // URL method also capped ~20MB by Telegram for some cases; still try below for pdf
    }
    const res = await tg("sendDocument", {
      chat_id,
      document: signed.signedUrl,
      caption,
    });
    if (!res?.ok) {
      console.error("[orders] sendDocument URL failed", res);
      return false;
    }
    return true;
  }

  // Prefer URL for pdf/zip/gif — Telegram downloads itself, no heavy Vercel upload
  if (telegramUrlTypes.has(ext)) {
    if (await sendViaTelegramUrl()) return true;
  }

  const { data: dl, error: dlErr } = await supabaseAdmin.storage.from("product-files").download(path);
  if (dlErr || !dl) {
    if (await sendViaTelegramUrl()) return true;
    console.error("[orders] storage download failed", path, dlErr);
    await tg("sendMessage", {
      chat_id,
      text: `⚠️ Не удалось получить файл «${caption}» из хранилища. Продавец вышлет вручную.`,
    });
    return true; // permanent — don't spin cron forever
  }

  // Прокидываем Blob напрямую в FormData через обновленный tgSendMultipart
  // Это потоковая передача, которая защищает Vercel от краша по памяти (OOM) на больших файлах (например, тяжелые .7z)
  const mime = dl.type || "application/octet-stream";

  if (dl.size === 0) {
    console.error("[orders] empty file", path);
    await tg("sendMessage", {
      chat_id,
      text: `⚠️ Файл «${caption}» пустой. Продавец вышлет вручную.`,
    });
    return true;
  }

  if (dl.size > TG_MAX) {
    if (await sendViaTelegramUrl()) return true;
    await tg("sendMessage", {
      chat_id,
      text: `⚠️ Файл «${caption}» слишком большой (${Math.round(dl.size / (1024 * 1024))} МБ, лимит ${Math.round(TG_MAX / (1024 * 1024))} МБ). Продавец вышлет вручную.`,
    });
    // Permanent size problem — treat as handled so we don't infinite-retry
    return true;
  }

  const res = await tgSendMultipart(
    "sendDocument",
    { chat_id, caption },
    { field: "document", filename, blob: dl, contentType: mime },
  );

  if (res?.ok) return true;

  console.error("[orders] sendDocument multipart failed", res);
  if (await sendViaTelegramUrl()) return true;

  if (dl.size > CLOUD_TG_MAX) {
    await tg("sendMessage", {
      chat_id,
      text: `⚠️ Файл «${caption}» (${Math.round(dl.size / (1024 * 1024))} МБ) не проходит через облачный Telegram API (лимит ~50 МБ). Нужен Local Bot API или ручная выдача.`,
    });
    return true; // don't spin forever without Local API
  }

  return false;
}
