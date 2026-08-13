/** Display timezone for VIP dates (admin + Telegram). Override with APP_TIMEZONE. */
export function appTimeZone(): string {
  return (process.env.APP_TIMEZONE || "Asia/Almaty").trim() || "Asia/Almaty";
}

/** Format date for users/admins in a fixed TZ (Vercel UTC ≠ browser local). */
export function formatDateTimeRu(date: Date | string | null | undefined): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("ru-RU", { timeZone: appTimeZone() });
}
