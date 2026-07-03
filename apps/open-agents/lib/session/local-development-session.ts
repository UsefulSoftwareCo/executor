import "server-only";

import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import type { Session } from "./types";

const LOCAL_AUTH_MODE = "local";
const LOCAL_USER_ID = "local-user";
const LOCAL_USERNAME = "local-user";
const LOCAL_EMAIL = "local@vercel.com";
const LOCAL_NAME = "Local User";

function getLocalUser() {
  return {
    id: process.env.OPEN_AGENTS_LOCAL_USER_ID || LOCAL_USER_ID,
    username: process.env.OPEN_AGENTS_LOCAL_USERNAME || LOCAL_USERNAME,
    email: process.env.OPEN_AGENTS_LOCAL_EMAIL || LOCAL_EMAIL,
    avatar: process.env.OPEN_AGENTS_LOCAL_AVATAR_URL || "",
    name: process.env.OPEN_AGENTS_LOCAL_NAME || LOCAL_NAME,
  };
}

export function isLocalDevelopmentAuthEnabled(): boolean {
  const authMode = process.env.OPEN_AGENTS_AUTH_MODE;
  return process.env.NODE_ENV !== "production" && authMode === LOCAL_AUTH_MODE;
}

export function getLocalDevelopmentUserId(): string {
  return getLocalUser().id;
}

export async function ensureLocalDevelopmentUser(): Promise<void> {
  const user = getLocalUser();
  const now = new Date();

  await db
    .insert(users)
    .values({
      id: user.id,
      username: user.username,
      email: user.email,
      emailVerified: true,
      name: user.name,
      avatarUrl: user.avatar,
      isAdmin: true,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: now,
    })
    .onConflictDoUpdate({
      target: users.id,
      set: {
        username: user.username,
        email: user.email,
        emailVerified: true,
        name: user.name,
        avatarUrl: user.avatar,
        isAdmin: true,
        updatedAt: now,
        lastLoginAt: now,
      },
    });
}

export async function getLocalDevelopmentSession(): Promise<Session> {
  await ensureLocalDevelopmentUser();
  const user = getLocalUser();

  return {
    created: Date.now(),
    authProvider: "vercel",
    user,
  };
}
