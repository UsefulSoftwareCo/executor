/** Scenario lifetimes are shared by committed tests and interactive CLI sessions. */
import { Effect, FileSystem, Redacted, Schema } from "effect";
import { randomBytes } from "node:crypto";
import { Target } from "../support/platform.ts";
import { startManagedServer } from "../support/managed-server.ts";
import { ScenarioId } from "./contracts.ts";

/** A prerequisite failed within its own deadline, before scenario work could start. */
export class ScenarioPreparationFailed extends Schema.TaggedError<ScenarioPreparationFailed>()(
  "ScenarioPreparationFailed",
  { reason: Schema.Literals(["organization_unavailable", "domain_unavailable"]) },
) {
  override get message() {
    return this.reason === "organization_unavailable"
      ? "The scenario's organization and identities were not provisioned within the setup deadline"
      : "The scenario's HTTPS app origin was not ready within the infrastructure deadline";
  }
}

/** Allocate isolated evidence and identity before the caller starts its product lifecycle. */
export const prepareScenario = (
  base: typeof Target.Service,
  label: string,
  id = base.preparedScenarios?.[label]?.id ?? randomBytes(16).toString("hex"),
) =>
  Effect.gen(function* () {
    yield* Schema.decodeUnknownEffect(ScenarioId)(id);
    yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(label);
    const prepared = base.preparedScenarios?.[label];
    if (prepared?.id === id && prepared.status !== "ready")
      return yield* new ScenarioPreparationFailed({ reason: prepared.status });
    const fs = yield* FileSystem.FileSystem;
    if (base.metadata.target === "cloud")
      return Target.of({ ...base, scenarioId: id, scenarioLabel: label });
    const directory = `${base.directory}/scenarios/${id}`;
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    return Target.of({
      ...base,
      directory,
      evidenceDirectory: base.evidenceDirectory ?? base.directory,
      metadata: { ...base.metadata, origin: "http://127.0.0.1:0" },
      apiKey: Redacted.make(randomBytes(32).toString("hex")),
      scenarioId: id,
      scenarioLabel: label,
    });
  });

/** Start an isolated product instance for single-organization hosts, or namespace a shared Cloud stage. */
export const startScenario = (
  base: typeof Target.Service,
  label: string,
  id?: string,
  environment?: Readonly<Record<string, string>>,
) =>
  Effect.gen(function* () {
    const target = yield* prepareScenario(base, label, id);
    if (base.metadata.target === "cloud") return target;
    const server = yield* startManagedServer(target, "product", environment);
    return Target.of({
      ...target,
      controlOrigin: server.controlOrigin,
      ...(server.tlsCertificate === undefined ? {} : { tlsCertificate: server.tlsCertificate }),
      metadata: { ...target.metadata, origin: server.origin },
    });
  });
