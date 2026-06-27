import { useSession } from "@tanstack/react-start/server";

export type AdminSession = { authed?: boolean };

export const adminSessionConfig = {
  password: process.env.SESSION_SECRET || "dev-insecure-secret-please-set-SESSION_SECRET-32chars",
  name: "admin-session",
  maxAge: 60 * 60 * 24 * 30,
  cookie: {
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    path: "/",
  },
};

export async function getAdminSession() {
  return useSession<AdminSession>(adminSessionConfig);
}

export async function isAdminAuthed(): Promise<boolean> {
  const s = await getAdminSession();
  return s.data.authed === true;
}

export async function requireAdmin() {
  const s = await getAdminSession();
  if (s.data.authed !== true) {
    throw new Error("Unauthorized");
  }
  return s;
}