import { passkeyFixture, requests } from "../../../web/test/browser.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/unstable/reactivity";
import { AuthBoundary } from "@executor-js/hosted-web/auth";
import { PasskeyEnrollment } from "../src/implementation/components/passkey-enrollment.tsx";
import { passkeyEnrollmentCookie } from "../../src/contracts/passkey-enrollment.ts";

const rootRoute = createRootRoute({
  component: () => (
    <AuthBoundary>
      <Outlet />
    </AuthBoundary>
  ),
});
const routeTree = rootRoute.addChildren([
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/login",
    component: () => (
      <PasskeyEnrollment userId="user_test">
        <p>Original destination</p>
      </PasskeyEnrollment>
    ),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "$",
    component: () => <p>Original destination</p>,
  }),
]);
const pending = (user = "user_test") => {
  document.cookie = `${passkeyEnrollmentCookie.name}=${user}; Path=/`;
};
const clear = () => {
  document.cookie = `${passkeyEnrollmentCookie.name}=; Path=/; Max-Age=0`;
};
let ceremonies = 0;
Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
Object.defineProperty(window, "PublicKeyCredential", { configurable: true, value: class {} });
Object.defineProperty(navigator, "credentials", {
  configurable: true,
  value: {
    create: async () => {
      ceremonies += 1;
      throw new DOMException("User canceled the browser prompt", "NotAllowedError");
    },
  },
});

async function open(path: string) {
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
    container,
    history,
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
  assert.ok(ready(), "Expected the enrollment view and auth request to settle");
}
function button(container: HTMLElement, text: string) {
  const result = Array.from(container.querySelectorAll("button")).find(
    (value) => value.textContent === text,
  );
  assert.ok(result, `Expected ${text} button`);
  return result;
}

test("first-sign-in enrollment preserves exact destinations, requires a click, and stays dismissed after reload", async () => {
  for (const destination of [
    "/mcp/authorize?ba_param=one&client_id=example&ba_param=two%2Bthree&state=a%20b",
    "/org/alpha/apps/app_test?view=accounts#selection",
    "/invite?invitation=example%2Binvitation",
  ]) {
    pending();
    const login = `/login?redirect=${encodeURIComponent(destination)}`;
    const page = await open(login);
    try {
      await settle(() => page.container.querySelector("h1")?.textContent === "Create a passkey");
      assert.equal(ceremonies, 0, "Mounting the offer must not open a browser prompt");
      assert.equal(page.history.location.href, login);
      await act(async () => button(page.container, "Not now").click());
      await settle(() => page.container.textContent === "Original destination");
      assert.equal(page.history.location.href, login);
      assert.ok(
        !document.cookie.includes(passkeyEnrollmentCookie.name),
        `Remaining enrollment cookie: ${document.cookie}`,
      );
    } finally {
      await page.close();
    }
    const reloaded = await open(destination);
    try {
      await settle(() => reloaded.container.textContent === "Original destination");
    } finally {
      await reloaded.close();
    }
  }
});

test("existing passkeys, a different user, and unsupported browsers bypass the offer", async () => {
  pending();
  passkeyFixture.enrolled = true;
  const existing = await open("/login");
  try {
    await settle(() => existing.container.textContent === "Original destination");
    assert.ok(
      !document.cookie.includes(passkeyEnrollmentCookie.name),
      `Remaining enrollment cookie: ${document.cookie}`,
    );
  } finally {
    await existing.close();
    passkeyFixture.enrolled = false;
  }
  pending("another_user");
  const count = requests.filter((path) => path.includes("list-user-passkeys")).length;
  const other = await open("/login");
  try {
    await settle(() => other.container.textContent === "Original destination");
    assert.equal(requests.filter((path) => path.includes("list-user-passkeys")).length, count);
  } finally {
    await other.close();
  }
  pending();
  Object.defineProperty(window, "PublicKeyCredential", { configurable: true, value: undefined });
  const unsupported = await open("/login");
  try {
    await settle(() => unsupported.container.textContent === "Original destination");
  } finally {
    await unsupported.close();
    Object.defineProperty(window, "PublicKeyCredential", { configurable: true, value: class {} });
    clear();
  }
});

test("canceling registration or failing to list passkeys leaves a working skip action", async () => {
  pending();
  const page = await open("/login?redirect=%2Fmcp%2Fauthorize%3Fstate%3Dexact%252Bstate");
  try {
    await settle(() => page.container.querySelector("h1")?.textContent === "Create a passkey");
    await act(async () => button(page.container, "Create a passkey").click());
    await settle(() => page.container.querySelector('[role="alert"]') !== null);
    assert.equal(ceremonies, 1);
    await act(async () => button(page.container, "Not now").click());
    await settle(() => page.container.textContent === "Original destination");
    assert.equal(
      page.history.location.href,
      "/login?redirect=%2Fmcp%2Fauthorize%3Fstate%3Dexact%252Bstate",
    );
  } finally {
    await page.close();
  }
  pending();
  passkeyFixture.unavailable = true;
  const unavailable = await open("/login");
  try {
    await settle(() => unavailable.container.querySelector('[role="alert"]') !== null);
    assert.equal(button(unavailable.container, "Create a passkey").disabled, true);
    await act(async () => button(unavailable.container, "Not now").click());
    await settle(() => unavailable.container.textContent === "Original destination");
  } finally {
    await unavailable.close();
    passkeyFixture.unavailable = false;
    clear();
  }
});

test("dashboard navigation does not read passkeys even when enrollment is pending", async () => {
  pending();
  const before = requests.filter((path) => path.includes("passkey")).length;
  const page = await open("/org/alpha/apps");
  try {
    await settle(() => page.container.textContent === "Original destination");
    assert.equal(requests.filter((path) => path.includes("passkey")).length, before);
  } finally {
    await page.close();
    clear();
  }
});
