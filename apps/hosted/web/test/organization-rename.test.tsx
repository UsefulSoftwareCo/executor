import { organizationFixture, organizations } from "./browser.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { RegistryContext } from "@effect/atom-react";
import { AsyncResult, AtomRegistry } from "effect/unstable/reactivity";
import { routeTree } from "../../self-host/web/src/implementation/routeTree.gen.ts";
import { organizationsAtom } from "../src/contracts/organization.ts";

async function settle(ready: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!ready() && Date.now() < deadline)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  assert.ok(ready(), "Expected organization form to settle");
}

test("organization rename stays visible while refetch is held, then follows later server changes; failed saves roll back", async () => {
  const alpha = organizations.find((organization) => organization.id === "org_alpha");
  assert.ok(alpha);
  alpha.name = "Alpha";
  const history = createMemoryHistory({ initialEntries: ["/org/alpha/organization"] });
  const router = createRouter({ routeTree, history });
  const registry = AtomRegistry.make();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const input = () => {
    const field = container.querySelector<HTMLInputElement>('[aria-label="Organization name"]');
    assert.ok(field);
    return field;
  };
  const heading = () => container.querySelector("h1")?.textContent;
  const edit = async (name: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      assert.ok(setter);
      setter.call(input(), name);
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const displayedName = () => input().value;
  const submit = async () =>
    act(async () => {
      const form = input().closest("form");
      assert.ok(form);
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  try {
    await act(async () => {
      await router.load();
      root.render(
        <RegistryContext value={registry}>
          <RouterProvider router={router} />
        </RegistryContext>,
      );
    });
    await settle(() => heading() === "Alpha");
    await edit("Renamed");
    organizationFixture.pauseLists = true;
    await submit();
    await settle(
      () =>
        organizationFixture.pendingLists > 0 &&
        container.querySelector('[role="status"]')?.textContent === "Saved",
    );
    assert.equal(
      displayedName(),
      "Renamed",
      "saving must not hand the input back to stale query data",
    );
    assert.equal(heading(), "Renamed");
    assert.ok(container.querySelector('[aria-label="Organization: Renamed"]'));
    await act(async () => organizationFixture.releaseLists());
    await settle(() => {
      const result = registry.get(organizationsAtom);
      return AsyncResult.isSuccess(result) && !result.waiting;
    });
    assert.equal(displayedName(), "Renamed");
    assert.equal(heading(), "Renamed");

    // A later server change must replace the acknowledged name, not remain hidden by a form override.
    alpha.name = "Changed elsewhere";
    await act(async () => registry.refresh(organizationsAtom));
    await settle(() => heading() === "Changed elsewhere");
    assert.equal(displayedName(), "Changed elsewhere");

    organizationFixture.rejectRename = true;
    await edit("Rejected");
    await submit();
    await settle(() => container.querySelector('[role="alert"]') !== null);
    assert.equal(heading(), "Changed elsewhere");
    assert.equal(input().value, "Rejected", "keep the rejected draft editable");
    assert.equal(alpha.name, "Changed elsewhere");
  } finally {
    organizationFixture.releaseLists();
    organizationFixture.rejectRename = false;
    await act(async () => root.unmount());
    registry.dispose();
    history.destroy();
    container.remove();
    alpha.name = "Alpha";
  }
});
