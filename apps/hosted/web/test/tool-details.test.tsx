import "./browser.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { RegistryContext } from "@effect/atom-react";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { AppId, DeploymentId, ToolName, type Tool } from "@executor-js/sdk";
import { ToolBrowser } from "@executor-js/ui/dashboard/tools";

const description =
  "**Readable description** [Documentation](https://example.test/docs) [Unsafe](javascript:alert(1)) <script>alert(1)</script>\n\n" +
  "A longer explanation. ".repeat(30);
const first: Tool = {
  app: AppId.make("app_fixture"),
  deployment: DeploymentId.make("dpl_fixture"),
  name: ToolName.make("first"),
  description,
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
  outputSchema: { type: "array", items: { type: "string" } },
};
const { outputSchema: _output, ...withoutOutput } = first;
const second: Tool = { ...withoutOutput, name: ToolName.make("second") };
const query = Atom.make(AsyncResult.success<readonly Tool[]>([first, second]));

function Fixture() {
  const [selected, select] = useState<string | undefined>("first");
  return (
    <ToolBrowser
      query={query}
      selected={selected}
      onSelect={select}
      back={null}
      Failure={() => null}
    />
  );
}

test("tool details render safe Markdown, optional outputs and raw clipboard values, and reset on selection", async () => {
  const registry = AtomRegistry.make();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const copied: string[] = [];
  let failCopy = false;
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        if (failCopy) throw new Error("Clipboard unavailable");
        copied.push(text);
      },
    },
  });
  const button = (label: string) => {
    const value = Array.from(container.querySelectorAll("button")).find(
      (button) =>
        button.getAttribute("aria-label") === label || button.textContent?.trim() === label,
    );
    assert.ok(value, `Missing button: ${label}`);
    return value;
  };
  try {
    await act(async () =>
      root.render(
        <RegistryContext value={registry}>
          <Fixture />
        </RegistryContext>,
      ),
    );
    assert.equal(
      container.querySelector(".tool-description strong")?.textContent,
      "Readable description",
    );
    assert.equal(container.querySelector("script"), null);
    assert.equal(container.querySelector('a[href^="javascript:"]'), null);
    const safeLink = container.querySelector('a[href="https://example.test/docs"]');
    assert.equal(safeLink?.getAttribute("rel"), "noopener noreferrer");
    assert.ok(container.textContent?.includes("Output schema"));
    assert.equal(button("Show more").getAttribute("aria-expanded"), "false");
    await act(async () => button("Show more").click());
    assert.equal(button("Show less").getAttribute("aria-expanded"), "true");
    for (const label of ["Copy tool name", "Copy input schema", "Copy output schema"])
      await act(async () => button(label).click());
    assert.deepEqual(copied, [
      "first",
      JSON.stringify(first.inputSchema, null, 2),
      JSON.stringify(first.outputSchema, null, 2),
    ]);
    failCopy = true;
    await act(async () => button("Copy input schema").click());
    assert.ok(button("Copy input schema").textContent?.includes("Copy failed"));
    const secondRow = Array.from(container.querySelectorAll<HTMLButtonElement>(".tool-row")).find(
      (row) => row.querySelector("code")?.textContent === "second",
    );
    assert.ok(secondRow);
    await act(async () => secondRow.click());
    assert.ok(!container.textContent?.includes("Output schema"));
    assert.equal(button("Show more").getAttribute("aria-expanded"), "false");
    assert.ok(!button("Copy tool name").textContent?.includes("Copied"));
  } finally {
    await act(async () => root.unmount());
    registry.dispose();
    container.remove();
    if (original) Object.defineProperty(navigator, "clipboard", original);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});
