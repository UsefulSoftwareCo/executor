import { HostedAppSessions } from "@executor-js/hosted-server/app-ui";
import { createLogger } from "@better-auth/core/env";
import { generateId } from "@better-auth/core/utils/id";
import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth";
import { createInternalAdapter } from "better-auth/db";
import { getAdapter } from "better-auth/db/adapter";
import { Effect, Layer } from "effect";
import { AuthDatabase, appSessionsPerCall, boundAuthAdapter } from "./auth-database.ts";

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

const impersonationColumn = {
  id: "admin-impersonation",
  schema: { session: { fields: { impersonatedBy: { type: "string", required: false } } } },
} satisfies BetterAuthPlugin;

const launchCredentialTables = {
  id: "app-launch-credentials",
  schema: {
    apikey: {
      fields: {
        referenceId: { type: "string" },
        enabled: { type: "boolean", required: false },
        expiresAt: { type: "date", required: false },
      },
    },
    mcpGrant: {
      fields: {
        userId: { type: "string" },
        resource: { type: "string" },
        revoked: { type: "boolean" },
        connection: { type: "string", required: false },
      },
    },
    mcpConnection: {
      fields: {
        userId: { type: "string" },
        resource: { type: "string" },
        revoked: { type: "boolean" },
      },
    },
  },
} satisfies BetterAuthPlugin;

export const cloudAppSessions = Effect.gen(function* () {
  const database = yield* AuthDatabase;
  const options = {
    database: database.options,
    plugins: [organizationTables, impersonationColumn, launchCredentialTables],
    verification: { disableCleanup: true },
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
