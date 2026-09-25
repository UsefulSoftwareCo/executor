/** The patched Workers socket sends each node-postgres query as one write. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";

// Node resolves `pg-cloudflare` to its empty build; Workers load `dist/index.js`.
const require = createRequire(import.meta.url);
const pgRequire = createRequire(require.resolve("pg"));
const packageRoot = dirname(pgRequire.resolve("pg-cloudflare/package.json"));
const { CloudflareSocket } = require(join(packageRoot, "dist/index.js")) as {
  CloudflareSocket: new (ssl: boolean) => {
    writable: boolean;
    cork(): void;
    uncork(): void;
    write(
      data: Uint8Array | string,
      encoding?: BufferEncoding,
      callback?: (error?: unknown) => void,
    ): unknown;
    end(data?: Buffer, encoding?: BufferEncoding, callback?: (error?: unknown) => void): unknown;
  };
};
const Connection = pgRequire("./connection.js") as new (options: { stream: unknown }) => unknown;
const Query = pgRequire("./query.js") as new (config: { text: string; values: unknown[] }) => {
  submit(connection: unknown): unknown;
};

/** A socket whose Workers stream records each write and settles it with `result`. */
const recordingSocket = (result: () => Promise<void> = () => Promise.resolve()) => {
  const socket = new CloudflareSocket(false);
  const writes: Buffer[] = [];
  let closed = 0;
  Object.assign(socket, {
    writable: true,
    _cfWriter: {
      write: (data: Uint8Array) => {
        writes.push(Buffer.from(data));
        return result();
      },
    },
    _cfSocket: { close: () => closed++ },
  });
  return { socket, writes, closed: () => closed };
};

/** PostgreSQL frontend message types, in the order they were written. */
const messageTypes = (frame: Buffer) => {
  const types: string[] = [];
  for (let offset = 0; offset < frame.length; offset += 1 + frame.readInt32BE(offset + 1))
    types.push(String.fromCharCode(frame[offset]!));
  return types;
};

test("an extended-protocol query is written once with all five messages", async () => {
  const { socket, writes } = recordingSocket();
  const query = new Query({ text: "select $1::int as value", values: [1] });
  assert.equal(query.submit(new Connection({ stream: socket })), null);
  await Promise.resolve();
  assert.equal(writes.length, 1);
  assert.deepEqual(messageTypes(writes[0]!), ["P", "B", "D", "E", "S"]);
});

test("corked writes flush in order on the final uncork and settle every callback", async () => {
  const { socket, writes } = recordingSocket();
  const settled: Array<string> = [];
  socket.cork();
  socket.cork();
  socket.write("a", "utf8", () => settled.push("a"));
  socket.write(Buffer.from("b"), "utf8", () => settled.push("b"));
  socket.uncork();
  assert.equal(writes.length, 0);
  socket.write("c", "utf8", () => settled.push("c"));
  socket.uncork();
  socket.uncork();
  socket.write("d", "utf8", () => settled.push("d"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(
    writes.map((write) => write.toString()),
    ["abc", "d"],
  );
  assert.deepEqual(settled, ["a", "b", "c", "d"]);
});

test("a failed flush reports the error to every buffered callback", async () => {
  const failure = new Error("synthetic write failure");
  const { socket } = recordingSocket(() => Promise.reject(failure));
  const errors: unknown[] = [];
  socket.cork();
  socket.write("a", "utf8", (error) => errors.push(error));
  socket.write("b", "utf8", (error) => errors.push(error));
  socket.uncork();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(errors, [failure, failure]);
});

test("end sends buffered bytes before closing", async () => {
  const { socket, writes, closed } = recordingSocket();
  socket.cork();
  socket.write("buffered");
  socket.end(Buffer.from("X"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(
    writes.map((write) => write.toString()),
    ["buffered", "X"],
  );
  assert.equal(closed(), 1);
});
