/** Per-user VIP tariff assignment (e.g. legacy cheap price via hidden link). */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations-supabase/types";

type SupabaseAdmin = SupabaseClient<Database>;

type MemberUser = {
  username?: string | null;
  first_name?: string | null;
  last_name?: string | null;
};

export async function assignMemberTariff(
  s: SupabaseAdmin,
  telegram_id: number,
  user: MemberUser,
  tariff_id: string,
  source: "deep_link" | "payment" | "admin" = "deep_link",
) {
  const { getConfiguredBotId } = await import("./tenant-config.server");
  const { error } = await s.from("vip_member_profiles").upsert(
    {
      bot_id: getConfiguredBotId(),
      telegram_id,
      username: user.username ?? null,
      first_name: user.first_name ?? null,
      last_name: user.last_name ?? null,
      assigned_tariff_id: tariff_id,
      assigned_at: new Date().toISOString(),
      assigned_source: source,
    },
    { onConflict: "bot_id,telegram_id" },
  );
  if (error) console.error("[vip-member] assign failed", error);
}

export async function getMemberAssignedTariff(s: SupabaseAdmin, telegram_id: number) {
  const { data } = await s
    .from("vip_member_profiles")
    .select("*, vip_tariffs(*)")
    .eq("telegram_id", telegram_id)
    .maybeSingle();

  const tariff = data?.vip_tariffs as { id: string; is_active: boolean; is_public?: boolean } | null;
  if (!data?.assigned_tariff_id || !tariff?.is_active) return null;
  return tariff;
}
