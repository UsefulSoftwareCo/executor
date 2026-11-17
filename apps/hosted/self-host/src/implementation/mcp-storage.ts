/** Source self-host's synchronous metadata adapter; packaged self-host uses its actor's KV. */
import { DatabaseSync } from "node:sqlite";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { dataDirectory } from "../contracts/config.ts";
import { SelfHostMcpStorage } from "../contracts/mcp-storage.ts";

export const nativeMcpStorage = Layer.effect(
  SelfHostMcpStorage,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.resolve(yield* dataDirectory);
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    const database = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const database = new DatabaseSync(path.join(directory, "mcp.sqlite"));
        database.exec(
          "CREATE TABLE IF NOT EXISTS mcp_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        );
        return database;
      }),
      (database) => Effect.sync(() => database.close()),
    );
    yield* fs.chmod(path.join(directory, "mcp.sqlite"), 0o600);
    const read = database.prepare("SELECT value FROM mcp_metadata WHERE key = ?");
    const write = database.prepare(
      "INSERT OR REPLACE INTO mcp_metadata (key, value) VALUES (?, ?)",
    );
    const remove = database.prepare("DELETE FROM mcp_metadata WHERE key = ?");
    const list = database.prepare("SELECT key, value FROM mcp_metadata WHERE key >= ? AND key < ?");
    const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
    const row = Schema.decodeUnknownSync(
      Schema.Struct({ key: Schema.String, value: Schema.String }),
    );
    const value = Schema.decodeUnknownSync(Schema.Struct({ value: Schema.String }));
    return SelfHostMcpStorage.of({
      get: (key) => {
        const row = read.get(key);
        return row === undefined ? undefined : decode(value(row).value);
      },
      put: (key, value) => {
        write.run(key, JSON.stringify(value));
      },
      delete: (key) => remove.run(key),
      list: ({ prefix }) =>
        list.all(prefix, `${prefix}\uffff`).map((record) => {
          const { key, value } = row(record);
          return [key, decode(value)];
        }),
    });
  }),
);
