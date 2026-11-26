import { PGlite } from "@electric-sql/pglite";
import { Effect, Exit, Schema } from "effect";
import { driver, Target } from "./platform.ts";
import { Evidence } from "./evidence.ts";
import { controlRequest } from "./server-control.ts";

export const LegacySealed = Schema.Struct({
  sealed: Schema.Struct({
    id: Schema.NonEmptyString,
    value: Schema.Record(Schema.String, Schema.Json),
  }),
});

export const LegacyFingerprint = Schema.Struct({
  fingerprint: Schema.Struct({ purpose: Schema.NonEmptyString, value: Schema.String }),
});

export const LegacyStatement = Schema.Struct({
  sql: Schema.NonEmptyString,
  params: Schema.optional(
    Schema.Array(
      Schema.Union([
        Schema.String,
        Schema.Number,
        Schema.Boolean,
        Schema.Null,
        LegacySealed,
        LegacyFingerprint,
      ]),
    ),
  ),
});
export const LegacyStatements = Schema.NonEmptyArray(LegacyStatement);
export const LegacyResults = Schema.Array(
  Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
);

export class LegacyStatementFailed extends Schema.TaggedError<LegacyStatementFailed>()(
  "LegacyStatementFailed",
  { index: Schema.Number, message: Schema.String },
) {}

export const productDatabase = (dataDirectory: string, target: "self-host" | "local") =>
  `${dataDirectory}/${target === "self-host" ? "hosted.pglite" : "executor.pglite"}`;

export const LegacyDatabase = Schema.Literals(["product", "mcp-auth"]);
export type LegacyDatabase = typeof LegacyDatabase.Type;

export const legacyDatabase = (
  dataDirectory: string,
  target: "self-host" | "local",
  database: LegacyDatabase,
) =>
  database === "product"
    ? productDatabase(dataDirectory, target)
    : target === "local"
      ? `${dataDirectory}/mcp-auth.pglite`
      : undefined;

const seal = (key: string, { id, value }: typeof LegacySealed.Type.sealed, index: number) =>
  Effect.gen(function* () {
    const failed = () => new LegacyStatementFailed({ index, message: "Sealing a value failed" });
    const aes = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.importKey("raw", Uint8Array.from(Buffer.from(key, "hex")), "AES-GCM", false, [
          "encrypt",
        ]),
      catch: failed,
    });
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.encrypt(
          { name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode(id) },
          aes,
          new TextEncoder().encode(JSON.stringify(value)),
        ),
      catch: failed,
    });
    const envelope = new Uint8Array(13 + encrypted.byteLength);
    envelope[0] = 1;
    envelope.set(nonce, 1);
    envelope.set(new Uint8Array(encrypted), 13);
    return envelope;
  });

const fingerprint = (
  key: string,
  { purpose, value }: typeof LegacyFingerprint.Type.fingerprint,
  index: number,
) =>
  Effect.gen(function* () {
    const failed = () =>
      new LegacyStatementFailed({ index, message: "Fingerprinting a value failed" });
    const root = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.importKey(
          "raw",
          Uint8Array.from(Buffer.from(key, "hex")),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        ),
      catch: failed,
    });
    const derived = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.sign(
          "HMAC",
          root,
          new TextEncoder().encode("executor credential fingerprints"),
        ),
      catch: failed,
    });
    const hmac = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
      catch: failed,
    });
    const signature = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.sign(
          "HMAC",
          hmac,
          new TextEncoder().encode(JSON.stringify([purpose, value])),
        ),
      catch: failed,
    });
    return Buffer.from(signature).toString("hex");
  });

export const applyLegacyStatements = (
  database: string,
  statements: typeof LegacyStatements.Type,
  key: string,
) =>
  Effect.acquireUseRelease(
    driver("open product database", () =>
      PGlite.create(database, { parsers: { 1082: (value) => value, 1114: (value) => value } }),
    ),
    (db) =>
      Effect.acquireUseRelease(
        driver("begin legacy write", () => db.exec("BEGIN")),
        () =>
          Effect.forEach(statements, (statement, index) =>
            Effect.forEach(
              statement.params ?? [],
              (
                param,
              ): Effect.Effect<
                Uint8Array | string | number | boolean | null,
                LegacyStatementFailed
              > =>
                typeof param !== "object" || param === null
                  ? Effect.succeed(param)
                  : "fingerprint" in param
                    ? fingerprint(key, param.fingerprint, index)
                    : seal(key, param.sealed, index),
            ).pipe(
              Effect.flatMap((params) =>
                Effect.tryPromise({
                  try: () => db.query<Record<string, unknown>>(statement.sql, params),
                  catch: (cause) =>
                    new LegacyStatementFailed({
                      index,
                      message: cause instanceof Error ? cause.message : "Unknown database error",
                    }),
                }),
              ),
              Effect.map((result) => result.rows),
            ),
          ),
        (_, exit) =>
          driver("finish legacy write", () =>
            db.exec(Exit.isSuccess(exit) ? "COMMIT" : "ROLLBACK"),
          ).pipe(Effect.orDie),
      ),
    (db) => driver("close product database", () => db.close()).pipe(Effect.orDie),
  );

export const legacyStorage = (
  statements: typeof LegacyStatements.Type,
  database: LegacyDatabase = "product",
) =>
  Effect.gen(function* () {
    const target = yield* Target,
      evidence = yield* Evidence;
    if (target.metadata.target === "cloud")
      return yield* Effect.die("Legacy storage requires a runner-owned product database");
    return yield* evidence.step(
      `Legacy storage write to the ${database} database (${statements.length} statements)`,
      controlRequest("storage/legacy", 200, { statements, database }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(LegacyResults))),
        Effect.orDie,
      ),
    );
  });
