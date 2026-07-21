import { tg } from "./telegram.server";

const BATCH_SIZE = 25;
const SEND_DELAY_MS = 80;
const TELEGRAM_MEDIA_GROUP_MAX = 10;

export type AudienceType = "all" | "country" | "buyers" | "non_buyers" | "test";

export type BroadcastPayload = {
  message_text: string;
  photo_paths: string[];
  product_ids: string[];
  show_catalog: boolean;
  audience_type: AudienceType;
  audience_filter?: { country_code?: string };
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function originFromEnv(): string {
  return (
    process.env.PUBLIC_APP_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "") ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "") ||
    "http://localhost:3000"
  );
}

function broadcastImageUrl(path: string): string {
  const key = path.includes("/") ? path : `broadcast-images/${path}`;
  return `${originFromEnv()}/api/public/img/${key}`;
}

async function db() {
  const { supabaseAdmin } = await import("@/integrations-supabase/client.server");
  return supabaseAdmin;
}

export async function resolveAudienceIds(
  audience_type: AudienceType,
  audience_filter?: { country_code?: string },
): Promise<number[]> {
  const s = await db();

  if (audience_type === "test") {
    const { data: setting } = await s.from("app_settings").select("value").eq("key", "admin_chat_id").maybeSingle();
    if (!setting?.value) return [];
    return setting.value
      .split(",")
      .map((v) => Number(v.trim()))
      .filter((id) => Number.isFinite(id) && id > 0);
  }

  if (audience_type === "buyers") {
    const { data: orders } = await s.from("orders").select("telegram_id").eq("status", "delivered");
    return [...new Set((orders ?? []).map((o) => o.telegram_id as number))];
  }

  if (audience_type === "non_buyers") {
    const buyerIds = await resolveAudienceIds("buyers");
    const buyerSet = new Set(buyerIds);
    const { data: users } = await s.from("bot_users").select("telegram_id");
    return (users ?? []).map((u) => u.telegram_id as number).filter((id) => !buyerSet.has(id));
  }

  if (audience_type === "country") {
    const code = audience_filter?.country_code?.trim();
    if (!code) return [];
    const { data: users } = await s.from("bot_users").select("telegram_id, state");
    return (users ?? [])
      .filter((u) => (u.state as { country_code?: string } | null)?.country_code === code)
      .map((u) => u.telegram_id as number);
  }

  const { data: users } = await s.from("bot_users").select("telegram_id");
  return (users ?? []).map((u) => u.telegram_id as number);
}

async function buildInlineKeyboard(product_ids: string[], show_catalog: boolean) {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];

  if (product_ids.length > 0) {
    const s = await db();
    const { data: products } = await s.from("products").select("id, name").in("id", product_ids);
    const byId = new Map((products ?? []).map((p) => [p.id as string, p.name as string]));
    for (const id of product_ids.slice(0, 8)) {
      const name = byId.get(id) || "Товар";
      const label = name.length > 36 ? `${name.slice(0, 33)}…` : name;
      rows.push([{ text: `📖 ${label}`, callback_data: `prod:${id}` }]);
    }
  }

  if (show_catalog) {
    rows.push([{ text: "📚 Открыть каталог", callback_data: "cat:root:0" }]);
  }

  return rows.length > 0 ? { inline_keyboard: rows } : undefined;
}

async function tgOrThrow(method: string, payload: unknown) {
  const res = await tg(method, payload);
  if (!res.ok) {
    throw new Error(res.description || `${method} failed`);
  }
  return res;
}

export async function sendBroadcastMessage(
  telegram_id: number,
  payload: Pick<BroadcastPayload, "message_text" | "photo_paths" | "product_ids" | "show_catalog">,
) {
  const text = payload.message_text.trim();
  const photos = payload.photo_paths.slice(0, TELEGRAM_MEDIA_GROUP_MAX);
  const reply_markup = await buildInlineKeyboard(payload.product_ids, payload.show_catalog);

  if (photos.length === 0) {
    await tgOrThrow("sendMessage", {
      chat_id: telegram_id,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(reply_markup ? { reply_markup } : {}),
    });
    return;
  }

  if (photos.length === 1) {
    await tgOrThrow("sendPhoto", {
      chat_id: telegram_id,
      photo: broadcastImageUrl(photos[0]),
      caption: text,
      parse_mode: "HTML",
      ...(reply_markup ? { reply_markup } : {}),
    });
    return;
  }

  await tgOrThrow("sendMediaGroup", {
    chat_id: telegram_id,
    media: photos.map((path, idx) => ({
      type: "photo",
      media: broadcastImageUrl(path),
      ...(idx === 0 ? { caption: text, parse_mode: "HTML" } : {}),
    })),
  });

  if (reply_markup) {
    await tgOrThrow("sendMessage", {
      chat_id: telegram_id,
      text: "👇 Выберите материал:",
      reply_markup,
    });
  }
}

function classifyTelegramError(description?: string): "blocked" | "failed" {
  const msg = (description || "").toLowerCase();
  if (msg.includes("blocked") || msg.includes("deactivated") || msg.includes("chat not found")) {
    return "blocked";
  }
  return "failed";
}

export async function createBroadcast(payload: BroadcastPayload) {
  const s = await db();
  const telegramIds = await resolveAudienceIds(payload.audience_type, payload.audience_filter);
  const uniqueIds = [...new Set(telegramIds)];

  if (uniqueIds.length === 0) {
    throw new Error("Не найдено получателей для выбранной аудитории.");
  }

  const active = await s
    .from("broadcasts")
    .select("id")
    .in("status", ["queued", "sending"])
    .limit(1)
    .maybeSingle();
  if (active) {
    throw new Error("Уже идёт другая рассылка. Дождитесь завершения.");
  }

  const { data: broadcast, error } = await s
    .from("broadcasts")
    .insert({
      status: "queued",
      message_text: payload.message_text,
      photo_paths: payload.photo_paths,
      product_ids: payload.product_ids,
      show_catalog: payload.show_catalog,
      audience_type: payload.audience_type,
      audience_filter: payload.audience_filter ?? {},
      total_count: uniqueIds.length,
    })
    .select("*")
    .single();

  if (error || !broadcast) throw new Error(error?.message || "Не удалось создать рассылку");

  const rows = uniqueIds.map((telegram_id) => ({
    broadcast_id: broadcast.id,
    telegram_id,
    status: "pending",
  }));

  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error: insErr } = await s.from("broadcast_recipients").insert(chunk);
    if (insErr) throw new Error(insErr.message);
  }

  return broadcast;
}

export async function processBroadcastBatch() {
  const s = await db();

  const { data: broadcast } = await s
    .from("broadcasts")
    .select("*")
    .in("status", ["queued", "sending"])
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!broadcast) return { processed: 0, done: true };

  if (broadcast.status === "queued") {
    await s
      .from("broadcasts")
      .update({ status: "sending", started_at: new Date().toISOString() })
      .eq("id", broadcast.id);
  }

  const { data: pending } = await s
    .from("broadcast_recipients")
    .select("id, telegram_id")
    .eq("broadcast_id", broadcast.id)
    .eq("status", "pending")
    .limit(BATCH_SIZE);

  if (!pending?.length) {
    const { data: final } = await s
      .from("broadcasts")
      .select("sent_count, total_count")
      .eq("id", broadcast.id)
      .single();
    const finalStatus = final && final.sent_count === 0 && final.total_count > 0 ? "failed" : "completed";
    await s
      .from("broadcasts")
      .update({ status: finalStatus, completed_at: new Date().toISOString() })
      .eq("id", broadcast.id);
    return { processed: 0, done: true, broadcast_id: broadcast.id };
  }

  const payload = {
    message_text: broadcast.message_text as string,
    photo_paths: (broadcast.photo_paths as string[]) ?? [],
    product_ids: (broadcast.product_ids as string[]) ?? [],
    show_catalog: Boolean(broadcast.show_catalog),
  };

  let sent = 0;
  let failed = 0;
  let blocked = 0;

  for (let i = 0; i < pending.length; i++) {
    const recipient = pending[i];
    try {
      await sendBroadcastMessage(recipient.telegram_id as number, payload);
      await s
        .from("broadcast_recipients")
        .update({ status: "sent", sent_at: new Date().toISOString(), error_message: null })
        .eq("id", recipient.id);
      sent++;
    } catch (e: any) {
      const kind = classifyTelegramError(e?.message);
      await s
        .from("broadcast_recipients")
        .update({
          status: kind,
          error_message: e?.message || "Unknown error",
        })
        .eq("id", recipient.id);
      if (kind === "blocked") blocked++;
      else failed++;
    }

    if (i + 1 < pending.length) await sleep(SEND_DELAY_MS);
  }

  const { data: fresh } = await s.from("broadcasts").select("sent_count, failed_count, blocked_count").eq("id", broadcast.id).single();
  await s
    .from("broadcasts")
    .update({
      sent_count: (fresh?.sent_count ?? 0) + sent,
      failed_count: (fresh?.failed_count ?? 0) + failed,
      blocked_count: (fresh?.blocked_count ?? 0) + blocked,
    })
    .eq("id", broadcast.id);

  const { count } = await s
    .from("broadcast_recipients")
    .select("id", { count: "exact", head: true })
    .eq("broadcast_id", broadcast.id)
    .eq("status", "pending");

  if (!count) {
    const { data: final2 } = await s
      .from("broadcasts")
      .select("sent_count, total_count")
      .eq("id", broadcast.id)
      .single();
    const finalStatus2 = final2 && final2.sent_count === 0 && final2.total_count > 0 ? "failed" : "completed";
    await s
      .from("broadcasts")
      .update({ status: finalStatus2, completed_at: new Date().toISOString() })
      .eq("id", broadcast.id);
    return { processed: pending.length, done: true, broadcast_id: broadcast.id };
  }

  return { processed: pending.length, done: false, broadcast_id: broadcast.id };
}

export async function cancelBroadcast(broadcastId: string) {
  const s = await db();
  const { data: row } = await s
    .from("broadcasts")
    .select("id, status")
    .eq("id", broadcastId)
    .single();

  if (!row) throw new Error("Рассылка не найдена.");
  if (row.status !== "queued" && row.status !== "sending") {
    throw new Error("Отменить можно только активную рассылку.");
  }

  await s
    .from("broadcast_recipients")
    .update({ status: "failed", error_message: "cancelled" })
    .eq("broadcast_id", broadcastId)
    .eq("status", "pending");

  await s
    .from("broadcasts")
    .update({ status: "cancelled", completed_at: new Date().toISOString() })
    .eq("id", broadcastId);

  return { ok: true as const };
}

export async function sendTestBroadcast(payload: BroadcastPayload) {
  const ids = await resolveAudienceIds("test");
  if (!ids.length) throw new Error("Не настроен admin_chat_id в настройках.");
  for (const telegram_id of ids) {
    await sendBroadcastMessage(telegram_id, payload);
  }
  return { ok: true as const, sent_to: ids.length };
}
