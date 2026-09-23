import assert from "node:assert/strict";
import { test } from "node:test";
import { isAlchemyWorkerPlaceholder } from "../src/infrastructure/test-stage-cleanup-providers.ts";

test("partial deployment cleanup recognizes only an empty Alchemy Worker", () => {
  const empty =
    'export default { fetch() { return new Response("Alchemy worker is being deployed...") } };\n';
  assert.equal(isAlchemyWorkerPlaceholder(empty), true);
  assert.equal(
    isAlchemyWorkerPlaceholder(
      'import { DurableObject } from "cloudflare:workers";\n\n' +
        empty +
        "export class AppDomainCoordinator extends DurableObject {}\n" +
        "export class ScheduleCoordinator extends DurableObject {}",
    ),
    true,
  );
  assert.equal(isAlchemyWorkerPlaceholder(empty + "runApplication();"), false);
  assert.equal(isAlchemyWorkerPlaceholder("// " + empty), false);
  assert.equal(
    isAlchemyWorkerPlaceholder(
      empty + "export class AppDomainCoordinator extends DurableObject { alarm() {} }",
    ),
    false,
  );
});
