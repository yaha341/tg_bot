import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components-ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components-ui/dialog";
import { confirmOrder, continueDeliveryOrder, deleteOrder, listOrders, redeliverOrder, rejectOrder } from "@/lib/orders.functions";
import { useState } from "react";

// Тип чека определяется по расширению сохранённого пути.
// Фото показываем через <img>, PDF — через <iframe>, прочее — ссылкой на скачивание.
const IMAGE_EXTS = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "heic"];

function proofKind(path: string): "image" | "pdf" | "other" {
  const ext = (path.split(".").pop() || "").toLowerCase();
  if (ext === "pdf") return "pdf";
  if (IMAGE_EXTS.includes(ext)) return "image";
  return "other";
}

export const Route = createFileRoute("/admin/orders")({
  component: OrdersPage,
});

const statusMap: Record<string, { label: string; cls: string }> = {
  awaiting_payment: { label: "Ждёт оплаты", cls: "bg-muted text-muted-foreground" },
  awaiting_confirmation: { label: "Ждёт подтверждения", cls: "bg-amber-100 text-amber-900" },
  delivering: { label: "Выдаётся", cls: "bg-blue-100 text-blue-900" },
  delivered: { label: "Выдан", cls: "bg-green-100 text-green-900" },
  rejected: { label: "Отклонён", cls: "bg-red-100 text-red-900" },
};

function OrdersPage() {
  const qc = useQueryClient();
  const orders = useQuery({ queryKey: ["orders"], queryFn: () => listOrders() });
  const list = (orders.data ?? []) as any[];
  const [busy, setBusy] = useState<number | null>(null);

  async function onConfirm(id: number) {
    if (!confirm(`Подтвердить оплату заказа #${id} и выдать файлы?`)) return;
    setBusy(id);
    try {
      const result = await confirmOrder({ data: { id } });
      qc.invalidateQueries({ queryKey: ["orders"] });
      if (result.alreadyDelivered) {
        alert(`Заказ #${id} уже выдаётся или выдан.`);
      }
    } catch (e: any) {
      alert(e.message);
    } finally {
      setBusy(null);
    }
  }
  async function onRedeliver(id: number) {
    if (!confirm(`Отправить файлы заказа #${id} покупателю ещё раз?`)) return;
    setBusy(id);
    try {
      await redeliverOrder({ data: { id } });
      qc.invalidateQueries({ queryKey: ["orders"] });
    } catch (e: any) {
      alert(e.message);
    } finally {
      setBusy(null);
    }
  }
  async function onContinue(id: number) {
    if (!confirm(`Продолжить выдачу файлов заказа #${id}? (следующая порция)`)) return;
    setBusy(id);
    try {
      const res = await continueDeliveryOrder({ data: { id } });
      qc.invalidateQueries({ queryKey: ["orders"] });
      if ((res as any).pending) {
        alert(
          `Отправлена порция файлов (${(res as any).sent}). Ещё осталось — нажмите «Продолжить» снова или дождитесь cron.`,
        );
      } else {
        alert(`Заказ #${id} выдан полностью.`);
      }
    } catch (e: any) {
      alert(e.message);
    } finally {
      setBusy(null);
    }
  }
  async function onReject(id: number) {
    const note = prompt("Причина отказа (необязательно):") || undefined;
    setBusy(id);
    try {
      await rejectOrder({ data: { id, note } });
      qc.invalidateQueries({ queryKey: ["orders"] });
    } finally {
      setBusy(null);
    }
  }
  async function onDelete(id: number) {
    if (!confirm(`Удалить заказ #${id}? Это действие необратимо.`)) return;
    if (!confirm(`Точно удалить заказ #${id}? Нумерация следующих заказов сбросится до текущего максимума.`)) return;
    setBusy(id);
    try {
      await deleteOrder({ data: { id } });
      qc.invalidateQueries({ queryKey: ["orders"] });
    } catch (e: any) {
      alert(e.message);
    } finally {
      setBusy(null);
    }
  }

  const [proofModal, setProofModal] = useState<{ path: string } | null>(null);

  function onViewScreenshot(path: string) {
    setProofModal({ path });
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Заказы</h1>
      {list.length === 0 && <p className="text-sm text-muted-foreground">Пока нет заказов.</p>}
      <div className="space-y-3">
        {list.map((o) => {
          const st = statusMap[o.status] || { label: o.status, cls: "bg-muted" };
          return (
            <div key={o.id} className="bg-card border rounded-lg p-4 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-semibold">#{o.id}</span>
                  <span className={`text-xs px-2 py-0.5 rounded ${st.cls}`}>{st.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(o.created_at).toLocaleString("ru")}
                  </span>
                </div>
                <div className="font-semibold">
                  {o.total} {o.currency}
                </div>
              </div>
              <div className="text-sm">
                <div>
                  👤 <b>{o.display_name}</b>
                  {o.username && <> (<a className="text-primary" href={`https://t.me/${o.username}`} target="_blank" rel="noreferrer">@{o.username}</a>)</>}
                </div>
                <div>📞 {o.contact || "—"}</div>
                <div>🌍 {o.country_name || "—"}</div>
              </div>
              <ul className="text-sm list-disc pl-5">
                {(o.order_items ?? []).map((it: any) => (
                  <li key={it.id}>
                    {it.name_snapshot} × {it.quantity} — {it.price_snapshot} {o.currency}
                  </li>
                ))}
              </ul>
              {o.payment_proof_path && (
                <button
                  className="inline-block text-sm text-primary underline text-left"
                  onClick={() => onViewScreenshot(o.payment_proof_path)}
                >
                  📷 Скриншот оплаты
                </button>
              )}
              {o.status === "delivering" && (
                <div className="space-y-2 pt-2">
                  <p className="text-sm text-blue-700">
                    ⏳ Заказ выдаётся порциями (файлы). Если зависло — нажмите «Продолжить выдачу».
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={() => onContinue(o.id)} disabled={busy === o.id}>
                      ▶️ Продолжить выдачу
                    </Button>
                    <Button variant="outline" onClick={() => onRedeliver(o.id)} disabled={busy === o.id}>
                      Выдать заново с начала
                    </Button>
                  </div>
                </div>
              )}
              {(o.status === "awaiting_confirmation" || o.status === "awaiting_payment") && (
                <div className="flex gap-2 pt-2">
                  <Button onClick={() => onConfirm(o.id)} disabled={busy === o.id}>
                    ✅ Подтвердить и выдать
                  </Button>
                  <Button variant="destructive" onClick={() => onReject(o.id)} disabled={busy === o.id}>
                    ❌ Отклонить
                  </Button>
                </div>
              )}
              {o.status === "delivered" && (
                <Button size="sm" variant="outline" onClick={() => onRedeliver(o.id)} disabled={busy === o.id}>
                  Отправить файлы ещё раз
                </Button>
              )}
              <div className="flex justify-end pt-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => onDelete(o.id)}
                  disabled={busy === o.id}
                >
                  🗑️ Удалить
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Модалка просмотра чека оплаты */}
      <Dialog open={!!proofModal} onOpenChange={(open) => !open && setProofModal(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Чек оплаты</DialogTitle>
          </DialogHeader>
          {proofModal && (() => {
            const kind = proofKind(proofModal.path);
            const src = `/api/admin/file/${proofModal.path}?bucket=payment-proofs`;
            if (kind === "image") {
              return <img src={src} alt="Чек оплаты" className="max-h-[80vh] mx-auto rounded" />;
            }
            if (kind === "pdf") {
              return (
                <iframe
                  src={src}
                  className="w-full h-[80vh] rounded border"
                  title="Чек оплаты"
                />
              );
            }
            return (
              <div className="text-center py-6 space-y-3">
                <p className="text-muted-foreground">Формат не поддерживается для предпросмотра.</p>
                <Button asChild>
                  <a href={src} target="_blank" rel="noreferrer">
                    📥 Скачать чек
                  </a>
                </Button>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>
    </div>
  );
}