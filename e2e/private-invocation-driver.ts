/** External actual-product driver. No application imports, minted auth, issuer, or embedded server. */
import { readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { privateMcpHttp } from "./private-invocation-http.ts";
import { actualReadback, type PrivateReadback } from "./private-invocation-readback.ts";

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
interface SupportFixture {
  mcpUrl: string;
  tokenFile: string;
  organizationId: string;
  journalPath: string;
  protectedPath: string;
  expectedPrincipal: string;
  readback: PrivateReadback;
}
/** Available engineering checks. A real ordinary path must succeed before a denial is meaningful. */
export async function runLabSupport(fixturePath: string, evidencePath: string): Promise<void> {
  const fixture: SupportFixture = JSON.parse(await requireFile(fixturePath));
  const connection = privateMcpHttp(
    new URL(fixture.mcpUrl),
    (await requireFile(fixture.tokenFile)).trim(),
    fixture.organizationId,
  );
  const { send } = connection;
  try {
    const initialize = json(
      await send("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {
          experimental: {
            privateInvocation: { version: 1, header: "Private-Invocation", directCallOnly: true },
          },
        },
        clientInfo: { name: "owned-lab-support", version: "1" },
      }),
    );
    assert.deepEqual(
      json(json(json(initialize.result).capabilities).experimental).privateInvocation,
      { version: 1, header: "Private-Invocation", directCallOnly: true },
    );
    assert.ok(connection.session);
    await send("notifications/initialized", {});
    const ordinary = () =>
      send("tools/call", {
        name: "call",
        arguments: { calls: { path: fixture.journalPath, input: {} } },
      });
    const before = outcome(await ordinary());
    await mkdir(evidencePath, { recursive: true, mode: 0o700 });
    await writeFile(
      resolve(evidencePath, "ordinary-response.private.json"),
      JSON.stringify(before),
      { mode: 0o600 },
    );
    assert.equal(before.ok, true, "same-app ordinary journal must execute");
    assert.equal(json(before.value).principal, fixture.expectedPrincipal);
    const effectsBefore = await actualReadback(fixture.readback);
    const missing = outcome(
      await send("tools/call", {
        name: "call",
        arguments: {
          calls: {
            path: fixture.protectedPath,
            input: { operationId: "no-native-support-check", value: "owned-support" },
          },
        },
      }),
    );
    assert.equal(missing.ok, false, "protected tool must refuse absent native authority");
    const after = outcome(await ordinary());
    assert.deepEqual(after, before, "refused call must not enter the app's durable journal");
    assert.deepEqual(
      await actualReadback(fixture.readback),
      effectsBefore,
      "independent effect store must stay unchanged",
    );
    await writeFile(
      resolve(evidencePath, "support-result.json"),
      JSON.stringify(
        {
          executedSupportCases: 3,
          assertions: [
            "negotiated-real-session",
            "same-app-ordinary-journal",
            "missing-origin-refusal-before-journal-and-effect",
          ],
          pairedAcceptedRows: 0,
          voiceAcceptedRows: 0,
          nativeAdmissions: 0,
          modelCalls: 0,
          observations: connection.observations,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  } finally {
    await connection.close();
  }
}
interface NativeFixture extends SupportFixture {
  version: 2;
  bindingFile: string;
  provenance: {
    executorHead: string;
    hermesHead: string;
    ownedProcessesReceiptFile: string;
    authenticatedAccountReceiptFile: string;
  };
  operations: ReadonlyArray<{
    operationId: string;
    input: Record<string, unknown>;
    receiptFile: string;
    resultFile: string;
    issuerFile: string;
    referenceFile: string;
    originalOriginFile?: string;
    outcome: "observed" | "unknown";
  }>;
  expectedOrigin: Record<string, unknown>;
}
/** Observe the actual gateway SDK path, then independently reconcile its real effect and journal. */
export async function observeNative(fixturePath: string, evidencePath: string): Promise<void> {
  const fixture: NativeFixture = JSON.parse(await requireFile(fixturePath));
  if (
    fixture.version !== 2 ||
    !/^[a-f0-9]{40}$/.test(fixture.provenance?.executorHead ?? "") ||
    !/^[a-f0-9]{40}$/.test(fixture.provenance?.hermesHead ?? "")
  )
    throw new Prerequisite("Exact owned candidate source provenance required");
  await requireFile(fixture.provenance.ownedProcessesReceiptFile);
  await requireFile(fixture.provenance.authenticatedAccountReceiptFile);
  const expectedTarget = json(json(JSON.parse(await requireFile(fixture.bindingFile))).target);
  if (!fixture.operations.length)
    throw new Prerequisite("At least one genuine native operation required");
  const readEventually = async (path: string): Promise<string> => {
    const end = Date.now() + 60000;
    for (;;) {
      try {
        return await requireFile(path);
      } catch (error) {
        if (Date.now() >= end) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  };
  const connection = privateMcpHttp(
    new URL(fixture.mcpUrl),
    (await requireFile(fixture.tokenFile)).trim(),
    fixture.organizationId,
  );
  const reports: unknown[] = [];
  try {
    await connection.send("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {
        experimental: {
          privateInvocation: { version: 1, header: "Private-Invocation", directCallOnly: true },
        },
      },
      clientInfo: { name: "genuine-native-observer", version: "1" },
    });
    assert.ok(connection.session);
    await connection.send("notifications/initialized", {});
    for (const operation of fixture.operations) {
      const [rawNative, rawSdk, rawIssuer, reference] = await Promise.all(
        [
          operation.receiptFile,
          operation.resultFile,
          operation.issuerFile,
          operation.referenceFile,
        ].map(readEventually),
      );
      const native = json(JSON.parse(rawNative!)),
        sdk = json(JSON.parse(rawSdk!)),
        issuer = json(JSON.parse(rawIssuer!));
      const origin = operation.originalOriginFile
        ? json(JSON.parse(await requireFile(operation.originalOriginFile))).origin
        : native.origin;
      for (const [key, value] of Object.entries(fixture.expectedOrigin))
        assert.deepEqual(json(origin)[key], value);
      assert.deepEqual(native.input, operation.input);
      const binding = json(issuer.binding);
      assert.equal(binding.operationId, operation.operationId);
      for (const key of [
        "recipientPrincipal",
        "appId",
        "buildId",
        "toolPath",
        "selectedAccountsDigest",
        "action",
      ])
        assert.deepEqual(binding[key], expectedTarget[key]);
      assert.equal(binding.recipientPrincipal, fixture.expectedPrincipal);
      assert.equal(issuer.status, operation.outcome);
      assert.equal(
        JSON.stringify(sdk).includes(reference!.trim()),
        false,
        "private reference must not enter SDK result",
      );
      const completed =
        sdk.ok === false
          ? undefined
          : json(
              typeof sdk.result === "string"
                ? JSON.parse(sdk.result)
                : (sdk.structuredContent ?? sdk.result),
            );
      const execution = completed === undefined ? { ok: false } : json(completed.execution);
      const call = execution.ok === true ? json(execution.value) : { ok: false };
      assert.equal(call.ok, operation.outcome === "observed");
      const journal = outcome(
        await connection.send("tools/call", {
          name: "call",
          arguments: {
            calls: {
              path: fixture.journalPath.replace(/\.journal$/, ".status"),
              input: { operationId: operation.operationId },
            },
          },
        }),
      );
      assert.equal(journal.ok, true);
      assert.equal(json(journal.value).outcome, operation.outcome);
      assert.equal(json(journal.value).digest, binding.inputDigest);
      const effects = json(await actualReadback(fixture.readback));
      assert.ok(Array.isArray(effects.effects));
      const matching = effects.effects.filter(
        (entry: unknown) => json(entry).operationId === operation.operationId,
      );
      assert.equal(matching.length, 1, "exactly one actual durable effect");
      const payload = json(json(matching[0]).payload);
      assert.deepEqual(payload.input, operation.input);
      assert.deepEqual(payload.origin, origin);
      assert.deepEqual(payload.binding, binding);
      assert.ok(
        typeof binding.expiresAt === "number" && Date.now() < binding.expiresAt,
        "replay check must use the still-unexpired genuine operation",
      );
      const replay = await connection.send(
        "tools/call",
        {
          name: "call",
          arguments: {
            calls: {
              path: fixture.protectedPath,
              input: operation.input,
            },
          },
        },
        reference!.trim(),
      );
      assert.equal(outcome(replay).ok, false, "used genuine reference must not dispatch twice");
      assert.equal(
        JSON.stringify(replay).includes(reference!.trim()),
        false,
        "private reference must not enter errors",
      );
      assert.deepEqual(
        await actualReadback(fixture.readback),
        effects,
        "replay cannot undo or duplicate a real effect",
      );
      reports.push({
        operationId: operation.operationId,
        outcome: operation.outcome,
        assertions: [
          "genuine-native-receipt",
          "actual-gateway-sdk",
          "current-principal-binding",
          "persistent-journal",
          "independent-mtls-effect",
          "no-duplicate-on-replay",
        ],
      });
    }
    await mkdir(evidencePath, { recursive: true, mode: 0o700 });
    await writeFile(
      resolve(evidencePath, "genuine-native-results.private.json"),
      JSON.stringify(
        {
          observedOperations: reports.length,
          reports,
          modelCalls: 0,
          allPairedRowsQualified: false,
          remaining: [
            "asserted-overlap",
            "full-denial-matrix",
            "owned-restart-and-revocation",
            "real-provider-trace",
            "old-host-compatibility",
          ],
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  } finally {
    await connection.close();
  }
}
/** The existing E2E entry now observes the actual Hermes SDK route, not a substitute HTTP positive. */
export const runPrivateConformance = observeNative;
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
    const support = process.argv.includes("--support-only");
    const native = process.argv.includes("--observe-native");
    if (support) await runLabSupport(fixture, evidence);
    else if (native) await observeNative(fixture, evidence);
    else await runPrivateConformance(fixture, evidence);
    process.stdout.write(
      support
        ? "Executed three real-process support checks; native acceptance remains unqualified\n"
        : "Executed one real external private invocation scenario; see private evidence\n",
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
