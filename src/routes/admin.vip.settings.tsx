import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { getSettings, saveSetting } from "@/lib/settings.functions";
import { runVipCronNow } from "@/lib/vip-subscriptions.functions";
import { Button } from "@/components-ui/button";
import { Input } from "@/components-ui/input";
import { Label } from "@/components-ui/label";
import { Checkbox } from "@/components-ui/checkbox";
import { Textarea } from "@/components-ui/textarea";

export const Route = createFileRoute("/admin/vip/settings")({
  component: AdminVipSettings,
});

function AdminVipSettings() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => getSettings() });

  const [groupId, setGroupId] = useState("");
  const [warnDays, setWarnDays] = useState("");
  const [warnDays2, setWarnDays2] = useState("");
  const [testMode, setTestMode] = useState(false);
  const [instructions, setInstructions] = useState("");
  const [welcomeMsg, setWelcomeMsg] = useState("");
  const [saved, setSaved] = useState(false);
  const [cronBusy, setCronBusy] = useState(false);
  const [cronResult, setCronResult] = useState<string | null>(null);

  useEffect(() => {
    if (settings.data) {
      setGroupId(settings.data.vip_group_id || "");
      setWarnDays(settings.data.vip_warn_days || "3");
      setWarnDays2(settings.data.vip_warn_days_2 || "1");
      setTestMode(settings.data.vip_test_mode === "true");
      setInstructions(settings.data.vip_payment_instructions || "");
      setWelcomeMsg(settings.data.vip_welcome_message || "");
    }
  }, [settings.data]);

  const onSave = async () => {
    await saveSetting({ data: { key: "vip_group_id", value: groupId } });
    await saveSetting({ data: { key: "vip_warn_days", value: warnDays } });
    await saveSetting({ data: { key: "vip_warn_days_2", value: warnDays2 } });
    await saveSetting({ data: { key: "vip_test_mode", value: testMode ? "true" : "false" } });
    await saveSetting({ data: { key: "vip_payment_instructions", value: instructions } });
    await saveSetting({ data: { key: "vip_welcome_message", value: welcomeMsg } });

    qc.invalidateQueries({ queryKey: ["settings"] });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const onRunCron = async () => {
    setCronBusy(true);
    setCronResult(null);
    try {
      const r = await runVipCronNow();
      setCronResult(
        `Готово: 1-е предупр. ${r.warned}, 2-е предупр. ${r.warned2 ?? 0}, истекло/кик ${r.expired}, ошибок кика ${r.kickFailed}` +
          (r.errors.length ? `\n${r.errors.join("\n")}` : ""),
      );
    } catch (e: any) {
      setCronResult("Ошибка: " + e.message);
    } finally {
      setCronBusy(false);
    }
  };

  if (settings.isLoading) return <div>Загрузка...</div>;

  return (
    <div className="space-y-6 max-w-2xl">
      <h2 className="text-xl font-semibold">Настройки VIP-группы</h2>

      <div className="bg-card border rounded-lg p-4 space-y-4">
        <div className="space-y-2">
          <Label>ID Telegram Группы (начинается с -100)</Label>
          <Input value={groupId} onChange={(e) => setGroupId(e.target.value)} placeholder="-100123456789" />
          <p className="text-xs text-muted-foreground">Бот должен быть администратором в этой группе с правом "Приглашать участников" и "Исключать участников".</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>
              {testMode ? "1-е предупреждение (за N минут)" : "1-е предупреждение (за N дней)"}
            </Label>
            <Input type="number" min={1} value={warnDays} onChange={(e) => setWarnDays(e.target.value)} />
            <p className="text-xs text-muted-foreground">
              Обычно 3 {testMode ? "минуты" : "дня"} до конца.
            </p>
          </div>
          <div className="space-y-2">
            <Label>
              {testMode ? "2-е предупреждение (за N минут)" : "2-е предупреждение (за N дней)"}
            </Label>
            <Input type="number" min={1} value={warnDays2} onChange={(e) => setWarnDays2(e.target.value)} />
            <p className="text-xs text-muted-foreground">
              Обычно 1 {testMode ? "минута" : "день"} до конца. Должно быть меньше первого.
            </p>
          </div>
        </div>

        <div className="space-y-2 pt-2">
          <Label>Текст с реквизитами для VIP</Label>
          <Textarea 
            value={instructions} 
            onChange={(e) => setInstructions(e.target.value)} 
            rows={5}
            placeholder="Оплатите на Каспи +7... и пришлите чек"
          />
          <p className="text-xs text-muted-foreground">Этот текст показывается после того как пользователь выбрал тариф.</p>
        </div>

        <div className="space-y-2 pt-2">
          <Label>Приветственное сообщение после выдачи доступа</Label>
          <Textarea 
            value={welcomeMsg} 
            onChange={(e) => setWelcomeMsg(e.target.value)} 
            rows={3}
            placeholder="Спасибо за оплату! Ваша ссылка ниже:"
          />
        </div>

        <div className="border rounded-md p-4 bg-muted/30 mt-4 space-y-2">
          <div className="flex items-center gap-2">
            <Checkbox checked={testMode} onCheckedChange={(c) => setTestMode(!!c)} id="test-mode" />
            <Label htmlFor="test-mode" className="font-semibold text-destructive cursor-pointer">Включить режим тестирования</Label>
          </div>
          <p className="text-xs text-muted-foreground ml-6">
            Если включено: срок берётся из поля «минуты» в тарифе (не из дней). Включайте <b>до</b> подтверждения
            оплаты — уже активные подписки сами не пересчитаются. Оба предупреждения тоже в минутах.
          </p>
          <div className="ml-6 pt-2 flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onRunCron} disabled={cronBusy}>
              {cronBusy ? "Проверяю…" : "Запустить проверку подписок сейчас"}
            </Button>
            <span className="text-xs text-muted-foreground">Для теста кика/напоминаний без ожидания cron</span>
          </div>
          {cronResult && <pre className="text-xs ml-6 whitespace-pre-wrap text-muted-foreground">{cronResult}</pre>}
        </div>

        <div className="pt-4 flex items-center gap-3">
          <Button onClick={onSave}>Сохранить настройки</Button>
          {saved && <span className="text-sm text-green-600">Сохранено ✓</span>}
        </div>
      </div>
    </div>
  );
}
