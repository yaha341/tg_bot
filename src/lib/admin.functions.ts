import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getAdminSession, isAdminAuthed } from "./admin-session.server";

const LoginInput = z.object({ username: z.string().min(1), password: z.string().min(1) });

export const adminLogin = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => LoginInput.parse(data))
  .handler(async ({ data }) => {
    const expectedUser = process.env.ADMIN_USERNAME || "admin";
    const expectedPass = process.env.ADMIN_PASSWORD || "admin";
    if (data.username !== expectedUser || data.password !== expectedPass) {
      return { ok: false as const };
    }
    const s = await getAdminSession();
    await s.update({ authed: true });
    return { ok: true as const };
  });

export const adminLogout = createServerFn({ method: "POST" }).handler(async () => {
  const s = await getAdminSession();
  await s.clear();
  return { ok: true as const };
});

export const adminCheck = createServerFn({ method: "GET" }).handler(async () => {
  return { authed: await isAdminAuthed() };
});