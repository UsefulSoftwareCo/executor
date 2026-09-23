import { organizationFixture, organizations } from "./browser.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/unstable/reactivity";
import { routeTree } from "../../self-host/web/src/implementation/routeTree.gen.ts";
import { organizationsAtom } from "../src/contracts/organization.ts";

async function settle(ready: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!ready() && Date.now() < deadline)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  assert.ok(ready(), "Expected organization URL to settle");
}

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

test("slug save moves this tab without stale-route flashes; collisions retain the current URL and editable draft", async () => {
  const alpha = organizations.find((organization) => organization.id === "org_alpha");
  assert.ok(alpha);
  const tab = await openTab("/org/alpha/organization");
  const beta = await openTab("/org/beta/apps");
  const field = () => {
    const input = tab.container.querySelector<HTMLInputElement>('[aria-label="Organization URL"]');
    assert.ok(input);
    return input;
  };
  const save = async (slug: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      assert.ok(setter);
      setter.call(field(), slug);
      field().dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      field()
        .closest("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
  };
  try {
    await settle(() => tab.container.querySelector('[aria-label="Organization URL"]') !== null);
    organizationFixture.pauseLists = true;
    await save("alpha-renamed");
    await settle(
      () =>
        organizationFixture.pendingLists > 0 &&
        tab.router.state.location.pathname === "/org/alpha-renamed/organization",
    );
    assert.equal(field().value, "alpha-renamed");
    assert.ok(tab.container.querySelector('[aria-label="Organization: Alpha"]'));
    assert.ok(!tab.container.textContent?.includes("Organization unavailable"));
    assert.equal(beta.router.state.location.pathname, "/org/beta/apps");
    await act(async () => organizationFixture.releaseLists());
    await save("beta");
    await settle(() => tab.container.querySelector('[role="alert"]') !== null);
    assert.match(tab.container.textContent ?? "", /URL is already in use/);
    assert.equal(field().value, "beta");
    assert.equal(tab.router.state.location.pathname, "/org/alpha-renamed/organization");
    assert.equal(alpha.slug, "alpha-renamed");
  } finally {
    organizationFixture.releaseLists();
    await tab.close();
    await beta.close();
    alpha.slug = "alpha";
  }
});

test("an open tab follows its organization ID after an external slug change, preserving nested page, search and hash", async () => {
  const alpha = organizations.find((organization) => organization.id === "org_alpha");
  const beta = organizations.find((organization) => organization.id === "org_beta");
  assert.ok(alpha && beta);
  const tab = await openTab("/org/alpha/accounts/acc_test?audit=keep#details");
  try {
    await settle(() => tab.container.querySelector('[aria-label="Organization: Alpha"]') !== null);
    alpha.slug = "moved-alpha";
    beta.slug = "alpha";
    await act(async () => tab.registry.refresh(organizationsAtom));
    await settle(() => tab.router.state.location.pathname === "/org/moved-alpha/accounts/acc_test");
    assert.equal(tab.router.state.location.searchStr, "?audit=keep");
    assert.equal(tab.router.state.location.hash, "details");
    assert.ok(tab.container.querySelector('[aria-label="Organization: Alpha"]'));
    assert.ok(!tab.container.querySelector('[aria-label="Organization: Beta"]'));
  } finally {
    await tab.close();
    alpha.slug = "alpha";
    beta.slug = "beta";
  }
});
