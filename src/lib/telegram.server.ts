/** Telegram Bot API base. Use Local Bot API for files >50MB (up to ~2GB). */
function apiBase(): string {
  return (process.env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/$/, "");
}

function token() {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  if (!t) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  return t;
}

function botUrl(method: string) {
  return `${apiBase()}/bot${token()}/${method}`;
}

export async function tg(method: string, payload: unknown) {
  const res = await fetch(botUrl(method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data && data.ok === false)) {
    console.error(`[telegram] ${method} failed`, res.status, data);
  }
  return data as { ok: boolean; result?: unknown; description?: string };
}

export async function tgSendMultipart(
  method: string,
  fields: Record<string, string | number>,
  file: { field: string; filename: string; bytes: Uint8Array; contentType: string },
) {
  return tgSendMultipartMany(method, fields, [file]);
}

export async function tgSendMultipartMany(
  method: string,
  fields: Record<string, string | number>,
  files: Array<{ field: string; filename: string; bytes: Uint8Array; contentType: string }>,
) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  for (const file of files) {
    fd.append(
      file.field,
      new Blob([file.bytes as BlobPart], { type: file.contentType }),
      file.filename,
    );
  }
  const res = await fetch(botUrl(method), {
    method: "POST",
    body: fd,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data && data.ok === false)) {
    console.error(`[telegram] ${method} multipart failed`, res.status, data);
  }
  return data as { ok: boolean; result?: unknown; description?: string };
}

export async function downloadTelegramFile(file_id: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const info = await tg("getFile", { file_id });
  // @ts-expect-error dynamic
  const path = info?.result?.file_path as string | undefined;
  if (!path) return null;
  const res = await fetch(`${apiBase()}/file/bot${token()}/${path}`);
  if (!res.ok) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  const mime = res.headers.get("content-type") || "application/octet-stream";
  return { bytes, mime };
}
