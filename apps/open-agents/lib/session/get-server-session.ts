import { headers } from "next/headers";
import { cache } from "react";
import {
  getLocalDevelopmentSession,
  isLocalDevelopmentAuthEnabled,
} from "./local-development-session";
import type { Session } from "./types";

function extractUsername(user: {
  name?: string | null;
  [key: string]: unknown;
}): string {
  if (typeof user.username === "string" && user.username) {
    return user.username;
  }
  return user.name ?? "";
}

export const getServerSession = cache(
  async (): Promise<Session | undefined> => {
    if (isLocalDevelopmentAuthEnabled()) {
      return getLocalDevelopmentSession();
    }

    const { auth } = await import("@/lib/auth/config");
    const baSession = await auth.api.getSession({
      headers: await headers(),
    });

    if (!baSession?.user) {
      return undefined;
    }

    return {
      created: baSession.session.createdAt.getTime(),
      authProvider: "vercel",
      user: {
        id: baSession.user.id,
        username: extractUsername(baSession.user),
        email: baSession.user.email ?? undefined,
        avatar: baSession.user.image ?? "",
        name: baSession.user.name ?? undefined,
      },
    };
  },
);
