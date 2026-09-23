import "./browser.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  DocumentTitleProvider,
  productTitle,
  useDocumentTitle,
} from "@executor-js/ui/hooks/document-title";
import { LoginLegalFooter } from "../src/implementation/pages/login.tsx";
import { hostedPageTitle } from "../src/contracts/navigation.ts";

function Page({ name }: { readonly name: string }) {
  useDocumentTitle(productTitle(name));
  return <h1>{name}</h1>;
}

test("one title owner handles loaded names, renames, same-name navigation and fallback pages", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (fallback: string, name?: string) =>
    act(async () =>
      root.render(
        <DocumentTitleProvider fallbackTitle={productTitle(fallback)}>
          {name === undefined ? <p>List</p> : <Page name={name} />}
        </DocumentTitleProvider>,
      ),
    );
  try {
    await render("App", "Vercel");
    assert.equal(document.title, "Vercel · Executor");
    await render("App", "Work Vercel");
    assert.equal(document.title, "Work Vercel · Executor");
    await render("Accounts");
    assert.equal(document.title, "Accounts · Executor");
    await render("App", "Vercel");
    assert.equal(document.title, "Vercel · Executor");
    await render("Another organization", "Vercel");
    assert.equal(document.title, "Vercel · Executor");
    await render("Settings");
    assert.equal(document.title, "Settings · Executor");
    assert.equal(hostedPageTitle("/org/accounts/connect"), "Connect");
    assert.equal(hostedPageTitle("/org/organization-name/apps/app_hidden"), "App");
    assert.equal(hostedPageTitle("/org/organization-name/apps/add"), "Add app");
    assert.equal(hostedPageTitle("/org/organization-name/apps/add/custom"), "Add custom app");
    assert.equal(hostedPageTitle("/mcp/authorize"), "Authorize client");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("legal links use the host's URLs without introducing consent copy", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    for (const origin of ["", "https://executor.sh"]) {
      await act(async () =>
        root.render(
          <LoginLegalFooter privacyUrl={`${origin}/privacy`} termsUrl={`${origin}/terms`} />,
        ),
      );
      assert.deepEqual(
        Array.from(container.querySelectorAll("a")).map((link) => [
          link.textContent,
          link.getAttribute("href"),
        ]),
        [
          ["Privacy", `${origin}/privacy`],
          ["Terms", `${origin}/terms`],
        ],
      );
      assert.ok(!container.textContent?.includes("agree"));
    }
  } finally {
    await act(async () => root.unmount());
  }
});
