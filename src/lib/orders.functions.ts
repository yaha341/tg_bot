import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin } from "./admin-session.server";
import { tg, tgSendMultipart } from "./telegram.server";

async function db() {
  const { supabaseAdmin } = await import("@/integrations-supabase/client.server");
  return supabaseAdmin;
}

export const listOrders = createServerFn({ method: "GET" }).handler(async () => {
  await requireAdmin();
  const s = await db();
  const { data, error } = await s
    .from("orders")
    .select("*, order_items(id, name_snapshot, price_snapshot, quantity)")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(error.message);
  return data ?? [];
});

export const getOrder = createServerFn({ method: "GET" })
  .validator((d: unknown) => z.object({ id: z.number().int() }).parse(d))
  .handler(async ({ data }) => {
    await requireAdmin();
    const s = await db();
    const { data: order, error } = await s
      .from("orders")
      .select("*, order_items(*)")
      .eq("id", data.id)
      .single();
    if (error) throw new Error(error.message);
    return order;
  });

export const confirmOrder = createServerFn({ method: "POST" })
  .validator((d: unknown) => z.object({ id: z.number().int() }).parse(d))
  .handler(async ({ data }) => {
    await requireAdmin();
    return await deliverOrder(data.id);
  });

export const rejectOrder = createServerFn({ method: "POST" })
  .validator((d: unknown) => z.object({ id: z.number().int(), note: z.string().max(500).optional() }).parse(d))
  .handler(async ({ data }) => {
    await requireAdmin();
    const s = await db();
    const { data: order, error } = await s
      .from("orders")
      .update({ status: "rejected", admin_note: data.note ?? null })
      .eq("id", data.id)
      .select("telegram_id")
      .single();
    if (error) throw new Error(error.message);
    await tg("sendMessage", {
      chat_id: order!.telegram_id,
      text: `❌ Ваш заказ #${data.id} отклонён.\n${data.note ? `\nПричина: ${data.note}\n` : ""}\nЕсли это ошибка — напишите продавцу.`,
    });
    return { ok: true as const };
  });

// Shared: deliver files to user and mark order delivered. Used by admin panel and bot callback.
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

  for (const item of order.order_items as Array<{
    name_snapshot: string;
    file_path_snapshot: string | null;
    file_name_snapshot: string | null;
    quantity: number;
  }>) {
    const path = item.file_path_snapshot;
    if (!path) {
      await tg("sendMessage", {
        chat_id: order.telegram_id,
        text: `⚠️ Файл для «${item.name_snapshot}» не настроен. Продавец вышлет вручную.`,
      });
      continue;
    }
    
    // Create signed download URL valid for ~10 years
    const { data: signed, error: signErr } = await supabaseAdmin.storage
      .from("product-files")
      .createSignedUrl(path, 60 * 60 * 24 * 365 * 10, {
        download: item.file_name_snapshot || "file.bin"
      });
      
    if (signErr || !signed) {
      await tg("sendMessage", {
        chat_id: order.telegram_id,
        text: `⚠️ Не удалось получить файл «${item.name_snapshot}». Продавец вышлет вручную.`,
      });
      continue;
    }

    let fileSize = 0;
    try {
      const headRes = await fetch(signed.signedUrl, { method: "HEAD" });
      fileSize = Number(headRes.headers.get("content-length")) || 0;
    } catch(e) {}

    let sentAsFile = false;
    
    // Only attempt to send via Telegram if it's less than 15MB to avoid Vercel timeouts
    if (fileSize > 0 && fileSize < 15 * 1024 * 1024) {
      try {
        const { data: dl, error: dlErr } = await supabaseAdmin.storage
          .from("product-files")
          .download(path);
          
        if (!dlErr && dl) {
          const bytes = new Uint8Array(await dl.arrayBuffer());
          const filename = item.file_name_snapshot || "file.bin";
          const mime = dl.type || "application/octet-stream";
          
          for (let i = 0; i < (item.quantity || 1); i++) {
            await tgSendMultipart(
              "sendDocument",
              { chat_id: order.telegram_id, caption: item.name_snapshot },
              { field: "document", filename, bytes, contentType: mime },
            );
          }
          sentAsFile = true;
        }
      } catch (e) {
        // Fallback to sending link if Telegram upload fails (e.g., fetch failed)
        console.error("Failed to upload file to Telegram", e);
      }
    }
    
    if (!sentAsFile) {
      for (let i = 0; i < (item.quantity || 1); i++) {
        await tg("sendMessage", {
          chat_id: order.telegram_id,
          text: `📁 <b>${item.name_snapshot}</b>\n\n📥 <a href="${signed.signedUrl}">Нажмите здесь, чтобы скачать файл</a>\n<i>(Ссылка для скачивания)</i>`,
          parse_mode: "HTML"
        });
      }
    }
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

export const getScreenshotUrl = createServerFn({ method: "GET" })
  .validator((d: string) => d)
  .handler(async (ctx) => {
    await requireAdmin();
    const path = ctx.data;
    const { supabaseAdmin } = await import("@/integrations-supabase/client.server");
    const { data } = await supabaseAdmin.storage
      .from("payment-proofs")
      .createSignedUrl(path, 60 * 60);
    return data?.signedUrl || null;
  });