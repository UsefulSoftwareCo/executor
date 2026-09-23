import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createServer } from "node:http";
import { after } from "node:test";
import assert from "node:assert/strict";

/** Requests made by the real Effect Atom clients to the private test server. */
export const requests: string[] = [];
let session: "paired" | "pending" | "signed-out" = "paired";
const server = createServer((request, response) => {
  const url = request.url ?? "/";
  requests.push(url);
  if (url === "/auth/session") {
    if (session === "pending") return;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ authenticated: session === "paired" }));
  } else if (url === "/auth/exchange" && request.method === "POST") {
    session = "paired";
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ authenticated: true }));
  } else if (url === "/auth/apps/authorize" && request.method === "POST") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ url: `${origin}/app-returned` }));
  } else if (url === "/dashboard/api/live/overview") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({ type: "snapshot", revision: 0, value: { apps: [], accounts: [] } })}\n\n`,
    );
  } else {
    response.writeHead(404);
    response.end();
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
const origin = `http://127.0.0.1:${address.port}`;
const nativeFetch = globalThis.fetch;
// Install the test browser before importing React or TanStack's environment checks.
GlobalRegistrator.register({ url: `${origin}/apps` });
// Keep Node's transport while the DOM supplies the browser location and events.
Object.defineProperty(globalThis, "fetch", { value: nativeFetch, configurable: true });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
after(async () => {
  await GlobalRegistrator.unregister();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
});

/** Reset the route and synthetic server state after the preceding registry is disposed. */
export function resetBrowser(path: string, state: typeof session) {
  window.history.replaceState(null, "", path);
  sessionStorage.clear();
  requests.length = 0;
  session = state;
}
