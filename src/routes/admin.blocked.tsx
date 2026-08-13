import { createFileRoute, redirect } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { getCapabilitiesFn } from "@/lib/capabilities.functions";
import { blockTelegramUserFn, listBlockedUsersFn, unblockTelegramUserFn } from "@/lib/blocked-users.functions";
import { searchTelegramUsersFn, type TelegramUserHit } from "@/lib/users-search.functions";
import { Button } from "@/components-ui/button";
import { Input } from "@/components-ui/input";
import { Label } from "@/components-ui/label";
import { Textarea } from "@/components-ui/textarea";

export const Route = createFileRoute("/admin/blocked")({
  beforeLoad: async () => {
    const modules = await getCapabilitiesFn();
    if (!modules.blocked_users) throw redirect({ to: "/admin" });
  },
  component: BlockedUsersPage,
});

function BlockedUsersPage() {
  const qc = useQueryClient();
  const blocked = useQuery({ queryKey: ["blocked_users"], queryFn: () => listBlockedUsersFn() });
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<TelegramUserHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [telegramId, setTelegramId] = useState("");
  const [selectedUser, setSelectedUser] = useState<TelegramUserHit | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const q = search.trim();
    if (q.length < 1) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await searchTelegramUsersFn({ data: { query: q } });
        if (!cancelled) setHits(res as TelegramUserHit[]);
      } catch {
        if (!cancelled) setHits([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [search]);

  function pickUser(u: TelegramUserHit) {
    setSelectedUser(u);
    setTelegramId(String(u.telegram_id));
    setSearch("");
    setHits([]);
  }

  async function onBlock() {
    const id = telegramId.trim();
    if (!id) return alert("Укажите Telegram ID или найдите пользователя");
    if (
      !confirm(
        `Заблокировать пользователя ${id}?\n\nБот перестанет отвечать, доступ к VIP-группе будет закрыт, активные подписки и незавершённые заказы отменятся.`,
      )
    )
      return;
    setBusy(true);
    try {
      await blockTelegramUserFn({
        data: {
          telegram_id: id,
          reason: reason.trim() || undefined,
          username: selectedUser?.username ?? undefined,
          first_name: selectedUser?.first_name ?? undefined,
        },
      });
      setTelegramId("");
      setSelectedUser(null);
      setReason("");
      setSearch("");
      await qc.invalidateQueries({ queryKey: ["blocked_users"] });
    } catch (e: any) {
      alert(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function onUnblock(id: number) {
    if (!confirm(`Разблокировать пользователя ${id}?`)) return;
    setBusy(true);
    try {
      await unblockTelegramUserFn({ data: { telegram_id: id } });
      await qc.invalidateQueries({ queryKey: ["blocked_users"] });
    } catch (e: any) {
      alert(e.message);
    } finally {
      setBusy(false);
    }
  }

  const list = (blocked.data ?? []) as any[];

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold">Чёрный список</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Заблокированные пользователи не могут пользоваться магазином и VIP-ботом. Доступ к группе закрывается автоматически.
        </p>
      </div>

      <div className="bg-card border rounded-lg p-4 space-y-4">
        <h2 className="font-medium">Найти и заблокировать</h2>
        <div className="space-y-2">
          <Label>Поиск по базе (ID, @username, имя)</Label>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Например: Иван или 1580128256"
          />
          <p className="text-xs text-muted-foreground">
            Ищет среди пользователей магазина и VIP-подписчиков.
            {searching ? " Поиск…" : ""}
          </p>
          {hits.length > 0 && (
            <ul className="border rounded-md divide-y max-h-48 overflow-y-auto">
              {hits.map((u) => (
                <li key={u.telegram_id}>
                  <button
                    type="button"
                    className="w-full text-left px-3 py-2 text-sm hover:bg-accent"
                    onClick={() => pickUser(u)}
                  >
                    <span className="font-medium">
                      {[u.first_name, u.last_name].filter(Boolean).join(" ") || "—"}
                    </span>
                    {u.username ? ` @${u.username}` : ""}
                    <span className="text-muted-foreground"> · ID {u.telegram_id}</span>
                    <span className="text-xs text-muted-foreground ml-1">
                      ({u.sources.join(", ")})
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="space-y-2">
          <Label>Telegram ID</Label>
          <Input
            value={telegramId}
            onChange={(e) => {
              setTelegramId(e.target.value);
              setSelectedUser(null);
            }}
            placeholder="1580128256"
          />
          {selectedUser && (
            <p className="text-xs text-muted-foreground">
              Выбран: {[selectedUser.first_name, selectedUser.last_name].filter(Boolean).join(" ") || "—"}
              {selectedUser.username ? ` @${selectedUser.username}` : ""}
            </p>
          )}
        </div>
        <div className="space-y-2">
          <Label>Причина (необязательно)</Label>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder="Перепродажа материалов, пиратство…"
          />
        </div>
        <Button onClick={onBlock} disabled={busy}>
          Заблокировать
        </Button>
      </div>

      <div className="space-y-3">
        <h2 className="font-medium">Заблокированные ({list.length})</h2>
        {list.length === 0 && (
          <p className="text-sm text-muted-foreground">Список пуст.</p>
        )}
        {list.map((u) => (
          <div key={u.telegram_id} className="bg-card border rounded-lg p-3 text-sm flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="font-medium">
                {u.first_name || "—"}{" "}
                {u.username ? `@${u.username}` : `ID: ${u.telegram_id}`}
              </div>
              <div className="text-muted-foreground">ID: {u.telegram_id}</div>
              {u.reason && <div className="mt-1">Причина: {u.reason}</div>}
              <div className="text-xs text-muted-foreground mt-1">
                {new Date(u.blocked_at).toLocaleString("ru-RU")}
              </div>
            </div>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => onUnblock(u.telegram_id)}>
              Разблокировать
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
