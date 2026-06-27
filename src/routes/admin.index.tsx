import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { listOrders } from "@/lib/orders.functions";
import { listProducts } from "@/lib/products.functions";

export const Route = createFileRoute("/admin/")({
  component: Dashboard,
});

function Dashboard() {
  const orders = useQuery({ queryKey: ["orders"], queryFn: () => listOrders() });
  const products = useQuery({ queryKey: ["products"], queryFn: () => listProducts() });

  const newOrders = (orders.data ?? []).filter(
    (o: any) => o.status === "awaiting_confirmation" || o.status === "awaiting_payment",
  ).length;
  const total = (orders.data ?? []).length;
  const delivered = (orders.data ?? []).filter((o: any) => o.status === "delivered").length;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Дашборд</h1>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Товары" value={(products.data ?? []).length} />
        <Stat label="Всего заказов" value={total} />
        <Stat label="Ждут подтверждения" value={newOrders} highlight={newOrders > 0} />
        <Stat label="Выдано" value={delivered} />
      </div>
      <div className="bg-card border rounded-lg p-4">
        <h2 className="font-medium mb-2">Как пользоваться</h2>
        <ol className="list-decimal pl-5 text-sm space-y-1 text-muted-foreground">
          <li>Создайте категории и добавьте товары.</li>
          <li>В разделе «Реквизиты» отредактируйте инструкции по оплате для каждой страны.</li>
          <li>В «Настройках» укажите ваш Telegram ID — туда будут приходить уведомления о заказах.</li>
          <li>Когда придёт заказ — проверьте скриншот оплаты и нажмите «Подтвердить». Бот сам отправит файлы покупателю.</li>
        </ol>
      </div>
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className={`rounded-lg border p-4 bg-card ${highlight ? "border-primary ring-1 ring-primary/40" : ""}`}>
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className={`text-2xl font-semibold mt-1 ${highlight ? "text-primary" : ""}`}>{value}</div>
    </div>
  );
}