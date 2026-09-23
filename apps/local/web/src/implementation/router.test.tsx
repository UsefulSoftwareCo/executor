import { resetBrowser, requests } from "./testing/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserHistory, createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { RegistryContext } from "@effect/atom-react";
import { Effect, Redacted, Schema } from "effect";
import { AtomRegistry } from "effect/unstable/reactivity";
import { ConnectionGrant } from "@executor-js/local-server/account-connections";
import { AppId, AccountId, AccountConnectionId } from "@executor-js/sdk";
import { getRouter } from "./router.ts";
import { readPairingToken } from "./connection.ts";
import { oauthDestination, readOAuthCallback } from "./oauth.ts";
import { readAccountConnection } from "./account-connections.ts";

const appId = Schema.decodeUnknownSync(AppId)("app_test");
const accountId = Schema.decodeUnknownSync(AccountId)("acc_test");

async function renderRoute(path: string, state: "paired" | "pending" | "signed-out" = "paired") {
  resetBrowser(path, state);
  const history = createBrowserHistory();
  const router = getRouter(history);
  const registry = AtomRegistry.make();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    await router.load();
    root.render(
      <RegistryContext value={registry}>
        <RouterProvider router={router} />
      </RegistryContext>,
    );
  });
  return {
    router,
    history,
    registry,
    container,
    requests,
    async close() {
      await act(async () => root.unmount());
      registry.dispose();
      history.destroy();
      container.remove();
    },
  };
}

async function settle(ready: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!ready() && Date.now() < deadline) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  assert.ok(ready(), "Expected the route and its Effect Atom reads to settle");
}

test("existing deep links match generated routes and parse string query values", async () => {
  const routes = [
    ["/", "/_dashboard/_inventory/"],
    ["/apps", "/_dashboard/_inventory/apps/"],
    ["/apps/add", "/_dashboard/_inventory/apps/add"],
    ["/apps/add/custom", "/_dashboard/_inventory/apps/add_/custom"],
    ["/accounts", "/_dashboard/_inventory/accounts/"],
    ["/accounts/add", "/_dashboard/_inventory/accounts/add"],
    ["/connect", "/_dashboard/connect"],
    ["/api/oauth/callback", "/_dashboard/_inventory/api/oauth/callback"],
    [`/apps/${appId}`, "/_dashboard/_inventory/apps/$appId"],
    [`/apps/${appId}/setup`, "/_dashboard/_inventory/apps/$appId_/setup"],
    [`/apps/${appId}/delete`, "/_dashboard/_inventory/apps/$appId_/delete"],
    ["/app-auth?request=" + "ab".repeat(32), "/app-auth"],
    [`/accounts/${accountId}`, "/_dashboard/_inventory/accounts/$accountId"],
    [
      `/accounts/${accountId}/credentials`,
      "/_dashboard/_inventory/accounts/$accountId_/credentials",
    ],
    [`/accounts/${accountId}/disconnect`, "/_dashboard/_inventory/accounts/$accountId_/disconnect"],
    ["/account-connect/con_test", "/account-connect/$connectionId"],
  ] as const;
  for (const [path, routeId] of routes) {
    const history = createMemoryHistory({ initialEntries: [path] });
    try {
      const router = getRouter(history);
      await router.load();
      const match = router.state.matches.at(-1);
      assert.equal(match?.routeId, routeId, path);
      assert.equal(match?.status, "success", path);
    } finally {
      history.destroy();
    }
  }
  const history = createMemoryHistory({ initialEntries: [`/apps/${appId}?view=source&tool=123`] });
  try {
    const router = getRouter(history);
    await router.load();
    assert.deepEqual(router.state.matches.at(-1)?.search, { view: "source", tool: "123" });
    await router.navigate({
      to: "/apps/$appId/setup",
      params: { appId },
      search: { selected: accountId, slot: "mail & calendar" },
    });
    assert.equal(
      router.state.location.href,
      `/apps/${appId}/setup?selected=${accountId}&slot=mail+%26+calendar`,
    );
    assert.deepEqual(router.state.matches.at(-1)?.search, {
      selected: accountId,
      slot: "mail & calendar",
    });
    const invalid = getRouter(
      createMemoryHistory({ initialEntries: [`/apps/${appId}?view=unknown&tool=&tool=valid`] }),
    );
    await invalid.load();
    assert.deepEqual(invalid.state.matches.at(-1)?.search, { view: undefined, tool: undefined });
    invalid.history.destroy();

    await router.navigate({ to: "/accounts/add", search: { app: appId, slot: "false" } });
    assert.deepEqual(router.state.matches.at(-1)?.search, {
      provider: undefined,
      app: appId,
      slot: "false",
    });
  } finally {
    history.destroy();
  }
});

test("pairing and session gates precede inventory pages, while standalone connections bypass them", async () => {
  for (const [state, title] of [
    ["pending", "Connecting to Executor"],
    ["signed-out", "Open Executor locally"],
  ] as const) {
    const screen = await renderRoute("/apps", state);
    try {
      await settle(() => screen.container.querySelector("h1")?.textContent === title);
      assert.equal(screen.container.querySelector("h1")?.textContent, title);
      assert.ok(!screen.requests.includes("/dashboard/api/live/overview"));
      assert.equal(screen.container.querySelector(".shell"), null);
    } finally {
      await screen.close();
    }
  }
  const standalone = await renderRoute("/account-connect/con_test", "pending");
  try {
    assert.equal(
      standalone.container.querySelector("h1")?.textContent,
      "Open a new connection link",
    );
    assert.equal(standalone.container.querySelector(".shell"), null);
    assert.deepEqual(standalone.requests, []);
  } finally {
    await standalone.close();
  }
});

test("app sign-in waits for pairing, resumes on the same page, and never loads dashboard inventory", async () => {
  const screen = await renderRoute(`/app-auth?request=${"ab".repeat(32)}`, "signed-out");
  try {
    await settle(
      () => screen.container.querySelector("h1")?.textContent === "Open Executor locally",
    );
    assert.ok(!screen.requests.includes("/auth/apps/authorize"));
    await act(async () => {
      window.location.hash = `pair=${"cd".repeat(32)}`;
    });
    await settle(() => window.location.pathname === "/app-returned");
    assert.ok(screen.requests.includes("/auth/apps/authorize"));
    assert.ok(!screen.requests.includes("/dashboard/api/live/overview"));
    assert.equal(screen.container.querySelector(".shell"), null);
  } finally {
    await screen.close();
  }
});

test("ordinary clicks use router history; modified clicks retain native anchor behavior", async () => {
  const screen = await renderRoute("/apps");
  try {
    await settle(() => screen.container.querySelector("h1")?.textContent === "Apps 0");
    const accounts = screen.container.querySelector('nav a[href="/accounts"]');
    assert.ok(accounts);
    for (const modifiers of [{ ctrlKey: true }, { metaKey: true }]) {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...modifiers });
      // Cancel only after React's handler to prevent the test browser opening a window.
      let routerPrevented = false;
      const observe = (received: Event) => {
        routerPrevented = received.defaultPrevented;
        received.preventDefault();
      };
      document.addEventListener("click", observe, { once: true });
      await act(async () => {
        accounts.dispatchEvent(event);
      });
      assert.equal(routerPrevented, false);
      assert.equal(screen.router.state.location.pathname, "/apps");
    }
    await act(async () => {
      accounts.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await settle(() => screen.router.state.location.pathname === "/accounts");
    assert.equal(screen.router.state.location.pathname, "/accounts");
    assert.match(screen.container.querySelector("h1")?.textContent ?? "", /Accounts/);
    await act(async () => {
      screen.history.back();
    });
    await settle(() => screen.router.state.location.pathname === "/apps");
    assert.equal(screen.router.state.location.pathname, "/apps");
    await act(async () => {
      screen.history.forward();
    });
    await settle(() => screen.router.state.location.pathname === "/accounts");
    assert.equal(screen.router.state.location.pathname, "/accounts");
    assert.equal(screen.requests.filter((url) => url === "/dashboard/api/live/overview").length, 1);
  } finally {
    await screen.close();
  }
});

test("a pairing link reaches an existing tab without losing its route or history state", async () => {
  const screen = await renderRoute("/accounts", "signed-out");
  try {
    await settle(
      () => screen.container.querySelector("h1")?.textContent === "Open Executor locally",
    );
    const state = window.history.state;
    await act(async () => {
      window.location.hash = `pair=${"ab".repeat(32)}`;
    });
    await settle(() => screen.container.querySelector("h1")?.textContent === "Accounts 0");
    assert.equal(screen.requests.filter((url) => url === "/auth/exchange").length, 1);
    assert.equal(window.location.hash, "");
    assert.equal(screen.router.state.location.pathname, "/accounts");
    assert.ok(window.history.state.__TSR_index >= state.__TSR_index);
  } finally {
    await screen.close();
  }
});

test("malformed identities show the missing page without mounting resource reads", async () => {
  const screen = await renderRoute("/apps/not-an-app");
  try {
    await settle(() => screen.container.textContent?.includes("Page not found") === true);
    assert.ok(!screen.requests.some((url) => url.includes("not-an-app")));
  } finally {
    await screen.close();
  }
});

test("entry credentials are erased before browser history captures pairing or OAuth URLs", async () => {
  sessionStorage.clear();
  const pairing = "ab".repeat(32);
  window.history.replaceState(null, "", `/apps?view=tools#pair=${pairing}`);
  const token = Effect.runSync(readPairingToken);
  assert.ok(token);
  assert.equal(Redacted.value(token), pairing);
  const history = createBrowserHistory();
  try {
    const router = getRouter(history);
    await router.load();
    assert.equal(router.state.location.href, "/apps?view=tools");
    const state = window.history.state;
    window.history.replaceState(state, "", `/apps#pair=${pairing}`);
    Effect.runSync(readPairingToken);
    assert.deepEqual(window.history.state, state);
    assert.equal(history.location.hash, "");
  } finally {
    history.destroy();
  }
  window.history.replaceState(null, "", "/api/oauth/callback?code=synthetic&state=synthetic");
  const callback = Effect.runSync(readOAuthCallback);
  assert.ok(callback);
  assert.match(Redacted.value(callback), /code=synthetic/);
  assert.equal(window.location.pathname + window.location.search, "/api/oauth/callback");
  window.history.replaceState(null, "", "/account-connect/con_test#token=synthetic-grant");
  const entry = Effect.runSync(readAccountConnection);
  assert.ok(entry);
  assert.equal(entry.connection, "con_test");
  assert.equal(window.location.hash, "");
  // Restoring the same handoff after refresh retains only its scoped grant.
  assert.equal(Effect.runSync(readAccountConnection)?.connection, entry.connection);
  const connection = Schema.decodeUnknownSync(AccountConnectionId)("con_test");
  const grant = { connection, token: Redacted.make("synthetic-grant") };
  sessionStorage.setItem(
    "executor.account-connect.oauth.synthetic",
    Schema.encodeSync(Schema.fromJsonString(ConnectionGrant))(grant),
  );
  window.history.replaceState(null, "", "/api/oauth/callback?code=synthetic&state=synthetic");
  const connectionCallback = Effect.runSync(readAccountConnection);
  assert.equal(connectionCallback?.connection, connection);
  assert.ok(connectionCallback?.callbackUrl);
  assert.equal(window.location.pathname, "/account-connect/con_test");
  assert.equal(window.location.search, "");
  assert.equal(Effect.runSync(readOAuthCallback), undefined);
  sessionStorage.setItem(
    "executor.oauth.return",
    JSON.stringify({ connection, app: appId, slot: "mail & calendar" }),
  );
  assert.deepEqual(Effect.runSync(oauthDestination(accountId)), {
    to: "/apps/$appId/setup",
    params: { appId },
    search: { selected: accountId, slot: "mail & calendar" },
  });
  assert.equal(sessionStorage.getItem("executor.oauth.return"), null);
  sessionStorage.clear();
});
