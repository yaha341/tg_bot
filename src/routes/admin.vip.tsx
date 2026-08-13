import { createFileRoute, Outlet, Link, redirect } from "@tanstack/react-router";
import { getCapabilitiesFn } from "@/lib/capabilities.functions";

export const Route = createFileRoute("/admin/vip")({
  beforeLoad: async () => {
    const modules = await getCapabilitiesFn();
    if (!modules.vip) throw redirect({ to: "/admin" });
  },
  component: AdminVipLayout,
});

function NavLink({ to, children, exact }: { to: string; children: React.ReactNode; exact?: boolean }) {
  return (
    <Link
      to={to}
      className="px-3 py-1.5 rounded-md text-sm hover:bg-accent shrink-0"
      activeProps={{ className: "px-3 py-1.5 rounded-md text-sm bg-accent font-medium shrink-0" }}
      activeOptions={exact ? { exact: true } : undefined}
    >
      {children}
    </Link>
  );
}

function AdminVipLayout() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-1 border-b pb-2 overflow-x-auto">
        <NavLink to="/admin/vip" exact>Дашборд VIP</NavLink>
        <NavLink to="/admin/vip/tariffs">Тарифы</NavLink>
        <NavLink to="/admin/vip/subscribers">Подписчики</NavLink>
        <NavLink to="/admin/vip/settings">Настройки VIP</NavLink>
      </div>
      <div>
        <Outlet />
      </div>
    </div>
  );
}
