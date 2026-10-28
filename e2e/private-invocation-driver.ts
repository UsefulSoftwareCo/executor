/** External actual-product driver. No application imports, minted auth, issuer, or embedded server. */
import { readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

interface Call {
  path: string;
  input: Record<string, unknown>;
  referenceFile: string;
}
interface Fixture {
  version: 1;
  mcpUrl: string;
  tokenFile: string;
  direct: Call;
  journal: Call;
  effect: Call;
  expectedResult: unknown;
  expectedEffect: unknown;
  /** Existing fixture ownership/provenance artifacts, never accepted by the product as authority. */
  provenance: {
    executorHead: string;
    issuerHead: string;
    nativeAdmissionReceiptFile: string;
    authenticatedAccountReceiptFile: string;
    ownedProcessesReceiptFile: string;
  };
}
class Prerequisite extends Error {}
const requireFile = async (path: string): Promise<string> => {
  const s = await stat(path);
  if (!s.isFile() || (s.mode & 0o077) !== 0 || s.size > 262144)
    throw new Prerequisite("Private fixture files require mode0600 and <=256KiB");
  return readFile(path, "utf8");
};
const json = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Expected protocol object");
  return v as Record<string, unknown>;
};
const outcome = (v: unknown): Record<string, unknown> => {
  const result = json(json(v).result);
  if (result.isError === true) return { ok: false };
  const completed = json(result.structuredContent);
  if (completed.status !== "completed") return { ok: false };
  const execution = json(completed.execution);
  if (execution.ok !== true) return { ok: false };
  return json(execution.value);
};
export async function runPrivateConformance(
  fixturePath: string,
  evidencePath: string,
): Promise<void> {
  let fixture: Fixture;
  try {
    fixture = JSON.parse(await requireFile(fixturePath));
  } catch {
    throw new Prerequisite(
      "Missing protected real-product fixture manifest; see docs/private-invocation.md",
    );
  }
  if (
    fixture.version !== 1 ||
    !fixture.provenance ||
    !/^[a-f0-9]{40}$/.test(fixture.provenance.executorHead) ||
    !/^[a-f0-9]{40}$/.test(fixture.provenance.issuerHead)
  )
    throw new Prerequisite("Pinned real product/issuer provenance required");
  // Read all genuine-fixture prerequisites before the first network operation. Never generate them.
  for (const file of [
    fixture.provenance.nativeAdmissionReceiptFile,
    fixture.provenance.authenticatedAccountReceiptFile,
    fixture.provenance.ownedProcessesReceiptFile,
  ])
    await requireFile(file);
  const token = (await requireFile(fixture.tokenFile)).trim();
  const refs = new Map<Call, string>();
  for (const call of [fixture.direct, fixture.journal, fixture.effect]) {
    if (!call?.path || !call.input)
      throw new Prerequisite("Three exact scoped real calls required");
    const ref = (await requireFile(call.referenceFile)).trim();
    if (!/^[\x21-\x7e]{1,512}$/.test(ref))
      throw new Prerequisite("Invalid protected reference fixture");
    refs.set(call, ref);
  }
  if (new Set(refs.values()).size !== 3)
    throw new Prerequisite("Independent operation references required");
  const url = new URL(fixture.mcpUrl);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Prerequisite("Owned authenticated HTTPS MCP endpoint required");
  let session: string | undefined;
  let id = 0;
  const observations: { method: string; status: number }[] = [];
  const send = async (method: string, params: unknown, reference?: string): Promise<unknown> => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (session) {
      headers["mcp-session-id"] = session;
      headers["mcp-protocol-version"] = "2025-11-25";
    }
    if (reference) headers["Private-Invocation"] = reference;
    const notification = method.startsWith("notifications/");
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      headers,
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        jsonrpc: "2.0",
        ...(notification ? {} : { id: ++id }),
        method,
        params,
      }),
    });
    observations.push({ method, status: response.status });
    session ??= response.headers.get("mcp-session-id") ?? undefined;
    if (!response.ok) {
      await response.body?.cancel();
      return { refused: true };
    }
    if (notification) {
      await response.body?.cancel();
      return null;
    }
    if (!response.body) throw new Error("Missing MCP response");
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let text = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (text.length > 262144) throw new Error("MCP response exceeds evidence bound");
        const event = text.split("\n").find((line) => line.startsWith("data: "));
        if (event) return JSON.parse(event.slice(6));
      }
      return JSON.parse(text);
    } finally {
      await reader.cancel();
    }
  };
  try {
    const initialized = json(
      await send("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {
          experimental: {
            privateInvocation: { version: 1, header: "Private-Invocation", directCallOnly: true },
          },
        },
        clientInfo: { name: "private-conformance", version: "1" },
      }),
    );
    const experimental = json(json(json(initialized.result).capabilities).experimental);
    assert.deepEqual(experimental.privateInvocation, {
      version: 1,
      header: "Private-Invocation",
      directCallOnly: true,
    });
    assert.ok(session, "Stateful negotiated MCP required");
    await send("notifications/initialized", {});
    const call = (c: Call) =>
      send(
        "tools/call",
        { name: "call", arguments: { calls: { path: c.path, input: c.input } } },
        refs.get(c),
      );
    const positive = outcome(await call(fixture.direct));
    assert.equal(positive.ok, true, "Actual private direct call must complete");
    assert.deepEqual(positive.value, fixture.expectedResult);
    const replay = json(await call(fixture.direct));
    assert.ok(
      replay.refused === true || "error" in replay || outcome(replay).ok === false,
      "Replay cannot redispatch",
    );
    const journal = outcome(await call(fixture.journal));
    assert.equal(journal.ok, true);
    const status = json(journal.value);
    assert.equal(
      status.outcome,
      "observed",
      "Read persisted app journal through real process/network",
    );
    const readback = outcome(await call(fixture.effect));
    assert.equal(readback.ok, true);
    assert.deepEqual(
      readback.value,
      fixture.expectedEffect,
      "Independent actual effect readback after replay",
    );
    await mkdir(evidencePath, { recursive: true, mode: 0o700 });
    await writeFile(
      resolve(evidencePath, "private-invocation-result.json"),
      JSON.stringify(
        {
          version: 1,
          executedScenarios: 1,
          actualDirectCalls: 4,
          modelCalls: 0,
          observations,
          provenance: {
            executorHead: fixture.provenance.executorHead,
            issuerHead: fixture.provenance.issuerHead,
          },
          assertions: [
            "negotiated",
            "direct-effect",
            "replay-refused",
            "persistent-journal",
            "independent-effect-readback",
          ],
          remaining: [
            "overlapping-origin-isolation",
            "all-denials",
            "restart-rebind-revocation",
            "write-response-loss",
            "model-trace-catalog-inspection",
            "ordinary-old-host-compatibility",
          ],
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
  } finally {
    if (session)
      await fetch(url, {
        method: "DELETE",
        redirect: "error",
        headers: { authorization: `Bearer ${token}`, "mcp-session-id": session },
        signal: AbortSignal.timeout(5000),
      })
        .then((r) => r.body?.cancel())
        .catch(() => {});
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const argument = (name: string) => {
    const at = process.argv.indexOf(name);
    return at < 0 ? undefined : process.argv[at + 1];
  };
  try {
    const fixture = argument("--fixture"),
      evidence = argument("--evidence");
    if (!fixture || !evidence)
      throw new Prerequisite(
        "Usage: node e2e/private-invocation-driver.ts --fixture PROTECTED_MANIFEST --evidence PRIVATE_DIRECTORY",
      );
    await runPrivateConformance(fixture, evidence);
    process.stdout.write(
      "Executed one real external private invocation scenario; see private evidence\n",
    );
  } catch (error) {
    process.stderr.write(
      error instanceof Prerequisite
        ? error.message + "\n"
        : "Real private invocation conformance failed; private evidence required\n",
    );
    process.exitCode = error instanceof Prerequisite ? 2 : 1;
  }
}
