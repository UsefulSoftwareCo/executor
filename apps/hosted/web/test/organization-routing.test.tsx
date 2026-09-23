import { changeLibraryPreference, completedOAuthCallbacks, requests } from "./browser.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { RegistryContext } from "@effect/atom-react";
import { AsyncResult, AtomRegistry } from "effect/unstable/reactivity";
import { routeTree } from "../../self-host/web/src/implementation/routeTree.gen.ts";
import { sessionAtom } from "../src/contracts/auth.ts";
import { loginSearch } from "../src/implementation/pages/login.tsx";
import {
  clearSessionHint,
  rememberOrganization,
  writeSessionHint,
} from "../src/implementation/session-hint.ts";
import { OrganizationId } from "@executor-js/hosted-server/organization";

async function openTab(path: string) {
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createRouter({ routeTree, history });
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
    registry,
    container,
    async close() {
      await act(async () => root.unmount());
      registry.dispose();
      history.destroy();
      container.remove();
    },
  };
}
async function settle(ready: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!ready() && Date.now() < deadline)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  assert.ok(ready(), "Expected organization route and atoms to settle");
}

test("two tabs retain their URL organization through session refresh and organization switching", async () => {
  const alpha = await openTab("/org/alpha/apps");
  const beta = await openTab("/org/beta/apps");
  try {
    await settle(
      () =>
        alpha.container.querySelector('[aria-label="Organization: Alpha"]') !== null &&
        beta.container.querySelector('[aria-label="Organization: Beta"]') !== null,
    );
    assert.ok(requests.includes("/api/organizations/alpha/inventory"));
    assert.ok(requests.includes("/api/organizations/beta/inventory"));
    assert.ok(alpha.container.querySelector('nav a[href="/org/alpha/accounts"]'));
    assert.ok(beta.container.querySelector('nav a[href="/org/beta/accounts"]'));
    const session = alpha.registry.get(sessionAtom);
    assert.ok(AsyncResult.isSuccess(session));
    assert.deepEqual(session.value, {
      user: { id: "user_test", email: "example@example.test", name: "Example", image: null },
    });
    changeLibraryPreference("org_alpha");
    await act(async () => {
      alpha.registry.refresh(sessionAtom);
      beta.registry.refresh(sessionAtom);
    });
    await settle(
      () =>
        AsyncResult.isSuccess(alpha.registry.get(sessionAtom)) &&
        AsyncResult.isSuccess(beta.registry.get(sessionAtom)),
    );
    assert.equal(alpha.router.state.location.pathname, "/org/alpha/apps");
    assert.equal(beta.router.state.location.pathname, "/org/beta/apps");
    assert.ok(beta.container.querySelector('[aria-label="Organization: Beta"]'));
    // Exercise the actual sidebar switcher: it navigates, with no native set-active call.
    const trigger = alpha.container.querySelector('[aria-label="Organization: Alpha"]');
    assert.ok(trigger);
    await act(async () =>
      trigger.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false }),
      ),
    );
    await settle(
      () => document.querySelector('[role="menuitemradio"][data-state="unchecked"]') !== null,
    );
    const target = Array.from(document.querySelectorAll('[role="menuitemradio"]')).find((item) =>
      item.textContent?.includes("Beta"),
    );
    assert.ok(target);
    await act(async () => target.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await settle(() => alpha.router.state.location.pathname === "/org/beta/apps");
    assert.equal(beta.router.state.location.pathname, "/org/beta/apps");
    assert.ok(!requests.some((path) => path.includes("set-active")));
    await act(async () =>
      alpha.router.navigate({
        to: "/org/$organizationSlug/accounts",
        params: { organizationSlug: "alpha" },
      }),
    );
    await settle(
      () => alpha.container.querySelector('[aria-label="Organization: Alpha"]') !== null,
    );
    assert.equal(beta.router.state.location.pathname, "/org/beta/apps");
  } finally {
    await alpha.close();
    await beta.close();
    // Mounting an organization remembers it; later cases open the root as a chooser.
    clearSessionHint();
  }
});

test("unavailable handles never select another organization and root remains an explicit chooser", async () => {
  const unavailable = await openTab("/org/missing/apps");
  const chooser = await openTab("/");
  try {
    await settle(
      () => unavailable.container.textContent?.includes("Organization unavailable") === true,
    );
    assert.ok(
      unavailable.container.querySelector(".shell"),
      "The unavailable organization keeps navigation visible",
    );
    assert.equal(unavailable.router.state.location.pathname, "/org/missing/apps");
    await settle(() => chooser.container.querySelector('a[href="/org/alpha/apps"]') !== null);
    assert.ok(chooser.container.querySelector('a[href="/org/beta/apps"]'));
    assert.equal(chooser.router.state.location.pathname, "/");
  } finally {
    await unavailable.close();
    await chooser.close();
  }
});

test("login return destinations preserve organization paths and repeated signed MCP parameters", () => {
  const consent = "/mcp/authorize?ba_param=one&client_id=example&ba_param=two%2Bthree&state=a%20b";
  assert.equal(loginSearch({ redirect: consent }).redirect, consent);
  assert.equal(
    loginSearch({ redirect: "/org/alpha/apps/app_test?view=accounts" }).redirect,
    "/org/alpha/apps/app_test?view=accounts",
  );
  assert.equal(loginSearch({ redirect: "//external.test/" }).redirect, "/");
});

test("targetless account OAuth completes and returns to its own organization's account", async () => {
  sessionStorage.setItem(
    "executor:hosted:oauth",
    JSON.stringify({
      organization: "org_alpha",
      organizationSlug: "alpha",
      connection: "con_reconnect",
      app: null,
      redirectUri: "http://127.0.0.1:4411/api/oauth/callback",
    }),
  );
  window.history.replaceState(null, "", "/oauth/callback?code=synthetic&state=synthetic");
  const tab = await openTab("/oauth/callback");
  try {
    await settle(() => tab.router.state.location.pathname === "/org/alpha/accounts/acc_test");
    await settle(() => tab.container.textContent?.includes("Default") === true);
    assert.ok(
      requests.includes("/api/organizations/org_alpha/connections/con_reconnect/oauth/complete"),
    );
    assert.equal(
      completedOAuthCallbacks.at(-1),
      "http://127.0.0.1:4411/api/oauth/callback?code=synthetic&state=synthetic",
    );
    assert.equal(sessionStorage.getItem("executor:hosted:oauth"), null);
    assert.equal(window.location.search, "");
    assert.ok(tab.container.querySelector('a[href="/org/alpha/accounts/acc_test/disconnect"]'));
  } finally {
    await tab.close();
    window.history.replaceState(null, "", "/");
    clearSessionHint();
  }
});

test("restoring the last organization opens its canonical URL and loads apps once", async () => {
  writeSessionHint({
    user: { id: "user_test", name: "Example", email: "example@example.test", image: null },
  });
  rememberOrganization("user_test", OrganizationId.make("org_alpha"));
  const before = requests.length;
  const tab = await openTab("/");
  try {
    await settle(() => tab.container.querySelector('[aria-label="Organization: Alpha"]') !== null);
    assert.equal(tab.router.state.location.pathname, "/org/alpha/apps");
    assert.deepEqual(
      requests.slice(before).filter((path) => path.endsWith("/inventory")),
      ["/api/organizations/org_alpha/inventory"],
      "Restoring by stable ID keeps one inventory read when the URL becomes canonical",
    );
  } finally {
    await tab.close();
    clearSessionHint();
  }
});
