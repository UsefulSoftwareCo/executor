import {
  organizationFixture,
  signOutFixture,
  onboardingFixture,
  organizations,
  requests,
} from "../../../web/test/browser.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/unstable/reactivity";
import { routeTree } from "../src/implementation/routeTree.gen.ts";
import { sessionAtom } from "@executor-js/hosted-web/contracts/auth";

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

test("the removed app route neither redirects nor provisions an organization", async () => {
  const before = requests.filter((path) => path === "/api/onboarding/prepare").length;
  const tab = await openTab("/app");
  try {
    await settle(
      () =>
        tab.router.state.location.pathname === "/app" &&
        tab.container.textContent?.includes("Page not found") === true,
    );
    assert.equal(requests.filter((path) => path === "/api/onboarding/prepare").length, before);
  } finally {
    await tab.close();
  }
});

test("first sign-in confirms editable team details before creating or navigating", async () => {
  const saved = organizations.splice(0);
  onboardingFixture.holdListsAfterCreate = true;
  const before = requests.filter((path) => path === "/api/onboarding/create").length;
  const tab = await openTab("/");
  try {
    await settle(() => tab.container.querySelector('input[name="name"]') !== null);
    const name = tab.container.querySelector<HTMLInputElement>('input[name="name"]');
    const form = tab.container.querySelector("form");
    assert.ok(name && form);
    assert.equal(name.value, "Example Company");
    assert.equal(tab.router.state.location.pathname, "/create");
    assert.equal(organizations.length, 0);
    assert.equal(requests.filter((path) => path === "/api/onboarding/create").length, before);
    assert.equal(tab.container.querySelector('input[name="slug"]'), null);
    name.value = "Chosen Team";
    assert.equal(tab.container.querySelector('input[type="url"]'), null);
    const remove = tab.container.querySelector<HTMLButtonElement>('[aria-label="Remove icon"]');
    assert.ok(remove);
    await act(async () => remove.click());
    await act(async () =>
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    await settle(() => tab.router.state.location.pathname === "/org/confirmed-team/apps");
    assert.equal(organizations.length, 1);
    assert.equal(organizations[0]?.name, "Chosen Team");
    assert.equal(organizations[0]?.logo, null);
    assert.ok(!tab.container.textContent?.includes("Organization unavailable"));
    await act(async () => organizationFixture.releaseLists());
    await settle(
      () => tab.container.querySelector('[aria-label="Organization: Chosen Team"]') !== null,
    );
    assert.equal(requests.filter((path) => path === "/api/onboarding/create").length, before + 1);
    assert.ok(!requests.some((path) => path === "/api/onboarding/enrich"));
  } finally {
    onboardingFixture.holdListsAfterCreate = false;
    organizationFixture.releaseLists();
    await tab.close();
    organizations.splice(0, organizations.length, ...saved);
  }
});

test("the icon picker previews a valid file and sends its bytes only on confirmation", async () => {
  const saved = organizations.splice(0);
  const tab = await openTab("/");
  try {
    await settle(() => tab.container.querySelector('input[type="file"]') !== null);
    const picker = tab.container.querySelector<HTMLInputElement>('input[type="file"]');
    const name = tab.container.querySelector<HTMLInputElement>('input[name="name"]');
    assert.ok(picker && name);
    assert.equal(picker.accept, "image/png,image/jpeg,image/webp");
    assert.equal(tab.container.querySelector('input[type="url"]'), null);
    const choose = async (file: File) => {
      const files = new DataTransfer();
      files.items.add(file);
      await act(async () => {
        picker.files = files.files;
        picker.dispatchEvent(new Event("change", { bubbles: true }));
      });
    };
    name.value = "Image team";
    await choose(new File(["<svg/>"], "icon.svg", { type: "image/svg+xml" }));
    await settle(
      () => tab.container.textContent?.includes("Choose a PNG, JPEG, or WebP image") === true,
    );
    assert.equal(name.value, "Image team");
    assert.equal(onboardingFixture.uploadedIcon, null);
    const png = Uint8Array.from(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    await choose(new File([png], "team.png", { type: "image/png" }));
    await settle(() => tab.container.textContent?.includes("Icon selected") === true);
    assert.equal(onboardingFixture.uploadedIcon, null, "Selecting is a local preview only");
    assert.equal(organizations.length, 0);
    const form = tab.container.querySelector("form");
    assert.ok(form);
    await act(async () =>
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    await settle(() => tab.router.state.location.pathname === "/org/confirmed-team/apps");
    assert.deepEqual(onboardingFixture.uploadedIcon, png);
    assert.equal(organizations[0]?.logo, "https://example.test/uploaded-team-icon.png");
    assert.equal(organizations[0]?.name, "Image team");
  } finally {
    onboardingFixture.uploadedIcon = null;
    await tab.close();
    organizations.splice(0, organizations.length, ...saved);
  }
});

test("preparation retries and failed confirmation preserve the entered team name", async () => {
  const saved = organizations.splice(0);
  onboardingFixture.failPrepare = true;
  onboardingFixture.name = "Rhys";
  const tab = await openTab("/");
  try {
    await settle(
      () => tab.container.textContent?.includes("Unable to open your workspace") === true,
    );
    onboardingFixture.failPrepare = false;
    const retry = Array.from(tab.container.querySelectorAll("button")).find(
      (button) => button.textContent === "Try again",
    );
    assert.ok(retry);
    await act(async () => retry.click());
    await settle(() => tab.container.querySelector('input[name="name"]') !== null);
    const name = tab.container.querySelector<HTMLInputElement>('input[name="name"]');
    const form = tab.container.querySelector("form");
    assert.ok(name && form);
    assert.equal(name.value, "Rhys");
    name.value = "My chosen team";
    onboardingFixture.failCreate = true;
    await act(async () =>
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    await settle(() => tab.container.textContent?.includes("Unable to create your team") === true);
    assert.equal(name.value, "My chosen team");
    assert.equal(organizations.length, 0);
    assert.equal(tab.router.state.location.pathname, "/create");
    onboardingFixture.failCreate = false;
    await act(async () =>
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    await settle(() => tab.router.state.location.pathname === "/org/confirmed-team/apps");
    assert.equal(organizations[0]?.name, "My chosen team");
  } finally {
    onboardingFixture.failPrepare = false;
    onboardingFixture.failCreate = false;
    onboardingFixture.name = "Example Company";
    await tab.close();
    organizations.splice(0, organizations.length, ...saved);
  }
});

test("pending invitations take priority and explicit invitation URLs bypass automatic creation", async () => {
  const saved = organizations.splice(0);
  onboardingFixture.invitation = "invitation_gamma";
  const tab = await openTab("/");
  try {
    await settle(() => tab.router.state.location.pathname === "/invite");
    assert.equal(tab.router.state.location.search.invitation, "invitation_gamma");
    assert.equal(organizations.length, 0);
  } finally {
    await tab.close();
  }
  const before = requests.filter((path) => path === "/api/onboarding/prepare").length;
  const invite = await openTab("/invite?invitation=invitation_gamma");
  try {
    await settle(() => invite.container.textContent?.includes("Accept invitation") === true);
    assert.equal(requests.filter((path) => path === "/api/onboarding/prepare").length, before);
  } finally {
    await invite.close();
    onboardingFixture.invitation = null;
    organizations.splice(0, organizations.length, ...saved);
  }
});

test("team setup can sign out without creating a team and retains the draft on failure", async () => {
  const saved = organizations.splice(0);
  const original = window.location.href;
  window.history.replaceState(null, "", "/?setup=1");
  const before = requests.filter((path) => path === "/api/onboarding/create").length;
  const tab = await openTab("/");
  try {
    await settle(() => tab.container.querySelector('input[name="name"]') !== null);
    const name = tab.container.querySelector<HTMLInputElement>('input[name="name"]');
    const signOut = tab.container.querySelector<HTMLButtonElement>('button[aria-label="Sign out"]');
    assert.ok(name && signOut);
    assert.equal(signOut.textContent, "Sign out");
    name.value = "My draft team";
    signOutFixture.fails = true;
    await act(async () => signOut.click());
    await settle(() => tab.container.querySelector('[role="alert"]') !== null);
    assert.equal(name.value, "My draft team");
    assert.equal(signOutFixture.signedOut, false);
    signOutFixture.fails = false;
    await act(async () => signOut.click());
    // The signed-out response precedes this tab's own destination change.
    await settle(
      () =>
        signOutFixture.signedOut &&
        window.location.pathname === "/" &&
        window.location.search === "",
    );
    assert.equal(window.location.search, "");
    assert.equal(organizations.length, 0);
    assert.equal(requests.filter((path) => path === "/api/onboarding/create").length, before);
  } finally {
    await tab.close();
    signOutFixture.fails = false;
    signOutFixture.signedOut = false;
    window.history.replaceState(null, "", original);
    organizations.splice(0, organizations.length, ...saved);
  }
});

test("MCP entry rechecks an invitation received during confirmation without changing the return URL", async () => {
  const saved = organizations.splice(0);
  const tab = await openTab("/mcp/authorize?state=keep-me");
  try {
    await settle(() => tab.container.querySelector('input[name="name"]') !== null);
    onboardingFixture.invitation = "invitation_gamma";
    const form = tab.container.querySelector("form");
    assert.ok(form);
    await act(async () =>
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    await settle(
      () =>
        tab.container.textContent?.includes("Accept your invitation, then return here") === true,
    );
    assert.equal(organizations.length, 0);
    onboardingFixture.invitation = null;
    organizations.push({ id: "org_gamma", slug: "gamma", name: "Gamma" });
    const resume = Array.from(tab.container.querySelectorAll("button")).find(
      (button) => button.textContent === "Continue",
    );
    assert.ok(resume);
    await act(async () => resume.click());
    await settle(() => tab.container.textContent?.includes("Connect to Executor") === true);
    assert.equal(tab.router.state.location.pathname, "/mcp/authorize");
    assert.equal(tab.router.state.location.searchStr, "?state=keep-me");
  } finally {
    onboardingFixture.invitation = null;
    await tab.close();
    organizations.splice(0, organizations.length, ...saved);
  }
});

test("creation and invitation acceptance navigate only their own tab to the exact organization", async () => {
  const beta = await openTab("/org/beta/apps");
  const creator = await openTab("/");
  let invite: Awaited<ReturnType<typeof openTab>> | undefined;
  try {
    await settle(() => creator.container.querySelector('input[name="slug"]') !== null);
    const name = creator.container.querySelector<HTMLInputElement>('input[name="name"]');
    const slug = creator.container.querySelector<HTMLInputElement>('input[name="slug"]');
    const form = creator.container.querySelector("form");
    assert.ok(name && slug && form);
    name.value = "Delta";
    slug.value = "delta";
    organizationFixture.pauseLists = true;
    await act(async () =>
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    await settle(() => creator.router.state.location.pathname === "/org/delta/apps");
    await settle(() => organizationFixture.pendingLists > 0);
    assert.ok(!creator.container.textContent?.includes("Organization unavailable"));
    await act(async () => organizationFixture.releaseLists());
    await settle(
      () => creator.container.querySelector('[aria-label="Organization: Delta"]') !== null,
    );
    assert.equal(beta.router.state.location.pathname, "/org/beta/apps");
    invite = await openTab("/invite?invitation=invitation_gamma");
    await settle(() => invite?.container.textContent?.includes("Accept invitation") === true);
    const accept = Array.from(invite.container.querySelectorAll("button")).find(
      (button) => button.textContent === "Accept invitation",
    );
    assert.ok(accept);
    organizationFixture.pauseLists = true;
    await act(async () => accept.click());
    await settle(() => organizationFixture.pendingLists > 0);
    assert.ok(!invite.container.textContent?.includes("Unable to open this organization"));
    await act(async () => organizationFixture.releaseLists());
    await settle(() => invite?.router.state.location.pathname === "/org/gamma/apps");
    await act(async () => beta.registry.refresh(sessionAtom));
    await settle(() => beta.container.querySelector('[aria-label="Organization: Beta"]') !== null);
    assert.equal(beta.router.state.location.pathname, "/org/beta/apps");
    assert.equal(creator.router.state.location.pathname, "/org/delta/apps");
  } finally {
    organizationFixture.releaseLists();
    await beta.close();
    await creator.close();
    await invite?.close();
  }
});
