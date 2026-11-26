import { Effect, FileSystem, Schema } from "effect";
import { secret } from "../support/failure-text.ts";
import { randomBytes } from "node:crypto";
import { Target } from "../support/platform.ts";
import { startManagedServer } from "../support/managed-server.ts";
import { OriginUnreachable, ProvisioningFailure, ScenarioId } from "./contracts.ts";
import { platformSignatures } from "../platform-signatures.ts";
import { addStageOrigins } from "../support/lost-connections.ts";
import { targetHosts } from "../support/role-hosts.ts";

export class ScenarioPreparationFailed extends Schema.TaggedError<ScenarioPreparationFailed>()(
  "ScenarioPreparationFailed",
  {
    reason: Schema.Literals(["organization_unavailable", "domain_unavailable"]),
    unreachable: Schema.optional(OriginUnreachable),
    provisioning: Schema.optional(ProvisioningFailure),
  },
) {
  override get message() {
    if (this.reason === "organization_unavailable") {
      const failed = this.provisioning;
      if (failed === undefined || failed.failure === "TimeoutError")
        return "The scenario's organization and identities were not provisioned within the setup deadline";
      const where = [failed.stage, failed.transport]
        .filter((part) => part !== undefined)
        .join(", ");
      return `The scenario's organization and identities could not be provisioned: ${failed.request ?? "provisioning"} failed with ${failed.failure}${where === "" ? "" : ` (${where})`}${failed.elapsedMs === undefined ? "" : ` after ${failed.elapsedMs} ms`}`;
    }
    if (this.unreachable !== undefined) return unreachableText(this.unreachable);
    return "The scenario's HTTPS app origin did not answer, or was not reported ready, within the infrastructure deadline";
  }
}

const seconds = (milliseconds: number) => `${Math.round(milliseconds / 1000)} s`;

export const unreachableText = (unreachable: typeof OriginUnreachable.Type) => {
  const others =
    unreachable.slowestReadyMs === null
      ? `none of the run's ${unreachable.origins} app origins became ready`
      : `${unreachable.readyOrigins} of the run's ${unreachable.origins} app origins became ready, the slowest after ${seconds(unreachable.slowestReadyMs)}`;
  const coordinator =
    unreachable.certificate === undefined
      ? ""
      : ` The domain coordinator last saw its certificate ${unreachable.certificate}${unreachable.since === undefined ? "" : ` since ${unreachable.since}`}.`;
  return `${platformSignatures["origin-unreachable"]} (${unreachable.attempts} attempts in ${seconds(unreachable.waitedMs)}); ${others}.${coordinator}`;
};

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
      return yield* new ScenarioPreparationFailed({
        reason: prepared.status,
        ...(prepared.unreachable === undefined ? {} : { unreachable: prepared.unreachable }),
        ...(prepared.provisioning === undefined ? {} : { provisioning: prepared.provisioning }),
      });
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
      apiKey: secret(randomBytes(32).toString("hex")),
      scenarioId: id,
      scenarioLabel: label,
    });
  });

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
    const started = Target.of({
      ...target,
      controlOrigin: server.controlOrigin,
      metadata: { ...target.metadata, origin: server.origin },
    });
    addStageOrigins(Object.values(targetHosts(started)));
    return started;
  });
