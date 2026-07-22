import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components-ui/button";
import { Checkbox } from "@/components-ui/checkbox";
import { Input } from "@/components-ui/input";
import { Label } from "@/components-ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components-ui/select";
import { Textarea } from "@/components-ui/textarea";
import { EmojiInsertBar, insertAtCursor } from "@/components-ui/emoji-insert-bar";
import {
  cancelBroadcastFn,
  getBroadcastFn,
  getBroadcastUploadUrl,
  listBroadcastsFn,
  previewBroadcastAudience,
  processBroadcastBatchFn,
  sendTestBroadcastFn,
  startBroadcastFn,
} from "@/lib/broadcast.functions";
import { listPaymentMethods } from "@/lib/payment-methods.functions";
import { listProducts } from "@/lib/products.functions";

export const Route = createFileRoute("/admin/broadcast")({
  component: BroadcastPage,
});

type AudienceType = "all" | "country" | "buyers" | "non_buyers" | "test";

const audienceLabels: Record<AudienceType, string> = {
  all: "Все пользователи бота",
  buyers: "Только покупатели",
  non_buyers: "Только не покупавшие",
  country: "По стране",
  test: "Тест (admin Telegram ID)",
};

function BroadcastPage() {
  const qc = useQueryClient();
  const products = useQuery({ queryKey: ["products"], queryFn: () => listProducts() });
  const paymentMethods = useQuery({ queryKey: ["payment-methods"], queryFn: () => listPaymentMethods() });
  const broadcasts = useQuery({ queryKey: ["broadcasts"], queryFn: () => listBroadcastsFn() });

  const [messageText, setMessageText] = useState("");
  const [photoPaths, setPhotoPaths] = useState<string[]>([]);
  const [selectedProducts, setSelectedProducts] = useState<string[]>([]);
  const [showCatalog, setShowCatalog] = useState(true);
  const [audienceType, setAudienceType] = useState<AudienceType>("all");
  const [countryCode, setCountryCode] = useState("RU");
  const [audienceCount, setAudienceCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);

  function insertEmoji(emoji: string) {
    const el = messageRef.current;
    const { next, cursor } = insertAtCursor(
      messageText,
      emoji,
      el?.selectionStart ?? null,
      el?.selectionEnd ?? null,
    );
    setMessageText(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(cursor, cursor);
    });
  }

  const activeBroadcast = useQuery({
    queryKey: ["broadcast", activeId],
    queryFn: () => getBroadcastFn({ data: { id: activeId! } }),
    enabled: !!activeId,
    refetchInterval: (q) => {
      const st = (q.state.data as any)?.status;
      return st === "queued" || st === "sending" ? 2000 : false;
    },
  });

  const payload = useMemo(
    () => ({
      message_text: messageText,
      photo_paths: photoPaths,
      product_ids: selectedProducts,
      show_catalog: showCatalog,
      audience_type: audienceType,
      audience_filter: audienceType === "country" ? { country_code: countryCode.trim().toUpperCase() } : undefined,
    }),
    [messageText, photoPaths, selectedProducts, showCatalog, audienceType, countryCode],
  );

  useEffect(() => {
    let cancelled = false;
    previewBroadcastAudience({
      data: {
        audience_type: audienceType,
        country_code: audienceType === "country" ? countryCode.trim().toUpperCase() : undefined,
      },
    })
      .then((res) => {
        if (!cancelled) setAudienceCount(res.count);
      })
      .catch(() => {
        if (!cancelled) setAudienceCount(null);
      });
    return () => {
      cancelled = true;
    };
  }, [audienceType, countryCode]);

  useEffect(() => {
    const running = (broadcasts.data as any[])?.find((b) => b.status === "queued" || b.status === "sending");
    if (running) setActiveId(running.id);
  }, [broadcasts.data]);

  async function onUploadPhotos(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    try {
      const next = [...photoPaths];
      for (const file of Array.from(files)) {
        if (next.length >= 10) break;
        const { path, signedUrl } = await getBroadcastUploadUrl({ data: { filename: file.name } });
        const res = await fetch(signedUrl, { method: "PUT", body: file, headers: { "Content-Type": file.type || "image/jpeg" } });
        if (!res.ok) throw new Error(`Не удалось загрузить ${file.name}`);
        next.push(path);
      }
      setPhotoPaths(next);
    } catch (e: any) {
      alert(e.message);
    } finally {
      setUploading(false);
    }
  }

  async function onTestSend() {
    if (!messageText.trim()) return alert("Введите текст сообщения.");
    setBusy(true);
    try {
      await sendTestBroadcastFn({ data: { ...payload, audience_type: "test" } });
      alert("Тестовое сообщение отправлено на admin Telegram ID.");
    } catch (e: any) {
      alert(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function onStart() {
    if (!messageText.trim()) return alert("Введите текст сообщения.");
    if (audienceType !== "test" && !confirm(`Запустить рассылку для ~${audienceCount ?? "?"} получателей?`)) return;
    setBusy(true);
    try {
      const row = await startBroadcastFn({ data: payload });
      setActiveId(row.id as string);
      await qc.invalidateQueries({ queryKey: ["broadcasts"] });
    } catch (e: any) {
      alert(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function onProcessNow() {
    setBusy(true);
    try {
      await processBroadcastBatchFn();
      await qc.invalidateQueries({ queryKey: ["broadcasts"] });
      if (activeId) await qc.invalidateQueries({ queryKey: ["broadcast", activeId] });
    } finally {
      setBusy(false);
    }
  }

  const productList = (products.data ?? []) as any[];
  const countryOptions = ((paymentMethods.data ?? []) as any[]).filter((m) => m.is_active);

  function broadcastPhotoUrl(path: string) {
    return `/api/public/img/broadcast-images/${encodeURIComponent(path)}`;
  }

  function removePhoto(path: string) {
    setPhotoPaths((prev) => prev.filter((p) => p !== path));
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <h1 className="text-2xl font-semibold">Рассылка</h1>

      <div className="bg-card border rounded-lg p-4 space-y-4">
        <div className="space-y-2">
          <Label>Аудитория</Label>
          <div className="grid gap-2">
            {(Object.keys(audienceLabels) as AudienceType[])
              .filter((k) => k !== "test")
              .map((key) => (
                <label key={key} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="radio"
                    name="audience"
                    checked={audienceType === key}
                    onChange={() => setAudienceType(key)}
                  />
                  {audienceLabels[key]}
                </label>
              ))}
          </div>
          {audienceType === "country" && (
            <div className="space-y-1">
              <Select value={countryCode} onValueChange={setCountryCode}>
                <SelectTrigger className="max-w-xs">
                  <SelectValue placeholder="Выберите страну" />
                </SelectTrigger>
                <SelectContent>
                  {countryOptions.map((m) => (
                    <SelectItem key={m.id} value={m.country_code}>
                      {m.country_name} ({m.country_code})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Фильтр по стране, которую пользователь выбрал в боте при первом входе. RU — Россия, KZ — Казахстан.
              </p>
            </div>
          )}
          <p className="text-sm text-muted-foreground">Получателей: ~{audienceCount ?? "…"}</p>
        </div>

        <div className="space-y-2">
          <Label>Текст (HTML: &lt;b&gt;, &lt;i&gt;)</Label>
          <Textarea
            ref={messageRef}
            value={messageText}
            onChange={(e) => setMessageText(e.target.value)}
            rows={6}
            placeholder="Здравствуйте! К 1 сентября подготовили новые материалы…"
          />
          <EmojiInsertBar onInsert={insertEmoji} />
        </div>

        <div className="space-y-2">
          <Label>Фото (до 10, альбом)</Label>
          <Input type="file" accept="image/*" multiple disabled={uploading || photoPaths.length >= 10} onChange={(e) => onUploadPhotos(e.target.files)} />
          {uploading && <p className="text-sm text-muted-foreground">Загрузка…</p>}
          {photoPaths.length > 0 && (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-3">
                {photoPaths.map((p) => (
                  <div key={p} className="relative group">
                    <img
                      src={broadcastPhotoUrl(p)}
                      alt={p}
                      className="h-20 w-20 object-cover rounded-md border"
                    />
                    <button
                      type="button"
                      onClick={() => removePhoto(p)}
                      className="absolute -top-2 -right-2 h-5 w-5 rounded-full bg-destructive text-destructive-foreground text-xs leading-none opacity-90 hover:opacity-100"
                      title="Удалить"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
              <Button type="button" size="sm" variant="ghost" onClick={() => setPhotoPaths([])}>
                Очистить все
              </Button>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <Label>Кнопки на товары (до 8)</Label>
          <div className="max-h-48 overflow-y-auto border rounded-md p-2 space-y-2">
            {productList.map((p) => {
              const checked = selectedProducts.includes(p.id);
              return (
                <label key={p.id} className="flex items-center gap-2 text-sm cursor-pointer">
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(c) => {
                      setSelectedProducts((prev) => {
                        if (c) return prev.length >= 8 ? prev : [...prev, p.id];
                        return prev.filter((id) => id !== p.id);
                      });
                    }}
                  />
                  {p.name}
                </label>
              );
            })}
          </div>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <Checkbox checked={showCatalog} onCheckedChange={(c) => setShowCatalog(Boolean(c))} />
            Добавить кнопку «Открыть каталог»
          </label>
        </div>

        <div className="flex flex-wrap gap-2 pt-2">
          <Button variant="outline" onClick={onTestSend} disabled={busy || uploading}>
            Отправить себе (тест)
          </Button>
          <Button onClick={onStart} disabled={busy || uploading || audienceType === "test"}>
            🚀 Запустить рассылку
          </Button>
        </div>
      </div>

      {activeBroadcast.data && (
        <div className="bg-card border rounded-lg p-4 space-y-2">
          <h2 className="font-medium">Текущая рассылка</h2>
          <p className="text-sm">
            Статус: <b>{(activeBroadcast.data as any).status}</b> · отправлено {(activeBroadcast.data as any).sent_count} / {(activeBroadcast.data as any).total_count}
            {(activeBroadcast.data as any).failed_count > 0 && ` · ошибки: ${(activeBroadcast.data as any).failed_count}`}
            {(activeBroadcast.data as any).blocked_count > 0 && ` · заблокировали: ${(activeBroadcast.data as any).blocked_count}`}
          </p>
          <p className="text-xs text-muted-foreground">
            Очередь обрабатывается автоматически через cron (каждую минуту).
          </p>
          {((activeBroadcast.data as any).status === "queued" || (activeBroadcast.data as any).status === "sending") && (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={onProcessNow} disabled={busy}>
                Обработать порцию сейчас
              </Button>
              <Button size="sm" variant="destructive" disabled={busy} onClick={async () => {
                if (!confirm("Отменить рассылку? Неотправленные получатели будут пропущены.")) return;
                setBusy(true);
                try {
                  await cancelBroadcastFn({ data: { id: activeId! } });
                  setActiveId(null);
                  await qc.invalidateQueries({ queryKey: ["broadcasts"] });
                } catch (e: any) { alert(e.message); }
                finally { setBusy(false); }
              }}>
                Отменить
              </Button>
            </div>
          )}
        </div>
      )}

      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="font-medium">История</h2>
          <Button size="sm" variant="ghost" onClick={() => qc.invalidateQueries({ queryKey: ["broadcasts"] })}>
            ↻
          </Button>
        </div>
        {(broadcasts.data ?? []).length === 0 && <p className="text-sm text-muted-foreground">Рассылок пока не было.</p>}
        {(broadcasts.data as any[])?.map((b) => {
          const statusLabel: Record<string, string> = {
            queued: "⏳ В очереди",
            sending: "📤 Отправляется",
            completed: "✅ Завершена",
            cancelled: "🚫 Отменена",
            failed: "❌ Не удалась",
          };
          return (
            <div key={b.id} className="bg-card border rounded-lg p-3 text-sm">
              <div className="font-medium truncate">{b.message_text.slice(0, 80)}{b.message_text.length > 80 ? "…" : ""}</div>
              <div className="text-muted-foreground mt-1">
                {new Date(b.created_at).toLocaleString("ru-RU")} · {statusLabel[b.status] ?? b.status}
              </div>
              <div className="text-muted-foreground">
                📨 {b.sent_count}/{b.total_count}
                {b.failed_count > 0 && <span className="text-destructive ml-2">ошибки: {b.failed_count}</span>}
                {b.blocked_count > 0 && <span className="ml-2">заблокировали: {b.blocked_count}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
