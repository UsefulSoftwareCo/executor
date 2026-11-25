/**
 * Serve emulators.dev from this runner: the emulate-hosts Worker (the code emulators.dev runs,
 * built by `scripts/ci/emulators.sh bundle`) under miniflare, behind HTTPS on 127.0.0.1:443.
 *
 *   node scripts/ci/emulators-server.ts <worker.js> <state dir>
 *   node scripts/ci/emulators-server.ts --services <worker.js> <file>   writes the service ids, ends
 *
 * The Worker routes on its request URL's host (`<service>.emulators.dev` or the apex), so each
 * request is passed on as `https://<Host><path>`, redirects unfollowed, bodies streamed both ways.
 * `<state>/leaf.pem` and `<state>/leaf.key` are the certificate it serves; `scripts/ci/emulators.sh
 * start` makes them, signed by a CA it makes for this job and adds to every trust store the job's
 * processes read, so TLS verification stays on everywhere. Once listening it writes the service
 * ids the Worker serves to `<state>/services`, one per line, for the hosts file.
 *
 * Miniflare keeps the URL's host, which the Worker routes on, but sends the HTTP `Host` header as
 * its own address, so the emulator's ledger records `127.0.0.1:<port>` as a request's `host`
 * header. No scenario reads it.
 *
 * `EMULATORS_PORT` changes the port, to try it on a machine whose port 443 is in use.
 *
 * Each request taking over a second is logged to stdout (method, service host and status only;
 * the path can hold an instance's unguessable name).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Miniflare } from "miniflare";

const servicesOnly = process.argv[2] === "--services";
const [bundle, state] = process.argv.slice(servicesOnly ? 3 : 2);
if (bundle === undefined || state === undefined) {
  console.error(
    "Usage: node scripts/ci/emulators-server.ts [--services] <worker.js> <state dir | file>",
  );
  process.exit(2);
}

const mf = new Miniflare({
  modules: [{ type: "ESModule", path: "emulate-hosts.js", contents: readFileSync(bundle, "utf8") }],
  compatibilityDate: "2026-06-08",
  compatibilityFlags: ["nodejs_compat"],
  bindings: { EMULATE_HOST_SUFFIX: "emulators.dev" },
  durableObjects: { EMULATOR: "EmulatorDurableObject" },
});
await mf.ready;

const serviceList = async () => {
  const answer = await mf.dispatchFetch("https://emulators.dev/_emulate/services", {
    headers: { accept: "application/json" },
  });
  if (!answer.ok) throw new Error(`The Worker's catalog answered ${answer.status}.`);
  const catalog = (await answer.json()) as
    | { services?: ReadonlyArray<{ id?: unknown }> }
    | ReadonlyArray<{ id?: unknown }>;
  const services = Array.isArray(catalog) ? catalog : (catalog.services ?? []);
  const ids = services.map(({ id }) => id);
  if (ids.length === 0 || !ids.every((id) => typeof id === "string" && /^[a-z0-9-]+$/u.test(id)))
    throw new Error("The Worker's catalog lists no usable service ids.");
  return ids.map((id) => `${id}\n`).join("");
};
if (servicesOnly) {
  writeFileSync(state, await serviceList());
  await mf.dispose();
  process.exit(0);
}

const dropped = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-encoding",
  "content-length",
]);

const server = createServer(
  { key: readFileSync(`${state}/leaf.key`), cert: readFileSync(`${state}/leaf.pem`) },
  (request, response) => {
    const started = Date.now();
    const host = request.headers.host ?? "emulators.dev";
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers))
      if (value !== undefined && !name.startsWith(":"))
        for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one);
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : (Readable.toWeb(request) as ReadableStream<Uint8Array>);
    mf.dispatchFetch(`https://${host}${request.url ?? "/"}`, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
      ...(body === undefined ? {} : { duplex: "half" }),
    })
      .then(async (answer) => {
        const out: Record<string, string | string[]> = {};
        answer.headers.forEach((value, name) => {
          if (!dropped.has(name) && name !== "set-cookie") out[name] = value;
        });
        const cookies = answer.headers.getSetCookie();
        if (cookies.length > 0) out["set-cookie"] = cookies;
        response.writeHead(answer.status, out);
        if (answer.body === null) {
          response.end();
        } else {
          await pipeline(Readable.fromWeb(answer.body as never), response).catch(
            (error: unknown) => {
              console.log(
                `broken body: ${request.method} ${host}: ${String(error).split("\n")[0]}`,
              );
              response.destroy();
            },
          );
        }
        const ms = Date.now() - started;
        if (ms > 1_000) console.log(`slow: ${request.method} ${host} ${answer.status} in ${ms} ms`);
      })
      .catch((error: unknown) => {
        console.log(`failed: ${request.method} ${host}: ${String(error).split("\n")[0]}`);
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
  },
);
const port = Number(process.env.EMULATORS_PORT ?? 443);
server.listen(port, "127.0.0.1", async () => {
  const services = await serviceList();
  writeFileSync(`${state}/services`, services);
  console.log(
    `Serving emulators.dev and ${services.split("\n").length - 1} service hosts on 127.0.0.1:${port}.`,
  );
});
