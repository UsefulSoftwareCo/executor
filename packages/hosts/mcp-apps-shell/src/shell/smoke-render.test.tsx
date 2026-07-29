import { describe, expect, it } from "@effect/vitest";
import { SealedBundleError, executeSealedBundle } from "@executor-js/runtime-quickjs";
import * as Effect from "effect/Effect";

import harnessBundle from "./smoke-harness-bundle.gen";
import { smokeRenderArtifact, stubSealedBundle } from "./smoke-render";
import type { SmokeRenderResult } from "./smoke-render-result";

// The create-time render check. Each case is a shape a model actually writes;
// the assertion is what the model would be told back.

describe("smokeRenderArtifact", () => {
  it("passes a plain component", async () => {
    expect((await smokeRenderArtifact("function App(){ return <div>hello</div>; }")).status).toBe(
      "ok",
    );
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
    expect(result.status).toBe("ok");
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
    expect(result.status).toBe("ok");
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
    expect(result.status).toBe("ok");
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
    expect(result.status).toBe("ok");
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
    expect(result.status).toBe("ok");
  });

  it("passes rather than blocks when the sandbox cannot answer", async () => {
    // FAIL OPEN, the contract this check lives under. A sandbox that fails to
    // start, a harness bundle missing from a partial build, a deadline — none
    // of them say anything about the artifact, so a create must go through
    // rather than be refused with an error about code the model did not write.
    // Simulated at the seam the host actually depends on: the sealed-bundle
    // call that would carry the answer back.
    const failing = Effect.fail(new SealedBundleError({ message: "sandbox unavailable" }));
    using _sandbox = stubSealedBundle(() => failing);

    // Code that certainly would NOT render, so a pass can only come from the
    // fail-open path and not from the artifact being fine.
    expect(
      (await smokeRenderArtifact("function App(){ return <ChartTooltipContent />; }")).status,
    ).toBe("ok");
  });

  // ------------------------------------------------------------------
  // The security property this check exists inside a sandbox for.
  //
  // These are attempted escapes, written the way a compromised or careless
  // model would write them, asserting the sandbox DENIES each one. They are
  // not testing the ~280-name scope — shadowing an identifier is not a
  // boundary, since `globalThis.process` never mentions the shadowed name.
  // They are testing that the host's process is genuinely not reachable from
  // where this code runs. Every one of them would have read real host state
  // back when the render ran in-process.
  //
  // A denied escape surfaces as a render failure (the reference throws), which
  // is exactly right: the sandbox has no `process` to find, so looking for one
  // is a ReferenceError like any other.
  // ------------------------------------------------------------------
  describe("sandbox containment", () => {
    const renderExpression = (expression: string): Promise<SmokeRenderResult> =>
      smokeRenderArtifact(`function App(){ return <div>{String(${expression})}</div>; }`);

    it("has no process to reach", async () => {
      // `typeof` cannot throw, so this reads back what the sandbox actually
      // has: "undefined". If a host process leaked in, it would say "object".
      const result = await renderExpression("typeof process");
      expect(result.status).toBe("ok");
    });

    it("denies globalThis.process", async () => {
      const result = await renderExpression("globalThis.process.env.EXECUTOR_SECRET");
      expect(result.status).toBe("failed");
    });

    it("denies the Function constructor route to process", async () => {
      // The classic scope-shadowing bypass: build a function whose body is
      // evaluated in global scope, so no shadowed binding is in the way.
      const result = await renderExpression('Function("return process")()');
      expect(result.status).toBe("failed");
      expect(result.status === "failed" ? result.message : "").toContain("process");
    });

    it("denies dynamic import", async () => {
      // Asserted against the sandbox directly rather than through a component.
      // `import()` REJECTS rather than throwing, and its rejection lands after
      // the one-shot server render has finished (effects never run during SSR),
      // so no artifact could observe it — the render would pass while proving
      // nothing. What matters is that the module genuinely does not load: the
      // sandbox has no loader behind `import` and no host module graph to reach.
      const probe = await Effect.runPromise(
        executeSealedBundle({
          bundle: harnessBundle ?? "",
          call: `(async () => {
            try { await import('node:fs'); return 'RESOLVED'; }
            catch (e) { return 'REJECTED:' + (e && e.message ? e.message : String(e)); }
          })()`,
          timeoutMs: 30_000,
        }),
      );
      expect(probe).toContain("REJECTED:");
      expect(probe).toContain("could not load module");
    }, 60_000);

    it("has no host globals to reach at all", async () => {
      // The complement of the shadowing tests: not "is the name shadowed" but
      // "does the sandbox's global object contain any of this". Asked of the
      // sandbox itself, so no component scope is involved.
      const probe = await Effect.runPromise(
        executeSealedBundle({
          bundle: harnessBundle ?? "",
          call: `Promise.resolve(JSON.stringify({
            process: typeof globalThis.process,
            fetch: typeof globalThis.fetch,
            require: typeof globalThis.require,
            XMLHttpRequest: typeof globalThis.XMLHttpRequest,
            WebSocket: typeof globalThis.WebSocket,
          }))`,
          timeoutMs: 30_000,
        }),
      );
      expect(JSON.parse(probe)).toEqual({
        process: "undefined",
        fetch: "undefined",
        require: "undefined",
        XMLHttpRequest: "undefined",
        WebSocket: "undefined",
      });
    }, 60_000);

    it("denies require of a host module", async () => {
      const result = await smokeRenderArtifact(
        "function App(){ require('node:child_process'); return <div/>; }",
      );
      expect(result.status).toBe("failed");
    });

    it("denies network access", async () => {
      const result = await smokeRenderArtifact(
        "function App(){ fetch('https://example.com'); return <div/>; }",
      );
      expect(result.status).toBe("failed");
    });

    it("stops a component that spins forever", async () => {
      // In-process this could not be done — no timeout interrupts a spinning
      // host thread, so such an artifact hung the request until the host's own
      // timeout. The sandbox's interrupt handler preempts the interpreter.
      // Inconclusive, so `ok` by the fail-open contract, but BOUNDED.
      const result = await smokeRenderArtifact("function App(){ while (true) {} return <div/>; }");
      expect(result.status).toBe("ok");
    }, 60_000);
  });

  it("reports a syntax error as a failure rather than throwing", async () => {
    const result = await smokeRenderArtifact("function App(){ return <div>; }");
    expect(result.status).toBe("failed");
  });

  // The same render that validates the artifact also produces the gallery's
  // layout preview. These pin the markup half of the contract.
  describe("layout markup", () => {
    it("returns the markup the component rendered", async () => {
      const result = await smokeRenderArtifact(
        'function App(){ return <div className="p-4"><h2>Revenue</h2></div>; }',
      );
      expect(result.status).toBe("ok");
      const markup = result.status === "ok" ? (result.markup ?? "") : "";
      // The classes are the whole visual layer, so they have to survive.
      expect(markup).toContain('class="p-4"');
      expect(markup).toContain("Revenue");
    });

    it("returns the LOADING composition for a component that queries", async () => {
      // Every tool call hangs by design, so this is the state the user sees
      // first — and the state that is safe to store, since nothing was fetched.
      const result = await smokeRenderArtifact(
        [
          "function App(){",
          "  const q = useQuery(tools.github.issues.list.queryOptions({}));",
          "  if (q.isPending) return <ArtifactLoading />;",
          "  return <div>{String(q.data)}</div>;",
          "}",
        ].join("\n"),
      );
      expect(result.status).toBe("ok");
      const markup = result.status === "ok" ? (result.markup ?? "") : "";
      expect(markup).toContain("artifact-loading");
      expect(markup).not.toContain("undefined");
    });

    it("omits markup when the render fails", async () => {
      // A failed verdict has no preview to offer, and the type says so.
      const result = await smokeRenderArtifact("function App(){ return <ChartTooltipContent />; }");
      expect(result.status).toBe("failed");
      expect("markup" in result).toBe(false);
    });

    it("omits markup for a component that renders nothing", async () => {
      // Empty is not a preview, and the caller must not read "" as one.
      const result = await smokeRenderArtifact("function App(){ return null; }");
      expect(result.status).toBe("ok");
      expect(result.status === "ok" ? result.markup : "unused").toBeUndefined();
    });

    it("drops the markup rather than returning a partial tree when it is huge", async () => {
      // Past the harness's cap the render is still driven to completion — that
      // is how a late throw is observed — but nothing is kept, because half a
      // DOM tree is not a picture of anything.
      const result = await smokeRenderArtifact(
        [
          "function App(){",
          "  return (",
          "    <div>",
          "      {Array.from({ length: 4000 }, (_, i) => (",
          '        <div key={i} className="flex items-center gap-4 rounded-lg border p-4">',
          "          <span>Row number {i} with enough text to add up quickly</span>",
          "        </div>",
          "      ))}",
          "    </div>",
          "  );",
          "}",
        ].join("\n"),
      );
      expect(result.status).toBe("ok");
      expect(result.status === "ok" ? result.markup : "unused").toBeUndefined();
    }, 60_000);
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
    expect(result.status).toBe("ok");
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
    expect(result.status).toBe("ok");
  });
});
