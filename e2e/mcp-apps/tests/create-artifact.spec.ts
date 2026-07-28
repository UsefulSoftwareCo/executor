import { test, expect } from "sunpeak/test";

// executor's create-artifact shell mounts the generated component in a *nested* srcdoc
// iframe (shell-app -> inner-renderer, the MCP-Apps double-iframe sandbox), one
// level below sunpeak's own `result.app()`. Descend that extra level.
const appBody = (result: { app: () => ReturnType<ReturnType<typeof test>["app"]> } | any) =>
  result.app().frameLocator("iframe");

const COUNTER = `function App() {
  const [count, setCount] = useState(0);
  return (
    <div className="p-4">
      <h2>MCP App counter</h2>
      <Badge>{count}</Badge>
      <Button onClick={() => setCount((c) => c + 1)}>Increment</Button>
    </div>
  );
}`;

// sunpeak runs every test against both the Claude and ChatGPT host simulations.

test("create-artifact mounts an interactive React widget", async ({ inspector }) => {
  const result = await inspector.renderTool("create-artifact", {
    code: COUNTER,
    title: "MCP App counter",
  });
  const app = appBody(result);

  await expect(app.locator("text=MCP App counter")).toBeVisible({ timeout: 15000 });
  const inc = app.locator('button:has-text("Increment")');
  await expect(inc).toBeVisible();

  // state is live: clicking updates the rendered output
  await inc.click();
  await expect(app.locator("text=1")).toBeVisible();
});

test("create-artifact renders in dark theme", async ({ inspector }) => {
  const result = await inspector.renderTool(
    "create-artifact",
    { code: COUNTER, title: "MCP App counter" },
    { theme: "dark" },
  );
  await expect(appBody(result).locator("text=MCP App counter")).toBeVisible({ timeout: 15000 });
});

// The whole point of patching sunpeak to advertise MCP-Apps support is that
// executor returns the inline widget rather than its deep-link fallback. Assert
// that directly, so a future sunpeak change that drops the capability fails
// here instead of quietly testing the wrong delivery path.
// Protocol-level assertions go through the `mcp` fixture: `inspector` models
// what a *host* shows the user and does not surface the raw tool result.
const structuredOf = (result: { structuredContent?: unknown }): Record<string, unknown> =>
  (result.structuredContent ?? {}) as Record<string, unknown>;

test("create-artifact returns an inline widget, not the deep-link fallback", async ({ mcp }) => {
  const result = await mcp.callTool("create-artifact", {
    code: COUNTER,
    title: "MCP App counter",
    description: "A counter used by the MCP Apps e2e harness",
  });
  const structured = structuredOf(result);
  // The whole point of the inspector advertising MCP-Apps support: executor
  // must hand back the component, not a URL to go look at it elsewhere.
  expect(structured.status).not.toBe("fallback_url");
  expect(structured.code).toContain("MCP App counter");
  // Every successful render is persisted, so the artifact can be reopened.
  expect(structured.artifactId).toBeTruthy();
});

test("a rendered artifact is listed and can be shown again", async ({ inspector, mcp }) => {
  const rendered = await mcp.callTool("create-artifact", {
    code: COUNTER,
    title: "Retrievable counter",
    description: "Saved so list-artifacts can find it",
  });
  const artifactId = structuredOf(rendered).artifactId as string;
  expect(artifactId).toBeTruthy();

  const listed = await mcp.callTool("list-artifacts", {});
  const artifacts = structuredOf(listed).artifacts as Array<{ id: string }> | undefined;
  expect(artifacts?.some((artifact) => artifact.id === artifactId)).toBe(true);

  // …and the stored source really does render, through the same shell.
  const shown = await inspector.renderTool("show-artifact", { id: artifactId });
  await expect(appBody(shown).locator("text=MCP App counter")).toBeVisible({ timeout: 15000 });
});
