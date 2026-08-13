import { createServerFn } from "@tanstack/react-start";
import { getTenantConfig } from "./tenant-config.server";

export const getCapabilitiesFn = createServerFn({ method: "GET" }).handler(async () => {
  const config = await getTenantConfig();
  return config.modules;
});
