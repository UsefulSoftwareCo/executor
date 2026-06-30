import { test, expect } from "sunpeak/test";

// executor's render-ui shell mounts the generated component in a *nested* srcdoc
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

test("render-ui mounts an interactive React widget", async ({ inspector }) => {
  const result = await inspector.renderTool("render-ui", { code: COUNTER });
  const app = appBody(result);

  await expect(app.locator("text=MCP App counter")).toBeVisible({ timeout: 15000 });
  const inc = app.locator('button:has-text("Increment")');
  await expect(inc).toBeVisible();

  // state is live: clicking updates the rendered output
  await inc.click();
  await expect(app.locator("text=1")).toBeVisible();
});

test("render-ui renders in dark theme", async ({ inspector }) => {
  const result = await inspector.renderTool("render-ui", { code: COUNTER }, { theme: "dark" });
  await expect(appBody(result).locator("text=MCP App counter")).toBeVisible({ timeout: 15000 });
});
