import { supabaseAdmin } from "@/integrations-supabase/client.server";

export const MODULE_NAMES = [
  "shop",
  "vip",
  "instagram",
  "broadcasts",
  "robokassa",
  "receipt_ocr",
  "blocked_users",
  "multi_file_materials",
  "multi_currency",
  "courses",
  "coupons",
  "referral",
  "crm_integration",
] as const;

export type ModuleName = (typeof MODULE_NAMES)[number];
export type TenantModules = Record<ModuleName, boolean>;

export type TenantConfig = {
  botId: string;
  modules: TenantModules;
  settings: Record<string, unknown>;
};

const DEFAULT_MODULES: TenantModules = {
  shop: true,
  vip: false,
  instagram: false,
  broadcasts: false,
  robokassa: false,
  receipt_ocr: false,
  blocked_users: false,
  multi_file_materials: false,
  multi_currency: false,
  courses: false,
  coupons: false,
  referral: false,
  crm_integration: false,
};

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeModules(value: unknown): TenantModules {
  const source = objectValue(value);
  return MODULE_NAMES.reduce<TenantModules>(
    (modules, name) => {
      modules[name] = source[name] === true;
      return modules;
    },
    { ...DEFAULT_MODULES },
  );
}

export function getConfiguredBotId(): string {
  const botId = process.env.BOT_ID?.trim();
  if (!botId) {
    throw new Error("BOT_ID не задан. Общий deployment должен принадлежать одному арендатору.");
  }
  return botId;
}

export async function getTenantConfig(): Promise<TenantConfig> {
  const botId = getConfiguredBotId();
  const { data, error } = await supabaseAdmin
    .from("bots")
    .select("id, modules, settings")
    .eq("id", botId)
    .maybeSingle();

  if (error) {
    console.error("[tenant-config] failed to load tenant configuration:", error);
    throw new Error("Не удалось загрузить конфигурацию арендатора.");
  }

  if (!data) {
    throw new Error(`Арендатор ${botId} не найден в таблице bots.`);
  }

  return {
    botId,
    modules: normalizeModules(data.modules),
    settings: objectValue(data.settings),
  };
}

export async function moduleEnabled(moduleName: ModuleName): Promise<boolean> {
  try {
    const config = await getTenantConfig();
    return config.modules[moduleName];
  } catch (error) {
    console.error(`[tenant-config] treating ${moduleName} as disabled:`, error);
    return false;
  }
}

export class ModuleDisabledError extends Error {
  readonly moduleName: ModuleName;
  readonly status = 403;

  constructor(moduleName: ModuleName) {
    super(`Модуль ${moduleName} не включён для текущего арендатора.`);
    this.name = "ModuleDisabledError";
    this.moduleName = moduleName;
  }
}

export async function requireModule(moduleName: ModuleName): Promise<TenantConfig> {
  const config = await getTenantConfig();
  if (!config.modules[moduleName]) {
    throw new ModuleDisabledError(moduleName);
  }
  return config;
}
