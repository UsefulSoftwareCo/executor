import { describe, expect, it } from "@effect/vitest";

import { smokeRenderArtifact } from "./smoke-render";

// The create-time render check. Each case is a shape a model actually writes;
// the assertion is what the model would be told back.

describe("smokeRenderArtifact", () => {
  it("passes a plain component", async () => {
    expect(await smokeRenderArtifact("function App(){ return <div>hello</div>; }")).toEqual({
      status: "ok",
    });
  });

  it("catches the chart primitive rendered outside its ChartContainer", async () => {
    // The exact failure that motivated this: it saved fine and died on the page.
    const result = await smokeRenderArtifact(
      "function App(){ return <ChartTooltipContent payload={[]} />; }",
    );
    expect(result.status).toBe("failed");
    // The real error, verbatim, so the model can act on it without a translation.
    expect(result.status === "failed" ? result.message : "").toContain(
      "useChart must be used within a <ChartContainer />",
    );
  });

  it("passes the same chart once a ChartContainer wraps it", async () => {
    const result = await smokeRenderArtifact(
      [
        "function App(){",
        "  return (",
        '    <ChartContainer config={{ n: { label: "N", color: "var(--chart-1)" } }} className="h-[240px] w-full">',
        "      <BarChart data={[{ day: 'Mon', n: 1 }]}>",
        '        <XAxis dataKey="day" />',
        "        <ChartTooltip content={<ChartTooltipContent />} />",
        '        <Bar dataKey="n" fill="var(--chart-1)" />',
        "      </BarChart>",
        "    </ChartContainer>",
        "  );",
        "}",
      ].join("\n"),
    );
    expect(result).toEqual({ status: "ok" });
  });

  it("renders the loading branch: every query is pending, nothing is fetched", async () => {
    const result = await smokeRenderArtifact(
      [
        "function App(){",
        "  const q = useQuery(tools.vercel.getDomains.queryOptions({ limit: 10 }));",
        "  if (q.isLoading) return <ArtifactLoading variant='table' rows={3} />;",
        "  return <div>{q.data?.length}</div>;",
        "}",
      ].join("\n"),
    );
    expect(result).toEqual({ status: "ok" });
  });

  it("catches a component that dereferences pending query data without a guard", async () => {
    // `data` IS undefined while a query is pending, so this crashes for real on
    // the user's first paint. Catching it here is the feature, not a false
    // positive.
    const result = await smokeRenderArtifact(
      [
        "function App(){",
        "  const q = useQuery(tools.vercel.getDomains.queryOptions({}));",
        "  return <div>{q.data.domains.length}</div>;",
        "}",
      ].join("\n"),
    );
    expect(result.status).toBe("failed");
    expect(result.status === "failed" ? result.message : "").toMatch(/undefined/i);
  });

  it("passes the same component when it guards the pending state", async () => {
    const result = await smokeRenderArtifact(
      [
        "function App(){",
        "  const q = useQuery(tools.vercel.getDomains.queryOptions({}));",
        "  return <div>{q.data?.domains?.length ?? 0}</div>;",
        "}",
      ].join("\n"),
    );
    expect(result).toEqual({ status: "ok" });
  });

  it("passes an infinite query's loading state", async () => {
    const result = await smokeRenderArtifact(
      [
        "function App(){",
        "  const q = useInfiniteQuery(",
        "    tools.vercel.getDomains.infiniteQueryOptions(",
        "      { limit: 100 },",
        '      { cursorKey: "since", getNextPageParam: (page) => page?.next ?? undefined },',
        "    ),",
        "  );",
        "  const rows = (q.data?.pages ?? []).flatMap((page) => page?.domains ?? []);",
        "  return <div>{rows.length}</div>;",
        "}",
      ].join("\n"),
    );
    expect(result).toEqual({ status: "ok" });
  });

  it("passes a mutation, which is inert until something calls it", async () => {
    const result = await smokeRenderArtifact(
      [
        "function App(){",
        "  const m = useMutation(tools.vercel.addDomain.mutationOptions({}));",
        "  return <Button onClick={() => m.mutate({ name: 'x' })}>Add</Button>;",
        "}",
      ].join("\n"),
    );
    expect(result).toEqual({ status: "ok" });
  });

  it("reports a syntax error as a failure rather than throwing", async () => {
    const result = await smokeRenderArtifact("function App(){ return <div>; }");
    expect(result.status).toBe("failed");
  });

  it("reports code with no App component", async () => {
    const result = await smokeRenderArtifact("const x = 1;");
    expect(result.status).toBe("failed");
    expect(result.status === "failed" ? result.message : "").toContain("App");
  });

  it("carries a component stack when React reports one", async () => {
    const result = await smokeRenderArtifact(
      [
        "function Inner(){ throw new Error('boom'); }",
        "function App(){ return <Card><CardContent><Inner /></CardContent></Card>; }",
      ].join("\n"),
    );
    expect(result.status).toBe("failed");
    expect(result.status === "failed" ? result.message : "").toContain("boom");
    expect(result.status === "failed" ? result.componentStack : undefined).toContain("Inner");
  });

  it("renders the shadcn components that need their own provider from the shell", async () => {
    // TooltipProvider is supplied by the harness exactly as the inner renderer
    // supplies it, so a bare Tooltip must not be reported as broken.
    const result = await smokeRenderArtifact(
      [
        "function App(){",
        "  return (",
        "    <Tooltip>",
        "      <TooltipTrigger>?</TooltipTrigger>",
        "      <TooltipContent>Help</TooltipContent>",
        "    </Tooltip>",
        "  );",
        "}",
      ].join("\n"),
    );
    expect(result).toEqual({ status: "ok" });
  });

  it("renders a representative dashboard: cards, table, badges, icons", async () => {
    const result = await smokeRenderArtifact(
      [
        "function App(){",
        "  const q = useQuery(tools.vercel.getDomains.queryOptions({}));",
        "  const rows = q.data?.domains ?? [];",
        "  if (q.isLoading) return <ArtifactLoading variant='table' rows={5} />;",
        "  if (q.error) return <ArtifactError error={q.error} />;",
        "  if (!rows.length) return <ArtifactEmpty title='No domains' />;",
        "  return (",
        "    <Card>",
        "      <CardHeader><CardTitle>Domains</CardTitle></CardHeader>",
        "      <CardContent>",
        "        <Table><TableBody>",
        "          {rows.map((row) => (",
        "            <TableRow key={row.id}>",
        "              <TableCell>{row.name}</TableCell>",
        "              <TableCell><Badge>{row.status}</Badge></TableCell>",
        "            </TableRow>",
        "          ))}",
        "        </TableBody></Table>",
        "      </CardContent>",
        "    </Card>",
        "  );",
        "}",
      ].join("\n"),
    );
    expect(result).toEqual({ status: "ok" });
  });
});
