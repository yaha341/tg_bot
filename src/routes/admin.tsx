import { createFileRoute, Outlet, Link, redirect, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { adminCheck, adminLogout } from "@/lib/admin.functions";
import { Button } from "@/components-ui/button";

export const Route = createFileRoute("/admin")({
  beforeLoad: async () => {
    const res = await adminCheck();
    if (!res.authed) throw redirect({ to: "/login" });
  },
  head: () => ({ meta: [{ title: "Админ-панель" }] }),
  component: AdminLayout,
});

function AdminLayout() {
  const router = useRouter();
  const logout = useServerFn(adminLogout);
  return (
    <div className="min-h-screen bg-muted/30">
      <header className="border-b bg-card">
        <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between gap-4">
          <div className="flex items-center gap-1 overflow-x-auto">
            <Link to="/admin" className="font-semibold mr-3 shrink-0">📚 Магазин</Link>
            <NavLink to="/admin">Дашборд</NavLink>
            <NavLink to="/admin/categories">Категории</NavLink>
            <NavLink to="/admin/products">Товары</NavLink>
            <NavLink to="/admin/orders">Заказы</NavLink>
            <NavLink to="/admin/broadcast">Рассылка</NavLink>
            <NavLink to="/admin/payment-methods">Реквизиты</NavLink>
            <NavLink to="/admin/settings">Настройки</NavLink>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              await logout();
              await router.navigate({ to: "/login" });
            }}
          >
            Выйти
          </Button>
        </div>
      </header>
      <main className="max-w-7xl mx-auto p-4 md:p-6">
        <Outlet />
      </main>
    </div>
  );
}

function NavLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link
      to={to}
      className="px-3 py-1.5 rounded-md text-sm hover:bg-accent shrink-0"
      activeProps={{ className: "px-3 py-1.5 rounded-md text-sm bg-accent font-medium shrink-0" }}
      activeOptions={{ exact: to === "/admin" }}
    >
      {children}
    </Link>
  );
}