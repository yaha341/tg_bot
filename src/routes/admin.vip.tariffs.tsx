import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  getVipTariffs,
  getVipEntryTariff,
  getVipBotUsername,
  saveVipTariff,
  deleteVipTariff,
} from "@/lib/vip-tariffs.functions";
import { Button } from "@/components-ui/button";
import { Input } from "@/components-ui/input";
import { Label } from "@/components-ui/label";
import { Checkbox } from "@/components-ui/checkbox";

export const Route = createFileRoute("/admin/vip/tariffs")({
  component: AdminVipTariffs,
});

function tariffDeepLink(botUsername: string, tariffId: string) {
  const user = botUsername.replace(/^@/, "").trim();
  if (!user) return "";
  return `https://t.me/${user}?start=t_${tariffId}`;
}

function AdminVipTariffs() {
  const qc = useQueryClient();
  const tariffs = useQuery({ queryKey: ["vip_tariffs"], queryFn: () => getVipTariffs() });
  const entryQ = useQuery({ queryKey: ["vip_entry"], queryFn: () => getVipEntryTariff() });
  const bot = useQuery({ queryKey: ["vip_bot_username"], queryFn: () => getVipBotUsername() });

  const [editing, setEditing] = useState<any>(null);
  const [entry, setEntry] = useState<any>(null);
  const [entrySaved, setEntrySaved] = useState(false);

  const botUsername = (bot.data?.username || "").replace(/^@/, "").trim();

  useEffect(() => {
    if (entryQ.data) setEntry({ ...entryQ.data });
  }, [entryQ.data]);

  const renewTariffs = (tariffs.data ?? []).filter((t: any) => !t.is_entry);

  const handleEdit = (t: any) => setEditing({ ...t, is_public: t.is_public !== false, is_entry: false });
  const handleNew = () =>
    setEditing({
      name: "",
      price: 0,
      currency: "KZT",
      duration_days: 30,
      duration_minutes: 2,
      is_active: true,
      is_public: true,
      is_entry: false,
      sort_order: 0,
    });

  const handleSave = async () => {
    if (!editing.name || editing.price < 0) return alert("Проверьте поля");
    await saveVipTariff({ data: { ...editing, is_entry: false } });
    setEditing(null);
    qc.invalidateQueries({ queryKey: ["vip_tariffs"] });
  };

  const handleSaveEntry = async () => {
    if (!entry?.name || entry.price < 0) return alert("Проверьте поля входа");
    if (entry._needsSchema) {
      return alert(
        "Сначала выполните SQL в Supabase (колонка is_entry):\n\nALTER TABLE vip_tariffs ADD COLUMN IF NOT EXISTS is_entry BOOLEAN NOT NULL DEFAULT false;",
      );
    }
    await saveVipTariff({
      data: {
        id: entry.id || undefined,
        name: entry.name,
        price: Number(entry.price),
        currency: entry.currency || "KZT",
        duration_days: Number(entry.duration_days) || 30,
        duration_minutes: Number(entry.duration_minutes) || 5,
        is_active: !!entry.is_active,
        is_public: false,
        is_entry: true,
        sort_order: -100,
      },
    });
    setEntrySaved(true);
    setTimeout(() => setEntrySaved(false), 2000);
    qc.invalidateQueries({ queryKey: ["vip_entry"] });
    qc.invalidateQueries({ queryKey: ["vip_tariffs"] });
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Удалить тариф?")) return;
    try {
      await deleteVipTariff({ data: { id } });
      qc.invalidateQueries({ queryKey: ["vip_tariffs"] });
    } catch (e: any) {
      alert(e.message);
    }
  };

  const copyLink = async (tariffId: string) => {
    if (!botUsername) {
      alert("Задайте VIP_BOT_USERNAME в Vercel env — иначе deep-link не собрать.");
      return;
    }
    const link = tariffDeepLink(botUsername, tariffId);
    try {
      await navigator.clipboard.writeText(link);
      alert("Ссылка скопирована в буфер:\n\n" + link);
    } catch {
      prompt("Скопируйте ссылку:", link);
    }
  };

  if (tariffs.isLoading || entryQ.isLoading) return <div>Загрузка...</div>;

  if (entryQ.isError) {
    return (
      <div className="space-y-4">
        <p className="text-red-600 text-sm">
          Ошибка загрузки тарифа входа: {(entryQ.error as Error)?.message}
        </p>
        <p className="text-sm text-muted-foreground">
          Выполните в Supabase SQL:{" "}
          <code>ALTER TABLE vip_tariffs ADD COLUMN IF NOT EXISTS is_entry BOOLEAN NOT NULL DEFAULT false;</code>
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-semibold">Тарифы VIP-подписки</h2>
        {!editing && <Button onClick={handleNew}>+ Тариф продления</Button>}
      </div>

      {/* First entry block */}
      {entry && (
        <div className="border-2 border-orange-200 rounded-lg bg-orange-50/50 p-4 space-y-4">
          <div>
            <h3 className="font-semibold text-lg">Первый вход</h3>
            <p className="text-sm text-muted-foreground mt-1">
              Это видит <b>новый</b> клиент при первом /start: разовая цена за вход + первый период доступа.
              После оплаты открываются тарифы <b>продления</b> ниже. Старым клиентам (уже были в VIP / импорт /
              скрытая ссылка) вход не показывается.
            </p>
          </div>
          {entry._needsSchema && (
            <p className="text-sm text-red-600">
              Нужен SQL: <code>ALTER TABLE vip_tariffs ADD COLUMN IF NOT EXISTS is_entry BOOLEAN NOT NULL DEFAULT false;</code>
            </p>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>Название</Label>
              <Input value={entry.name || ""} onChange={(e) => setEntry({ ...entry, name: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>Цена за вход (по умолч. 10 000)</Label>
              <Input
                type="number"
                value={entry.price ?? 10000}
                onChange={(e) => setEntry({ ...entry, price: Number(e.target.value) })}
              />
            </div>
            <div className="space-y-1">
              <Label>Валюта</Label>
              <Input value={entry.currency || "KZT"} onChange={(e) => setEntry({ ...entry, currency: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>Срок доступа после входа (дни)</Label>
              <Input
                type="number"
                value={entry.duration_days ?? 30}
                onChange={(e) => setEntry({ ...entry, duration_days: Number(e.target.value) })}
              />
            </div>
            <div className="space-y-1">
              <Label>Срок в тест-режиме (минуты)</Label>
              <Input
                type="number"
                value={entry.duration_minutes ?? 5}
                onChange={(e) => setEntry({ ...entry, duration_minutes: Number(e.target.value) })}
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              checked={!!entry.is_active}
              onCheckedChange={(c) => setEntry({ ...entry, is_active: !!c })}
              id="entry-active"
            />
            <Label htmlFor="entry-active">Активен (показывать новым клиентам)</Label>
          </div>
          <div className="flex items-center gap-3">
            <Button onClick={handleSaveEntry}>Сохранить вход</Button>
            {entrySaved && <span className="text-sm text-green-600">Сохранено ✓</span>}
          </div>
        </div>
      )}

      <div className="text-sm border rounded-lg p-3 bg-muted/40 space-y-1">
        <p>
          <b>Тарифы продления</b> — для тех, кто уже был в VIP (после первого входа, импорт, истекшие).
        </p>
        <p>
          <b>Скрытый</b> — только по ссылке; бот запоминает и сам предлагает при продлении (дешёвая аудитория).
        </p>
      </div>

      {editing && (
        <div className="bg-card border rounded-lg p-4 space-y-4">
          <h3 className="font-medium">{editing.id ? "Редактирование тарифа продления" : "Новый тариф продления"}</h3>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>Название (например, "1 Месяц")</Label>
              <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>Цена</Label>
              <Input type="number" value={editing.price} onChange={(e) => setEditing({ ...editing, price: Number(e.target.value) })} />
            </div>
            <div className="space-y-1">
              <Label>Валюта (KZT, RUB...)</Label>
              <Input value={editing.currency} onChange={(e) => setEditing({ ...editing, currency: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>Срок (в днях)</Label>
              <Input type="number" value={editing.duration_days} onChange={(e) => setEditing({ ...editing, duration_days: Number(e.target.value) })} />
            </div>
            <div className="space-y-1">
              <Label>Срок для тест-режима (в минутах)</Label>
              <Input type="number" value={editing.duration_minutes} onChange={(e) => setEditing({ ...editing, duration_minutes: Number(e.target.value) })} />
            </div>
            <div className="space-y-1">
              <Label>Порядок сортировки</Label>
              <Input type="number" value={editing.sort_order} onChange={(e) => setEditing({ ...editing, sort_order: Number(e.target.value) })} />
            </div>
          </div>
          <div className="flex items-center gap-2 mt-2">
            <Checkbox checked={editing.is_active} onCheckedChange={(c) => setEditing({ ...editing, is_active: !!c })} />
            <Label>Активен (можно оформлять)</Label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox checked={editing.is_public !== false} onCheckedChange={(c) => setEditing({ ...editing, is_public: !!c })} />
            <Label>Публичный при продлении. Сними = скрытый (только по ссылке)</Label>
          </div>
          {editing.id && (
            <div className="space-y-1 rounded-md border bg-muted/30 p-3">
              <Label>Ссылка на этот тариф</Label>
              <code className="block text-xs break-all select-all">{tariffDeepLink(botUsername, editing.id)}</code>
              <Button type="button" size="sm" variant="outline" onClick={() => copyLink(editing.id)}>
                Скопировать ссылку
              </Button>
            </div>
          )}
          <div className="flex gap-2">
            <Button onClick={handleSave}>Сохранить</Button>
            <Button variant="outline" onClick={() => setEditing(null)}>Отмена</Button>
          </div>
        </div>
      )}

      {!editing && (
        <div className="space-y-3">
          <h3 className="font-medium">Тарифы продления</h3>
          {renewTariffs.map((t: any) => {
            const link = tariffDeepLink(botUsername, t.id);
            const hidden = t.is_active && t.is_public === false;
            return (
              <div key={t.id} className="border rounded-lg bg-card p-4 space-y-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="font-medium">{t.name}</div>
                    <div className="text-sm text-muted-foreground">
                      {t.price} {t.currency} · {t.duration_days} дн. (тест: {t.duration_minutes} мин.)
                    </div>
                    <div className="text-sm mt-1">
                      {!t.is_active ? (
                        <span className="text-muted-foreground">Выключен</span>
                      ) : hidden ? (
                        <span className="text-orange-600 font-medium">Скрытый — только по ссылке</span>
                      ) : (
                        <span className="text-green-600">Публичный — при продлении</span>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" onClick={() => handleEdit(t)}>Изменить</Button>
                    <Button variant="destructive" size="sm" onClick={() => handleDelete(t.id)}>Удалить</Button>
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground">Ссылка для этого тарифа:</div>
                  <code className="block text-xs break-all select-all rounded bg-muted px-2 py-1">{link}</code>
                  <Button type="button" size="sm" variant="secondary" onClick={() => copyLink(t.id)}>
                    Скопировать ссылку
                  </Button>
                </div>
              </div>
            );
          })}
          {renewTariffs.length === 0 && (
            <p className="text-center text-muted-foreground py-6">Нет тарифов продления. Создайте хотя бы один.</p>
          )}
        </div>
      )}
    </div>
  );
}
