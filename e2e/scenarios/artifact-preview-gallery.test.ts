// A visual check of the artifact gallery's previews, in light and dark.
//
// The other artifacts scenarios prove the mechanism: the layout preview is
// stored at create time and upgraded to a snapshot once the artifact is opened.
// This one exists to show what that actually LOOKS like across the shapes a
// model really produces — a stat grid, a chart, and a component whose data is
// still loading — because "the preview is real" is a claim about appearance and
// the only honest way to check appearance is to look at it.
//
// It seeds through `create-artifact` rather than the storage API, so every
// preview here was produced by the same smoke render a model's create runs
// through.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Mcp, Target } from "../src/services";

const uniqueSuffix = () => randomBytes(3).toString("hex");

/** A stat grid over a table: the most common dashboard shape. */
const dashboardSource = `
function App() {
  const metrics = [
    { label: "Active users", value: "12,480", delta: "+8.2% vs last week" },
    { label: "Sessions", value: "48,201", delta: "+3.1% vs last week" },
    { label: "Error rate", value: "0.42%", delta: "-0.3% vs last week" },
    { label: "p95 latency", value: "284ms", delta: "+12ms vs last week" },
  ];
  const rows = Array.from({ length: 6 }, (_, i) => ({
    name: "checkout-service-" + (i + 1),
    status: i % 3 === 0 ? "degraded" : "healthy",
  }));
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Release Readiness</h2>
        <p className="text-sm text-muted-foreground">Rolling 24h across all services</p>
      </div>
      <div className="grid grid-cols-4 gap-4">
        {metrics.map((m) => (
          <Card key={m.label}>
            <CardHeader className="pb-2">
              <CardDescription>{m.label}</CardDescription>
              <CardTitle className="text-2xl tabular-nums">{m.value}</CardTitle>
            </CardHeader>
            <CardContent>
              <span className="text-xs text-muted-foreground">{m.delta}</span>
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader><CardTitle className="text-base">Services</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Service</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.name}>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell>
                    <Badge variant={r.status === "healthy" ? "secondary" : "destructive"}>
                      {r.status}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}`;

/** A chart: the shape whose preview is almost entirely SVG geometry. */
const chartSource = `
function App() {
  const data = [
    { month: "Jan", revenue: 4200 }, { month: "Feb", revenue: 5100 },
    { month: "Mar", revenue: 4800 }, { month: "Apr", revenue: 6300 },
    { month: "May", revenue: 7100 }, { month: "Jun", revenue: 8250 },
  ];
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Revenue by month</h2>
        <p className="text-sm text-muted-foreground">Current fiscal year</p>
      </div>
      <Card>
        <CardContent className="pt-6">
          <ChartContainer
            config={{ revenue: { label: "Revenue", color: "var(--chart-1)" } }}
            className="h-[280px] w-full"
          >
            <BarChart data={data}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="month" tickLine={false} axisLine={false} />
              <YAxis tickLine={false} axisLine={false} />
              <Bar dataKey="revenue" fill="var(--color-revenue)" radius={4} />
            </BarChart>
          </ChartContainer>
        </CardContent>
      </Card>
    </div>
  );
}`;

/**
 * A component showing its loading state: the shape whose preview is a skeleton.
 *
 * Deliberately does NOT call a tool. A real `tools.*` query would need a bound
 * connection, and binding one here would test the binding path rather than the
 * preview — while the SKELETON, which is what this case is about, is identical
 * either way: the smoke render's transport never settles, so every querying
 * artifact previews exactly this.
 */
const loadingSource = `
function App() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Open Issues</h2>
        <p className="text-sm text-muted-foreground">Loading from the tracker</p>
      </div>
      <ArtifactLoading variant="table" />
    </div>
  );
}`;

scenario(
  "Artifacts · the gallery shows each artifact's real layout, in light and dark",
  { timeout: 240_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const browser = yield* Browser;

    const identity = yield* target.newIdentity();
    // Artifacts are opt-in per MCP connection, so this session asks for the
    // surface it is here to exercise (`?artifacts=true`).
    const session = mcp.session(identity, { artifacts: true });
    const suffix = uniqueSuffix();

    const seeded = [
      ["Release Readiness", dashboardSource, "Service health across the fleet"],
      ["Revenue by Month", chartSource, "Monthly revenue for the fiscal year"],
      ["Open Issues", loadingSource, "Open GitHub issues, live"],
    ] as const;

    for (const [name, code, description] of seeded) {
      const result = yield* session.call("create-artifact", {
        code,
        title: `${name} ${suffix}`,
        description,
      });
      expect(result.ok, `${name} saved: ${result.text}`).toBe(true);
    }

    yield* browser.session(identity, async ({ page, step }) => {
      await step("Open the Artifacts gallery", async () => {
        await page.goto(`${target.baseUrl}/artifacts`, { waitUntil: "networkidle" });
        await page.getByRole("heading", { name: "Artifacts", level: 1 }).waitFor();
        // Every seeded artifact is present before anything is measured.
        for (const [name] of seeded) {
          await page
            .getByRole("link", { name: `Open artifact ${name} ${suffix}` })
            .waitFor({ timeout: 30_000 });
        }
      });

      await step("Every card draws the artifact's own layout", async () => {
        const previews = page.locator('[data-slot="artifact-preview"]');
        await expect
          .poll(async () => await previews.count(), { timeout: 20_000 })
          .toBe(seeded.length);

        // Not one schematic among them: all three previews came from a real
        // render of the artifact's own source.
        for (let index = 0; index < seeded.length; index += 1) {
          expect(
            await previews.nth(index).getAttribute("data-preview-kind"),
            `card ${index} shows a captured preview rather than the fallback`,
          ).toBe("layout");
        }

        // And the content is the artifact's, not a generic frame: each card
        // carries text or geometry its own source produced.
        const gallery = await page.locator('[data-slot="artifact-grid"]').innerText();
        expect(gallery, "the dashboard's own heading is on its card").toContain(
          "Release Readiness",
        );
        expect(gallery, "the dashboard's real stat labels are on its card").toContain(
          "Active users",
        );
        expect(gallery, "the chart artifact's heading is on its card").toContain(
          "Revenue by month",
        );

        // A chart's LAYOUT preview is its frame and heading, not its bars.
        //
        // That is a property of Recharts, not of the sanitizer: its
        // `ResponsiveContainer` measures the element it is inside, and on a
        // server there is nothing to measure, so it renders a sized wrapper and
        // no SVG at all. Asserting bars here would be asserting something no
        // server render can produce. What the card can promise is the artifact's
        // identity and its frame — and the second layer, the snapshot taken once
        // the artifact has actually been opened in a browser, is what fills in
        // the geometry. See the artifacts scenario for that half.
        const chartCard = page
          .locator('[data-slot="artifact-card"]')
          .filter({ hasText: `Revenue by Month ${suffix}` });
        const chartPreview = chartCard.locator('[data-slot="artifact-preview"]');
        expect(
          await chartPreview.getAttribute("data-preview-kind"),
          "the chart artifact still gets a real layout preview",
        ).toBe("layout");
        expect(
          await chartPreview.locator(".recharts-responsive-container").count(),
          "the chart's frame is drawn even though its geometry needs a viewport",
        ).toBeGreaterThan(0);

        // The preview's STRUCTURE has to survive, not just its text. The card
        // renders the markup in the console document, so a layout class the
        // model used that this stylesheet never compiled would silently
        // collapse a four-up stat row into one column — the preview would still
        // "work" and would be showing the wrong shape. `grid-cols-4` is the
        // case: the console itself never needs one, so only the safelist in
        // `globals.css` puts it in the stylesheet.
        const statColumns = await page
          .locator('[data-slot="artifact-card"]')
          .filter({ hasText: `Release Readiness ${suffix}` })
          .locator('[data-slot="artifact-preview"] .grid-cols-4')
          .first()
          .evaluate(
            (node) =>
              globalThis
                .getComputedStyle(node)
                .gridTemplateColumns.split(" ")
                .filter((track) => track.length > 0).length,
          );
        expect(
          statColumns,
          "the dashboard's four-column stat row is still four columns in the preview",
        ).toBe(4);
      });

      await step("Gallery in dark mode", async () => {
        // The stored markup is token-based, so the SAME markup has to read
        // correctly against the console's dark surface without being restyled.
        await page.emulateMedia({ colorScheme: "dark" });
        await page.reload({ waitUntil: "networkidle" });
        await page.getByRole("heading", { name: "Artifacts", level: 1 }).waitFor();
        await page.locator('[data-slot="artifact-preview"]').first().waitFor({ timeout: 20_000 });

        // The card's own background follows the theme, and the preview inside
        // it inherits the console's tokens rather than carrying its own.
        const card = page.locator('[data-slot="artifact-card"]').first();
        const surface = await card.evaluate(
          (node) => globalThis.getComputedStyle(node).backgroundColor,
        );
        expect(surface, "the card is drawn on a dark surface").not.toBe("rgb(255, 255, 255)");
      });

      await step("Gallery in light mode", async () => {
        await page.emulateMedia({ colorScheme: "light" });
        await page.reload({ waitUntil: "networkidle" });
        await page.getByRole("heading", { name: "Artifacts", level: 1 }).waitFor();
        await page.locator('[data-slot="artifact-preview"]').first().waitFor({ timeout: 20_000 });
      });
    });
  }),
);
