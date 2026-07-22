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

function wrapPage(title: string, bodyHtml: string) {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 44rem; margin: 2rem auto; padding: 0 1.25rem 3rem; line-height: 1.55; color: #1a1a1a; }
    h1, h2, h3 { line-height: 1.25; }
    pre { white-space: pre-wrap; font-family: inherit; }
    a { color: #0b57d0; }
  </style>
</head>
<body>
${bodyHtml}
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

export const Route = createFileRoute("/legal/$slug")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const slug = params.slug;
        if (!isSlug(slug)) {
          return new Response("Not found", { status: 404 });
        }

        const meta = SLUGS[slug];
        const { supabaseAdmin } = await import("@/integrations-supabase/client.server");
        const keys = [meta.htmlKey, meta.fileKey, meta.nameKey].filter(Boolean) as string[];
        const { data: rows } = await supabaseAdmin.from("app_settings").select("key, value").in("key", keys);
        const get = (key: string | null) =>
          key ? (rows?.find((r) => r.key === key)?.value as string | undefined)?.trim() || "" : "";

        const filePath = get(meta.fileKey);
        if (filePath) {
          const fileName = get(meta.nameKey) || filePath;
          const { data, error } = await supabaseAdmin.storage.from("legal-docs").download(filePath);
          if (error || !data) {
            return new Response("Файл документа не найден", { status: 404 });
          }
          const buf = await data.arrayBuffer();
          const asciiName = fileName.replace(/[^\x20-\x7E]/g, "_") || "document.pdf";
          return new Response(buf, {
            headers: {
              "Content-Type": data.type || contentTypeForName(fileName),
              "Content-Disposition": `inline; filename="${asciiName}"`,
              "Cache-Control": "public, max-age=300",
            },
          });
        }

        const raw = get(meta.htmlKey);
        let bodyHtml: string;
        if (!raw) {
          bodyHtml = `<h1>${escapeHtml(meta.title)}</h1><p>Документ пока не загружен. Загрузите файл в админ-панели → Настройки.</p>`;
        } else if (slug === "requisites") {
          bodyHtml = `<h1>${escapeHtml(meta.title)}</h1><pre>${escapeHtml(raw)}</pre>`;
        } else if (raw.includes("<")) {
          bodyHtml = raw;
        } else {
          bodyHtml = `<h1>${escapeHtml(meta.title)}</h1><pre>${escapeHtml(raw)}</pre>`;
        }

        return new Response(wrapPage(meta.title, bodyHtml), {
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=60" },
        });
      },
    },
  },
});
