import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { confirmOrder, listOrders, rejectOrder } from "@/lib/orders.functions";
import { useState } from "react";

export const Route = createFileRoute("/admin/orders")({
  component: OrdersPage,
});

const statusMap: Record<string, { label: string; cls: string }> = {
  awaiting_payment: { label: "Ждёт оплаты", cls: "bg-muted text-muted-foreground" },
  awaiting_confirmation: { label: "Ждёт подтверждения", cls: "bg-amber-100 text-amber-900" },
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
      await confirmOrder({ data: { id } });
      qc.invalidateQueries({ queryKey: ["orders"] });
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
                <a
                  className="inline-block text-sm text-primary underline"
                  href={`/api/admin/file/${o.payment_proof_path}?bucket=payment-proofs`}
                  target="_blank"
                  rel="noreferrer"
                >
                  📷 Скриншот оплаты
                </a>
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
                <Button size="sm" variant="outline" onClick={() => onConfirm(o.id)}>
                  Отправить файлы ещё раз
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}