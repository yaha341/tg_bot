import { createFileRoute } from "@tanstack/react-router";

const SLUGS = {
  offer: { key: "legal_offer_html", title: "Договор оферты" },
  privacy: { key: "legal_privacy_html", title: "Политика конфиденциальности" },
  requisites: { key: "legal_seller_details", title: "Реквизиты" },
  about: { key: "legal_about_html", title: "О продавце" },
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
        const { data } = await supabaseAdmin
          .from("app_settings")
          .select("value")
          .eq("key", meta.key)
          .maybeSingle();

        const raw = (data?.value as string | undefined)?.trim() || "";
        let bodyHtml: string;
        if (!raw) {
          bodyHtml = `<h1>${escapeHtml(meta.title)}</h1><p>Документ пока не заполнен. Укажите текст в админ-панели → Настройки.</p>`;
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
