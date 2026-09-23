import { requests, signOutFixture } from "../../../web/test/browser.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/unstable/reactivity";
import { SessionMenu } from "@executor-js/hosted-web/auth";

test("sign-out navigates to the public root only after success, with no return URL", async () => {
  const registry = AtomRegistry.make();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const original = window.location.href;
  window.history.replaceState(null, "", "/org/alpha/apps?view=accounts#selection");
  const privateUrl = window.location.href;
  const settle = async (ready: () => boolean) => {
    const deadline = Date.now() + 3000;
    while (!ready() && Date.now() < deadline)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    assert.ok(ready());
  };
  try {
    await act(async () =>
      root.render(
        <RegistryContext value={registry}>
          <SessionMenu />
        </RegistryContext>,
      ),
    );
    await settle(() => container.querySelector('button[aria-label="Sign out"]') !== null);
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Sign out"]');
    assert.ok(button);
    signOutFixture.fails = true;
    await act(async () => button.click());
    await settle(() => container.querySelector('[role="alert"]') !== null);
    assert.equal(window.location.href, privateUrl);
    assert.equal(signOutFixture.signedOut, false);

    signOutFixture.fails = false;
    const sessionReads = requests.filter((path) => path === "/api/auth/get-session").length;
    await act(async () => button.click());
    await settle(() => signOutFixture.signedOut && window.location.pathname === "/");
    assert.equal(window.location.search, "");
    assert.equal(window.location.hash, "");
    assert.equal(
      requests.filter((path) => path === "/api/auth/get-session").length,
      sessionReads,
      "The private route must not refresh its session and race a login redirect",
    );
  } finally {
    await act(async () => root.unmount());
    registry.dispose();
    container.remove();
    signOutFixture.fails = false;
    signOutFixture.signedOut = false;
    window.history.replaceState(null, "", original);
  }
});
