const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  heic: "image/heic",
  pdf: "application/pdf",
};

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "heic"]);

export function mimeFromPath(filename: string, fallback = "application/octet-stream"): string {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  if (ext === "octet-stream") return "image/jpeg";
  return MIME_BY_EXT[ext] || fallback;
}

export function paymentProofKind(path: string): "image" | "pdf" | "other" {
  const ext = (path.split(".").pop() || "").toLowerCase();
  if (ext === "pdf") return "pdf";
  if (ext === "octet-stream") return "image";
  if (IMAGE_EXTS.has(ext)) return "image";
  return "other";
}

/** Infer MIME + extension from Telegram file path (photos/…jpg) and optional response header. */
export function resolveTelegramFileMeta(
  telegramPath: string,
  headerMime?: string | null,
): { mime: string; ext: string } {
  const pathExt = (telegramPath.split(".").pop() || "").toLowerCase();
  const hasExt = pathExt && pathExt !== telegramPath.toLowerCase();

  if (hasExt && MIME_BY_EXT[pathExt]) {
    return {
      mime: MIME_BY_EXT[pathExt],
      ext: pathExt === "jpeg" ? "jpg" : pathExt,
    };
  }

  const cleanHeader = (headerMime || "").split(";")[0].trim();
  if (cleanHeader && cleanHeader !== "application/octet-stream" && cleanHeader.includes("/")) {
    const sub = cleanHeader.split("/")[1] || "jpg";
    const ext = sub === "jpeg" ? "jpg" : sub;
    return { mime: cleanHeader, ext };
  }

  if (telegramPath.includes("/photos/")) {
    return { mime: "image/jpeg", ext: "jpg" };
  }

  return { mime: "image/jpeg", ext: "jpg" };
}
