/** Drafts and source edits belong to the same app identities as running deployments. */
import { Clock, Crypto, Effect } from "effect";
import type { BlobStorage } from "../contracts/blobs.ts";
import { initializeAppRepository, writeInitialSource } from "./initial-source.ts";
import { appSlug } from "../contracts/app-slug.ts";
import { AppNameTaken, type AppCopyOrigin } from "../contracts/apps.ts";
import { AppCodeId, AppId, StorageError } from "../contracts/shared.ts";
import { SourceError, type AppSourceStorage } from "../contracts/source.ts";
import type { Executor, ResourceLifecycle } from "../contracts/executor.ts";
import { query, transaction, type Query } from "./database.ts";
import { storedApp, createApp as storeApp } from "./apps.ts";

/** Product hosts authorize the owner; SDK mutations enforce names and optimistic Git writes. */
export const makeAppAuthoring = (
  db: Query,
  sources: AppSourceStorage,
  blobs: BlobStorage,
  crypto: Crypto.Crypto,
  lifecycle?: ResourceLifecycle,
) => {
  const create = (
    input: Parameters<Executor["apps"]["create"]>[0],
    copiedFrom: AppCopyOrigin | null = null,
  ) =>
    Effect.gen(function* () {
      const code = AppCodeId.make(
        `code_${yield* crypto.randomUUIDv4.pipe(Effect.mapError(() => new StorageError()))}`,
      );
      const id = AppId.make(
        `app_${yield* crypto.randomUUIDv4.pipe(Effect.mapError(() => new StorageError()))}`,
      );
      yield* writeInitialSource(blobs, code, input.files);
      const app = {
        id,
        code,
        repository: null,
        owner: input.owner,
        name: input.name,
        slug: appSlug(input.name),
        activeDeployment: null,
        copiedFrom,
        accounts: {},
        createdAt: new Date(yield* Clock.currentTimeMillis),
      };
      yield* transaction(db, (tx) =>
        Effect.gen(function* () {
          const existing = yield* query(() =>
            tx.findFirst("apps", {
              where: (b) => b.and(b("owner", "=", input.owner), b("name", "=", input.name)),
            }),
          );
          if (existing !== null)
            return yield* new AppNameTaken({ owner: input.owner, name: input.name });
          const stored = { ...app, deploySequence: 0, activatedSequence: 0 };
          yield* storeApp(tx, stored);
          if (lifecycle) yield* lifecycle.appCreated({ ...app, requirements: { accounts: {} } });
        }),
      );
      return { ...app, requirements: { accounts: {} } };
    });
  return {
    create,
    workspace: (input: Parameters<Executor["apps"]["workspace"]>[0]) =>
      Effect.gen(function* () {
        const app = yield* storedApp(db, input);
        yield* initializeAppRepository(db, sources, blobs, app);
        const source = yield* sources.workspace(app.code);
        if (source === null) return yield* new SourceError({ reason: "not-found" });
        return source;
      }),
    commit: (input: Parameters<Executor["apps"]["commit"]>[0]) =>
      Effect.gen(function* () {
        const app = yield* storedApp(db, input);
        yield* initializeAppRepository(db, sources, blobs, app);
        return yield* sources.commit({
          code: app.code,
          expected: input.expected,
          files: input.files,
          message: input.message,
        });
      }),
  };
};
