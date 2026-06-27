import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getSettings, saveSetting } from "@/lib/settings.functions";
import { resetAllData } from "@/lib/reset.functions";

export const Route = createFileRoute("/admin/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => getSettings() });
  const [adminChatId, setAdminChatId] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setAdminChatId(settings.data?.admin_chat_id ?? "");
  }, [settings.data]);

  async function onSave() {
    await saveSetting({ data: { key: "admin_chat_id", value: adminChatId.trim() } });
    qc.invalidateQueries({ queryKey: ["settings"] });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  const [resetting, setResetting] = useState(false);
  const [resetDone, setResetDone] = useState(false);
  async function onReset() {
    const ok = window.confirm(
      "Сбросить ВСЕ данные? Будут удалены все товары, категории, заказы и загруженные файлы. Действие необратимо.",
    );
    if (!ok) return;
    const ok2 = window.confirm("Точно? Это нельзя отменить.");
    if (!ok2) return;
    setResetting(true);
    try {
      await resetAllData();
      await qc.invalidateQueries();
      setResetDone(true);
      setTimeout(() => setResetDone(false), 3000);
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="space-y-6 max-w-xl">
      <h1 className="text-2xl font-semibold">Настройки</h1>
      <div className="bg-card border rounded-lg p-4 space-y-3">
        <div className="space-y-2">
          <Label>Ваш Telegram ID для уведомлений о заказах</Label>
          <Input
            value={adminChatId}
            onChange={(e) => setAdminChatId(e.target.value)}
            placeholder="например, 123456789"
          />
          <p className="text-xs text-muted-foreground">
            Чтобы узнать ID — напишите своему боту команду <code>/id</code>. Бот вернёт ваш ID.
            Вставьте его сюда и нажмите «Сохранить». Все уведомления о новых заказах будут
            приходить именно туда.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={onSave}>Сохранить</Button>
          {saved && <span className="text-sm text-green-600">Сохранено ✓</span>}
        </div>
      </div>

      <div className="bg-card border rounded-lg p-4 space-y-1 text-sm">
        <h2 className="font-medium mb-2">Доступ в админ-панель</h2>
        <p>Логин и пароль: <code>admin</code> / <code>admin</code></p>
        <p className="text-muted-foreground">
          Для смены — обратитесь к разработчику или измените секреты <code>ADMIN_USERNAME</code> и
          <code> ADMIN_PASSWORD</code> в настройках проекта.
        </p>
      </div>

      <div className="bg-card border border-destructive/40 rounded-lg p-4 space-y-3">
        <h2 className="font-medium text-destructive">Опасная зона</h2>
        <p className="text-sm text-muted-foreground">
          Полный сброс: удалит все товары, категории, изображения, файлы товаров, заказы,
          корзины пользователей и скриншоты оплаты. Счётчики обнулятся. Настройки и реквизиты
          оплаты сохранятся.
        </p>
        <div className="flex items-center gap-2">
          <Button variant="destructive" onClick={onReset} disabled={resetting}>
            {resetting ? "Сбрасываю..." : "Сбросить все данные"}
          </Button>
          {resetDone && <span className="text-sm text-green-600">Готово ✓</span>}
        </div>
      </div>
    </div>
  );
}