import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  getVipSubscriptions,
  getVipMemberProfiles,
  addVipSubscriptionManual,
  extendVipSubscription,
  deleteVipSubscription,
  confirmVipSubscription,
  rejectVipSubscription,
  excludeVipFromCommunity,
} from "@/lib/vip-subscriptions.functions";
import { blockTelegramUserFn } from "@/lib/blocked-users.functions";
import { searchTelegramUsersFn, type TelegramUserHit } from "@/lib/users-search.functions";
import { lookupVipGroupMemberFn } from "@/lib/vip-group-members.functions";
import { getVipTariffs } from "@/lib/vip-tariffs.functions";
import { paymentProofKind } from "@/lib/file-mime";
import { formatDateTimeRu } from "@/lib/datetime";
import { Button } from "@/components-ui/button";
import { Input } from "@/components-ui/input";
import { Label } from "@/components-ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components-ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components-ui/dialog";

export const Route = createFileRoute("/admin/vip/subscribers")({
  component: AdminVipSubscribers,
});

function matchesSearch(s: any, q: string): boolean {
  const needle = q.trim().toLowerCase().replace(/^@/, "");
  if (!needle) return true;
  const id = String(s.telegram_id ?? "");
  const username = String(s.username ?? "").toLowerCase();
  const first = String(s.first_name ?? "").toLowerCase();
  const last = String(s.last_name ?? "").toLowerCase();
  const full = `${first} ${last}`.trim();
  return (
    id.includes(needle) ||
    username.includes(needle) ||
    first.includes(needle) ||
    last.includes(needle) ||
    full.includes(needle)
  );
}

function AdminVipSubscribers() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("pending_payment");
  const [tableSearch, setTableSearch] = useState("");

  const effectiveStatus = tableSearch.trim() ? "all" : statusFilter;

  const subs = useQuery({
    queryKey: ["vip_subs", effectiveStatus],
    queryFn: () => getVipSubscriptions({ data: { status: effectiveStatus } }),
  });
  const profiles = useQuery({ queryKey: ["vip_profiles"], queryFn: () => getVipMemberProfiles() });
  const tariffs = useQuery({ queryKey: ["vip_tariffs"], queryFn: () => getVipTariffs() });

  const profileByTelegram = new Map(
    (profiles.data ?? []).map((p: any) => [String(p.telegram_id), p]),
  );

  const filteredSubs = useMemo(() => {
    const list = (subs.data ?? []) as any[];
    const byStatus =
      tableSearch.trim() || statusFilter === "all"
        ? list
        : list.filter((s) => s.status === statusFilter);
    return byStatus.filter((s) => matchesSearch(s, tableSearch));
  }, [subs.data, statusFilter, tableSearch]);

  const [addingManual, setAddingManual] = useState(false);
  const [manualData, setManualData] = useState({ telegram_id: "", tariff_id: "", days: 30, status: "active" });
  const [manualSearch, setManualSearch] = useState("");
  const [manualHits, setManualHits] = useState<TelegramUserHit[]>([]);
  const [manualLookupLoading, setManualLookupLoading] = useState(false);
  const [manualLookupHint, setManualLookupHint] = useState<string | null>(null);
  const [proofModal, setProofModal] = useState<{ path: string } | null>(null);

  useEffect(() => {
    const q = manualSearch.trim();
    if (q.length < 1) {
      setManualHits([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = await searchTelegramUsersFn({ data: { query: q } });
        if (!cancelled) setManualHits(res as TelegramUserHit[]);
      } catch {
        if (!cancelled) setManualHits([]);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [manualSearch]);

  const handleLookupManualId = async () => {
    const id = manualData.telegram_id.trim();
    if (!/^\d{5,15}$/.test(id)) {
      return alert("Введите корректный Telegram ID (только цифры)");
    }
    setManualLookupLoading(true);
    setManualLookupHint(null);
    try {
      const row = await lookupVipGroupMemberFn({ data: { telegram_id: id } });
      const name = [row.first_name, row.last_name].filter(Boolean).join(" ") || "—";
      setManualLookupHint(
        `Найден в группе: ${name}${row.username ? ` @${row.username}` : ""} · статус: ${row.member_status}`,
      );
    } catch (e: any) {
      alert("Ошибка: " + e.message);
    } finally {
      setManualLookupLoading(false);
    }
  };

  const handleAddManual = async () => {
    if (!manualData.telegram_id || !manualData.tariff_id) return alert("Заполните ID и выберите тариф");
    const days = Number.isFinite(manualData.days) && manualData.days >= 1 ? manualData.days : 30;
    try {
      const res = await addVipSubscriptionManual({
        data: { ...manualData, days },
      });
      setAddingManual(false);
      setManualSearch("");
      setManualHits([]);
      setManualLookupHint(null);
      setManualData({ telegram_id: "", tariff_id: "", days: 30, status: "active" });
      setStatusFilter("active");
      qc.invalidateQueries({ queryKey: ["vip_subs"] });
      const msg =
        "Подписчик добавлен. Смотрите вкладку «Активные»." +
        (res.warning ? `\n\n⚠ ${res.warning}` : "") +
        (res.inviteSent ? "\n\nПользователю отправлена ссылка для вступления." : "");
      alert(msg);
    } catch (e: any) {
      alert("Ошибка: " + e.message);
    }
  };

  const handleConfirm = async (id: string) => {
    if (!confirm("Подтвердить оплату и выдать доступ?")) return;
    try {
      await confirmVipSubscription({ data: { id } });
      qc.invalidateQueries({ queryKey: ["vip_subs"] });
    } catch (e: any) {
      alert("Ошибка: " + e.message);
    }
  };

  const handleReject = async (id: string) => {
    if (!confirm("Отклонить оплату? Пользователь получит уведомление в VIP-боте.")) return;
    try {
      await rejectVipSubscription({ data: { id } });
      qc.invalidateQueries({ queryKey: ["vip_subs"] });
    } catch (e: any) {
      alert("Ошибка: " + e.message);
    }
  };

  const handleExtend = async (id: string) => {
    const days = prompt(
      "Изменить срок (дни):\n+ число — продлить (например 2)\n− число — уменьшить (например -3)",
      "30",
    );
    if (days === null || days.trim() === "") return;
    const n = parseInt(days.trim(), 10);
    if (!Number.isFinite(n) || n === 0) {
      return alert("Укажите целое число дней, не ноль (например 5 или -2)");
    }
    if (n < 0) {
      const ok = confirm(
        `Уменьшить срок на ${Math.abs(n)} дн.?\nЕсли дата окажется в прошлом — подписка станет «Истёк» и доступ к группе закроется.`,
      );
      if (!ok) return;
    }
    try {
      await extendVipSubscription({ data: { id, days: n } });
      qc.invalidateQueries({ queryKey: ["vip_subs"] });
    } catch (e: any) {
      alert("Ошибка: " + e.message);
    }
  };

  const handleExclude = async (id: string) => {
    if (
      !confirm(
        "Исключить из VIP-сообщества?\n\nЧеловека кикнут из группы, активные подписки станут «Истёкшие», он получит сообщение в боте.",
      )
    )
      return;
    try {
      await excludeVipFromCommunity({ data: { id } });
      qc.invalidateQueries({ queryKey: ["vip_subs"] });
    } catch (e: any) {
      alert("Ошибка: " + e.message);
    }
  };

  const handleBlock = async (sub: {
    telegram_id: number;
    username?: string | null;
    first_name?: string | null;
  }) => {
    if (
      !confirm(
        `Заблокировать пользователя ${sub.telegram_id} навсегда?\n\nБот перестанет отвечать, доступ к VIP-группе закроется, подписки и незавершённые заказы отменятся.`,
      )
    )
      return;
    try {
      await blockTelegramUserFn({
        data: {
          telegram_id: sub.telegram_id,
          username: sub.username ?? undefined,
          first_name: sub.first_name ?? undefined,
          reason: "заблокирован из VIP-подписчиков",
        },
      });
      qc.invalidateQueries({ queryKey: ["vip_subs"] });
    } catch (e: any) {
      alert("Ошибка: " + e.message);
    }
  };

  const handleDelete = async (id: string) => {
    if (
      !confirm(
        "Удалить подписку?\n\nЕсли у человека больше не останется записей — бот забудет его (личный тариф и «уже был в VIP»), и снова покажет «Первый вход».\n\nДля кика из группы лучше «Исключить». Для полного запрета — «Заблокировать».",
      )
    )
      return;
    await deleteVipSubscription({ data: { id } });
    qc.invalidateQueries({ queryKey: ["vip_subs"] });
    qc.invalidateQueries({ queryKey: ["vip_profiles"] });
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center gap-2 flex-wrap">
        <h2 className="text-xl font-semibold">Подписчики VIP</h2>
        <Button onClick={() => setAddingManual(!addingManual)}>
          {addingManual ? "Отмена" : "+ Добавить вручную (Импорт)"}
        </Button>
      </div>

      {addingManual && (
        <div className="bg-card border rounded-lg p-4 space-y-4 max-w-xl">
          <h3 className="font-medium">Добавление участника вручную</h3>
          <p className="text-xs text-muted-foreground">
            После добавления запись появится во вкладке «Активные». Бот отправит ссылку, если пользователь
            ещё не в группе (нужно чтобы человек хотя бы раз писал VIP-боту).
          </p>
          <div className="space-y-2">
            <Label>Найти в базе (ID, @username, имя)</Label>
            <Input
              value={manualSearch}
              onChange={(e) => setManualSearch(e.target.value)}
              placeholder="Иван или @username"
            />
            {manualHits.length > 0 && (
              <ul className="border rounded-md divide-y max-h-40 overflow-y-auto">
                {manualHits.map((u) => (
                  <li key={u.telegram_id}>
                    <button
                      type="button"
                      className="w-full text-left px-3 py-2 text-sm hover:bg-accent"
                      onClick={() => {
                        setManualData((d) => ({ ...d, telegram_id: String(u.telegram_id) }));
                        setManualSearch("");
                        setManualHits([]);
                      }}
                    >
                      {[u.first_name, u.last_name].filter(Boolean).join(" ") || "—"}
                      {u.username ? ` @${u.username}` : ""}
                      <span className="text-muted-foreground"> · {u.telegram_id}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="space-y-2">
            <Label>Telegram ID участника</Label>
            <div className="flex gap-2">
              <Input
                className="flex-1"
                value={manualData.telegram_id}
                onChange={(e) => {
                  setManualData({ ...manualData, telegram_id: e.target.value });
                  setManualLookupHint(null);
                }}
                placeholder="Например: 123456789"
              />
              <Button
                type="button"
                variant="outline"
                disabled={manualLookupLoading}
                onClick={handleLookupManualId}
              >
                {manualLookupLoading ? "…" : "Проверить в Telegram"}
              </Button>
            </div>
            {manualLookupHint && (
              <p className="text-xs text-green-700 bg-green-50 border border-green-200 rounded px-2 py-1">
                {manualLookupHint}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label>Тариф</Label>
            <Select
              value={manualData.tariff_id}
              onValueChange={(v) => setManualData({ ...manualData, tariff_id: v })}
            >
              <SelectTrigger>
                <SelectValue placeholder="Выберите тариф" />
              </SelectTrigger>
              <SelectContent>
                {tariffs.data?.map((t: any) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Дней до истечения (остаток)</Label>
            <Input
              type="number"
              min={1}
              value={manualData.days}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                setManualData({ ...manualData, days: Number.isFinite(n) ? n : 30 });
              }}
            />
          </div>
          <Button onClick={handleAddManual}>Сохранить</Button>
        </div>
      )}

      <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
        <Input
          className="max-w-sm"
          value={tableSearch}
          onChange={(e) => setTableSearch(e.target.value)}
          placeholder="Поиск: ID, @username, имя…"
        />
        {tableSearch.trim() && (
          <p className="text-xs text-muted-foreground">Поиск по всей базе подписок (все статусы)</p>
        )}
      </div>

      <div className="flex gap-2 flex-wrap">
        <Button
          variant={statusFilter === "all" ? "default" : "outline"}
          size="sm"
          onClick={() => setStatusFilter("all")}
          disabled={!!tableSearch.trim()}
        >
          Все
        </Button>
        <Button
          variant={statusFilter === "active" ? "default" : "outline"}
          size="sm"
          onClick={() => setStatusFilter("active")}
          disabled={!!tableSearch.trim()}
        >
          Активные
        </Button>
        <Button
          variant={statusFilter === "pending_payment" ? "default" : "outline"}
          size="sm"
          onClick={() => setStatusFilter("pending_payment")}
          disabled={!!tableSearch.trim()}
        >
          Ожидают проверки
        </Button>
        <Button
          variant={statusFilter === "expired" ? "default" : "outline"}
          size="sm"
          onClick={() => setStatusFilter("expired")}
          disabled={!!tableSearch.trim()}
        >
          Истёкшие
        </Button>
        <Button
          variant={statusFilter === "cancelled" ? "default" : "outline"}
          size="sm"
          onClick={() => setStatusFilter("cancelled")}
          disabled={!!tableSearch.trim()}
        >
          Отклонённые
        </Button>
      </div>

      <div className="border rounded-md overflow-hidden bg-card">
        <table className="w-full text-sm text-left">
          <thead className="bg-muted">
            <tr>
              <th className="p-2 font-medium">Пользователь</th>
              <th className="p-2 font-medium">Тариф</th>
              <th className="p-2 font-medium">Статус</th>
              <th className="p-2 font-medium">Истекает</th>
              <th className="p-2 font-medium text-right">Действия</th>
            </tr>
          </thead>
          <tbody>
            {filteredSubs.map((s: any) => {
              const profile = profileByTelegram.get(String(s.telegram_id));
              const personalTariff = profile?.vip_tariffs;
              return (
                <tr key={s.id} className="border-t">
                  <td className="p-2">
                    <div>
                      {s.first_name} {s.last_name}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {s.username ? `@${s.username}` : `ID: ${s.telegram_id}`}
                    </div>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {s.imported && (
                        <span className="text-[10px] bg-secondary px-1 rounded">импорт</span>
                      )}
                      {personalTariff && (
                        <span className="text-[10px] bg-orange-100 text-orange-800 px-1 rounded border border-orange-200">
                          личный тариф: {personalTariff.price} {personalTariff.currency}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="p-2">{s.vip_tariffs?.name || "Удалён"}</td>
                  <td className="p-2">
                    {(() => {
                      const pastDue =
                        s.status === "active" && new Date(s.expires_at).getTime() <= Date.now();
                      if (s.status === "active" && !pastDue)
                        return <span className="text-green-600 font-medium">Активен</span>;
                      if (pastDue)
                        return (
                          <span className="text-amber-600 font-medium">Истёк (ожидает кик)</span>
                        );
                      if (s.status === "pending_payment")
                        return <span className="text-orange-600 font-medium">Ожидает</span>;
                      if (s.status === "expired")
                        return <span className="text-red-600 font-medium">Истёк</span>;
                      if (s.status === "cancelled")
                        return <span className="text-muted-foreground">Отклонён</span>;
                      return <span className="text-muted-foreground">{s.status}</span>;
                    })()}
                  </td>
                  <td className="p-2">
                    {s.status === "pending_payment"
                      ? "-"
                      : formatDateTimeRu(s.expires_at)}
                  </td>
                  <td className="p-2">
                    <div className="flex flex-wrap items-center justify-end gap-1.5">
                      {(s.status === "pending_payment" || s.payment_proof_path) &&
                        (s.payment_proof_path ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setProofModal({ path: s.payment_proof_path })}
                          >
                            Чек
                          </Button>
                        ) : (
                          <Button variant="outline" size="sm" disabled>
                            Чек
                          </Button>
                        ))}
                      {s.status === "pending_payment" && (
                        <>
                          <Button variant="default" size="sm" onClick={() => handleConfirm(s.id)}>
                            Подтвердить
                          </Button>
                          <Button variant="outline" size="sm" onClick={() => handleReject(s.id)}>
                            Отклонить
                          </Button>
                        </>
                      )}
                      {s.status !== "pending_payment" && (
                        <Button variant="outline" size="sm" onClick={() => handleExtend(s.id)}>
                          Срок ±
                        </Button>
                      )}
                      {s.status === "active" && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-destructive border-destructive/40 hover:bg-destructive/10"
                          onClick={() => handleExclude(s.id)}
                        >
                          Исключить
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-destructive border-destructive/40 hover:bg-destructive/10"
                        onClick={() => handleBlock(s)}
                      >
                        Заблокировать
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-destructive border-destructive/40 hover:bg-destructive/10"
                        onClick={() => handleDelete(s.id)}
                      >
                        Удалить
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {filteredSubs.length === 0 && (
              <tr>
                <td colSpan={5} className="p-4 text-center text-muted-foreground">
                  Ничего не найдено.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Dialog open={!!proofModal} onOpenChange={(open) => !open && setProofModal(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Чек оплаты VIP</DialogTitle>
          </DialogHeader>
          {proofModal &&
            (() => {
              const kind = paymentProofKind(proofModal.path);
              const src = `/api/admin/file/${proofModal.path}?bucket=payment-proofs`;
              if (kind === "image") {
                return <img src={src} alt="Чек оплаты" className="max-h-[80vh] mx-auto rounded" />;
              }
              if (kind === "pdf") {
                return (
                  <iframe src={src} className="w-full h-[80vh] rounded border" title="Чек оплаты" />
                );
              }
              return (
                <div className="text-center py-6 space-y-3">
                  <p className="text-muted-foreground">Формат не поддерживается для предпросмотра.</p>
                  <Button asChild>
                    <a href={src} target="_blank" rel="noreferrer">
                      Скачать чек
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
