import { createFileRoute } from "@tanstack/react-router";

const SLUGS = {
  offer: {
    htmlKey: "legal_offer_html",
    fileKey: "legal_offer_file",
    nameKey: "legal_offer_filename",
    title: "Договор оферты",
  },
  privacy: {
    htmlKey: "legal_privacy_html",
    fileKey: "legal_privacy_file",
    nameKey: "legal_privacy_filename",
    title: "Политика конфиденциальности",
  },
  requisites: {
    htmlKey: "legal_seller_details",
    fileKey: null,
    nameKey: null,
    title: "Реквизиты",
  },
  about: {
    htmlKey: "legal_about_html",
    fileKey: null,
    nameKey: null,
    title: "О продавце",
  },
} as const;

type Slug = keyof typeof SLUGS;

function isSlug(v: string): v is Slug {
  return v in SLUGS;
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Bust browser / Telegram / Office Online caches when file path changes. */
function versionToken(filePath: string): string {
  // path already includes timestamp; keep URL-safe short token (no encode — URLSearchParams handles it)
  return filePath.replace(/[^\w.-]+/g, "").slice(-48) || "1";
}

const NO_CACHE = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
} as const;

function wrapPage(title: string, bodyHtml: string, downloadUrl?: string) {
  const downloadLink = downloadUrl
    ? `<p style="margin-bottom:1.5rem"><a href="${escapeHtml(downloadUrl)}">⬇ Скачать оригинал файла</a></p>`
    : "";
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="Cache-Control" content="no-store" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 44rem; margin: 2rem auto; padding: 0 1.25rem 3rem; line-height: 1.55; color: #1a1a1a; }
    h1, h2, h3 { line-height: 1.25; }
    pre { white-space: pre-wrap; font-family: inherit; }
    a { color: #0b57d0; }
    .doc-body img { max-width: 100%; height: auto; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  ${downloadLink}
  <div class="doc-body">${bodyHtml}</div>
</body>
</html>`;
}

function officeViewerFallback(title: string, fileUrl: string, fileName: string) {
  const viewerSrc = `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(fileUrl)}`;
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="Cache-Control" content="no-store" />
  <title>${escapeHtml(title)}</title>
  <style>
    html, body { margin: 0; height: 100%; font-family: system-ui, sans-serif; }
    .bar { padding: 0.75rem 1rem; border-bottom: 1px solid #e5e5e5; display: flex; gap: 1rem; align-items: center; flex-wrap: wrap; }
    .bar h1 { font-size: 1rem; margin: 0; flex: 1; }
    .bar a { color: #0b57d0; text-decoration: none; font-size: 0.9rem; }
    iframe { border: 0; width: 100%; height: calc(100% - 3.25rem); }
  </style>
</head>
<body>
  <div class="bar">
    <h1>${escapeHtml(title)}</h1>
    <a href="${escapeHtml(fileUrl)}" download="${escapeHtml(fileName)}">Скачать файл</a>
  </div>
  <iframe src="${escapeHtml(viewerSrc)}" title="${escapeHtml(title)}" allowfullscreen></iframe>
</body>
</html>`;
}

function contentTypeForName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext === "pdf") return "application/pdf";
  if (ext === "doc") return "application/msword";
  if (ext === "docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  return "application/octet-stream";
}

function extOf(name: string): string {
  return (name.split(".").pop() || "").toLowerCase();
}

export const Route = createFileRoute("/legal/$slug")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const slug = params.slug;
        if (!isSlug(slug)) {
          return new Response("Not found", { status: 404 });
        }

        const reqUrl = new URL(request.url);
        const wantRaw = reqUrl.searchParams.get("raw") === "1";
        const clientV = reqUrl.searchParams.get("v") || "";

        const meta = SLUGS[slug];
        const { supabaseAdmin } = await import("@/integrations-supabase/client.server");
        const keys = [meta.htmlKey, meta.fileKey, meta.nameKey].filter(Boolean) as string[];
        const { data: rows } = await supabaseAdmin.from("app_settings").select("key, value").in("key", keys);
        const get = (key: string | null) =>
          key ? (rows?.find((r) => r.key === key)?.value as string | undefined)?.trim() || "" : "";

        const filePath = get(meta.fileKey);
        if (filePath) {
          const fileName = get(meta.nameKey) || filePath;
          const ext = extOf(fileName) || extOf(filePath);
          const v = versionToken(filePath);

          // Force a unique URL per uploaded file so Telegram / Office / CDN don't keep the old PDF
          if (clientV !== v) {
            const next = new URL(reqUrl);
            next.searchParams.set("v", v);
            return new Response(null, {
              status: 302,
              headers: {
                Location: `${next.pathname}${next.search}`,
                ...NO_CACHE,
              },
            });
          }

          const origin =
            process.env.PUBLIC_APP_URL?.replace(/\/$/, "") ||
            `${reqUrl.protocol}//${reqUrl.host}`;
          const rawUrl = `${origin}/legal/${slug}?raw=1&v=${v}`;

          // DOCX → HTML page (opens as website, including in Telegram)
          if (ext === "docx" && !wantRaw) {
            const { data, error } = await supabaseAdmin.storage.from("legal-docs").download(filePath);
            if (error || !data) {
              return new Response("Файл документа не найден", { status: 404, headers: { ...NO_CACHE } });
            }
            try {
              const mammoth = await import("mammoth");
              const arrayBuffer = await data.arrayBuffer();
              const result = await mammoth.convertToHtml({ arrayBuffer });
              return new Response(wrapPage(meta.title, result.value || "<p>(пустой документ)</p>", rawUrl), {
                headers: { "Content-Type": "text/html; charset=utf-8", ...NO_CACHE },
              });
            } catch (e) {
              console.error("[legal] mammoth convert failed", e);
              return new Response(officeViewerFallback(meta.title, rawUrl, fileName), {
                headers: { "Content-Type": "text/html; charset=utf-8", ...NO_CACHE },
              });
            }
          }

          // Old .doc — Office Online viewer page
          if (ext === "doc" && !wantRaw) {
            return new Response(officeViewerFallback(meta.title, rawUrl, fileName), {
              headers: { "Content-Type": "text/html; charset=utf-8", ...NO_CACHE },
            });
          }

          // PDF (or ?raw=1 for any) — stream file
          const { data, error } = await supabaseAdmin.storage.from("legal-docs").download(filePath);
          if (error || !data) {
            return new Response("Файл документа не найден", { status: 404, headers: { ...NO_CACHE } });
          }
          const buf = await data.arrayBuffer();
          const asciiName = fileName.replace(/[^\x20-\x7E]/g, "_") || "document.pdf";
          const ctype =
            data.type && data.type !== "application/octet-stream" ? data.type : contentTypeForName(fileName);
          return new Response(buf, {
            headers: {
              "Content-Type": ctype,
              "Content-Disposition": `inline; filename="${asciiName}"`,
              "Access-Control-Allow-Origin": "*",
              ...NO_CACHE,
            },
          });
        }

        const raw = get(meta.htmlKey);
        let bodyHtml: string;
        if (!raw) {
          bodyHtml = `<p>Документ пока не загружен. Загрузите файл в админ-панели → Настройки.</p>`;
        } else if (slug === "requisites") {
          bodyHtml = `<pre>${escapeHtml(raw)}</pre>`;
        } else if (raw.includes("<")) {
          return new Response(wrapPage(meta.title, raw), {
            headers: { "Content-Type": "text/html; charset=utf-8", ...NO_CACHE },
          });
        } else {
          bodyHtml = `<pre>${escapeHtml(raw)}</pre>`;
        }

        return new Response(wrapPage(meta.title, bodyHtml), {
          headers: { "Content-Type": "text/html; charset=utf-8", ...NO_CACHE },
        });
      },
    },
  },
});
