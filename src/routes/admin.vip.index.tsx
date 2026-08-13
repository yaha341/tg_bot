import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getVipSubscriptions } from "@/lib/vip-subscriptions.functions";
import { getSettings } from "@/lib/settings.functions";
import { Card, CardHeader, CardTitle, CardContent } from "@/components-ui/card";

export const Route = createFileRoute("/admin/vip/")({
  component: AdminVipDashboard,
});

function AdminVipDashboard() {
  const subs = useQuery({
    queryKey: ["vip_subs", "all"],
    queryFn: () => getVipSubscriptions({ data: { status: "all" } }),
    refetchOnWindowFocus: true,
    staleTime: 0,
  });
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => getSettings() });

  const isTest = settings.data?.vip_test_mode === "true";

  const allSubs = subs.data ?? [];
  const activeSubs = allSubs.filter((s) => s.status === "active");
  const pendingSubs = allSubs.filter((s) => s.status === "pending_payment");
  const expiredSubs = allSubs.filter((s) => s.status === "expired");

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Дашборд VIP-группы</h1>
        {isTest && (
          <span className="bg-yellow-100 text-yellow-800 text-xs px-2 py-1 rounded font-medium border border-yellow-200">
            🧪 Тест-режим активен (время в минутах)
          </span>
        )}
      </div>

      {subs.isError && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="pt-4 text-sm text-red-700">
            Не удалось загрузить подписки: {(subs.error as Error)?.message || "неизвестная ошибка"}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Активных подписок</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{activeSubs.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Ожидают оплаты/подтверждения</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-orange-600">{pendingSubs.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Истёкших подписок</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-muted-foreground">{expiredSubs.length}</div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
