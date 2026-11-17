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
    const file = path.join(directory, "mcp.sqlite");
    // Create the file with its final 0600 mode before SQLite opens it: SQLite would otherwise
    // create it at umask permissions, and the chmod below only follows that.
    yield* Effect.scoped(fs.open(file, { flag: "a", mode: 0o600 }).pipe(Effect.asVoid));
    const database = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const database = new DatabaseSync(file);
        database.exec(
          "CREATE TABLE IF NOT EXISTS mcp_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        );
        return database;
      }),
      (database) => Effect.sync(() => database.close()),
    );
    // Tightens a file an earlier release created at umask permissions; a new file is already 0600.
    yield* fs.chmod(file, 0o600);
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
