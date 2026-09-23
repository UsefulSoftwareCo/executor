import { organizationsAtom } from "../src/contracts/organization.ts";
import { requests } from "./browser.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AsyncResult, AtomRegistry } from "effect/unstable/reactivity";
import { writeSessionHint } from "../src/implementation/session-hint.ts";
import { sessionAtom, sessionInitialValues } from "../src/contracts/auth.ts";

test("the cookie hint renders synchronously while a live session check runs", async () => {
  writeSessionHint({
    user: { id: "user_test", name: "Example", email: "example@example.test", image: null },
  });
  const before = requests.filter((path) => path.includes("get-session")).length;
  const registry = AtomRegistry.make({ initialValues: sessionInitialValues() });
  const unmount = registry.mount(sessionAtom);
  const unmountOrganizations = registry.mount(organizationsAtom);
  try {
    const initial = registry.get(sessionAtom);
    assert.ok(AsyncResult.isSuccess(initial));
    assert.equal(initial.value?.user.id, "user_test");
    const loadedBy = Date.now() + 3000;
    while (!AsyncResult.isSuccess(registry.get(organizationsAtom)) && Date.now() < loadedBy)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(AsyncResult.isSuccess(registry.get(organizationsAtom)));
    const deadline = Date.now() + 3000;
    while (
      requests.filter((path) => path.includes("get-session")).length === before &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(requests.filter((path) => path.includes("get-session")).length > before);
  } finally {
    unmountOrganizations();
    unmount();
    registry.dispose();
    document.cookie = `executor-ui-${location.port}=; Max-Age=0; Path=/`;
  }
});
