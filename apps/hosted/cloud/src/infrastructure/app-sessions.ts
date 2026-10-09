/** App-origin sessions read Better Auth's tables without the dashboard's sign-in stack. */
import { HostedAppSessions } from "@executor-js/hosted-server/app-ui";
import { createLogger } from "@better-auth/core/env";
import { generateId } from "@better-auth/core/utils/id";
import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth";
import { createInternalAdapter } from "better-auth/db";
import { getAdapter } from "better-auth/db/adapter";
import { Effect, Layer } from "effect";
import { AuthDatabase, appSessionsPerCall, boundAuthAdapter } from "./auth-database.ts";

/**
 * The organization plugin's columns that app sessions and MCP grant checks read. The
 * dashboard's plugin owns these tables and their migrations; its endpoints are not loaded here.
 */
export const organizationTables = {
  id: "organization",
  schema: {
    organization: { fields: { slug: { type: "string" } } },
    member: {
      fields: {
        organizationId: { type: "string" },
        userId: { type: "string" },
        role: { type: "string" },
      },
    },
  },
} satisfies BetterAuthPlugin;

/**
 * App pages only keep verification records and read sessions, members and
 * organizations. The dashboard's full Better Auth instance writes the same rows:
 * neither configures verification storage, secondary storage, ID generation or
 * verification hooks, so both adapters read and consume them identically.
 */
export const cloudAppSessions = Effect.gen(function* () {
  const database = yield* AuthDatabase;
  const options = {
    database: database.options,
    plugins: [organizationTables],
    // As in the dashboard: the deployment migration validates the schema, not requests.
    advanced: { database: { validateSchema: false } },
  } satisfies BetterAuthOptions;
  const makeStore = async () => {
    const adapter = await getAdapter(options);
    return {
      adapter,
      internalAdapter: createInternalAdapter(adapter, {
        options,
        logger: createLogger(),
        hooks: [],
        generateId: ({ size }) => generateId(size),
      }),
    };
  };
  // One adapter per isolate, like the dashboard's Better Auth instance. It holds no
  // connection: every call binds the calling invocation's pool through `database`.
  let store: Awaited<ReturnType<typeof makeStore>> | undefined;
  return Layer.succeed(
    HostedAppSessions,
    appSessionsPerCall(
      Effect.all([Effect.promise(async () => (store ??= await makeStore())), database.bind]).pipe(
        Effect.map(([{ adapter, internalAdapter }, bind]) => ({
          internalAdapter: boundAuthAdapter(internalAdapter, bind),
          adapter: boundAuthAdapter(adapter, bind),
        })),
      ),
    ),
  );
});
