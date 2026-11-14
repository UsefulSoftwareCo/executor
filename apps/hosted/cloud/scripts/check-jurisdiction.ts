/**
 * Cloud keeps Durable Object and R2 data in the jurisdiction `CLOUD_JURISDICTION` names
 * (`src/infrastructure/jurisdiction.ts`). A namespace reached any other way is the default one: it
 * holds other objects than its callers expect, and its IDs never equal the jurisdiction's. Local
 * workerd does not implement jurisdictions, so no local Cloud can run with one; this check keeps
 * every use on the seam instead. It fails when:
 *
 * - a Durable Object class is used other than hosted (`.make`) or through `inJurisdiction`;
 * - a namespace binding is read from the Worker environment other than through `durableNamespace`;
 * - an R2 bucket this stack declares does not take `bucketJurisdiction`, or a bucket is bound by
 *   name without a jurisdiction, other than the buckets listed in `foreignBuckets`;
 * - with the setting on, a handle or namespace from the seam addresses anything but the
 *   jurisdiction's namespace, or a bucket lacks it; with it unset, anything differs from the plain
 *   binding and bucket; or an unsupported value deploys.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import { ConfigProvider, Effect, Exit } from "effect";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript-5";
import {
  bucketJurisdiction,
  durableNamespace,
  inJurisdiction,
} from "../src/infrastructure/jurisdiction.ts";

const root = join(import.meta.dirname, "..");
const seam = "src/infrastructure/jurisdiction.ts";

/** Buckets another stack owns, in the jurisdiction it chose; this stack only binds them by name. */
const foreignBuckets: Record<string, string> = {
  "src/infrastructure/v1-blobs.ts": "v1's blob bucket, read only by production's v1 import",
};

const failures: string[] = [];

const sources = [
  ...readdirSync(root).filter((name) => name.endsWith(".ts")),
  ...readdirSync(join(root, "src"), { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join("src", name)),
].map((path) => {
  const text = readFileSync(join(root, path), "utf8");
  return { path, file: ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true) };
});

const walk = (node: ts.Node, visit: (node: ts.Node) => void) => {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
};

const at = (file: ts.SourceFile, node: ts.Node) =>
  `${relative(join(root, "../../.."), join(root, file.fileName))}:${
    file.getLineAndCharacterOfPosition(node.getStart()).line + 1
  }`;

// Durable Object classes, by class name, with the binding name Alchemy gives their namespace.
const classes = new Map<string, string>();
for (const { file } of sources)
  walk(file, (node) => {
    if (!ts.isClassDeclaration(node) || node.name === undefined) return;
    const base = node.heritageClauses?.[0]?.types[0]?.expression;
    if (
      base === undefined ||
      !ts.isCallExpression(base) ||
      !base.expression.getText(file).startsWith("Cloudflare.DurableObject<")
    )
      return;
    const binding = base.arguments[0];
    if (binding === undefined || !ts.isStringLiteral(binding))
      failures.push(`${at(file, node)}: ${node.name.text} must name its binding with a literal.`);
    else classes.set(node.name.text, binding.text);
  });
const bindings = new Set(classes.values());
if (classes.size === 0) failures.push("Found no Durable Object classes; the check is stale.");

const isTypePosition = (node: ts.Node) => {
  for (let current = node.parent; current !== undefined; current = current.parent)
    if (ts.isTypeNode(current) && !ts.isExpressionWithTypeArguments(current)) return true;
  return false;
};
const callsSeam = (node: ts.Node, name: string) =>
  ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name;

for (const { path, file } of sources)
  walk(file, (node) => {
    // A class is hosted (`X.make`), or addressed only through the seam: `inJurisdiction(X)` or
    // `inJurisdiction(X.from(Worker))`.
    if (ts.isIdentifier(node) && classes.has(node.text) && !isTypePosition(node)) {
      const parent = node.parent;
      const declared =
        (ts.isClassDeclaration(parent) && parent.name === node) ||
        // A property of that name, such as the binding itself, is not the class.
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        ts.isImportSpecifier(parent) ||
        ts.isExportSpecifier(parent);
      const member = ts.isPropertyAccessExpression(parent) && parent.expression === node;
      const hosted = member && parent.name.text === "make";
      const wrapped =
        callsSeam(parent, "inJurisdiction") ||
        (member &&
          parent.name.text === "from" &&
          ts.isCallExpression(parent.parent) &&
          callsSeam(parent.parent.parent, "inJurisdiction"));
      if (!declared && !hosted && !wrapped)
        failures.push(
          `${at(file, node)}: reach ${node.text} through inJurisdiction(...), which applies CLOUD_JURISDICTION.`,
        );
    }
    // A namespace binding is read from the environment only by the seam.
    if (path !== seam) {
      const name = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)
          ? node.argumentExpression.text
          : undefined;
      if (name !== undefined && bindings.has(name))
        failures.push(
          `${at(file, node)}: read the ${name} namespace with durableNamespace("${name}"), which applies CLOUD_JURISDICTION.`,
        );
    }
    if (callsSeam(node, "durableNamespace") && ts.isCallExpression(node)) {
      const binding = node.arguments[0];
      if (binding === undefined || !ts.isStringLiteral(binding) || !bindings.has(binding.text))
        failures.push(`${at(file, node)}: durableNamespace needs a Durable Object binding name.`);
    }
    // Every bucket this stack declares takes the jurisdiction; its binding follows the bucket.
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(file) === "Cloudflare.R2.Bucket" &&
      !node.arguments.some((argument) => argument.getText(file).includes("bucketJurisdiction"))
    )
      failures.push(`${at(file, node)}: give the bucket bucketJurisdiction's props.`);
    // A bucket bound by name carries no jurisdiction from a declaration.
    if (
      ts.isObjectLiteralExpression(node) &&
      node.properties.some(
        (property) =>
          ts.isPropertyAssignment(property) &&
          property.name.getText(file) === "type" &&
          ts.isStringLiteral(property.initializer) &&
          property.initializer.text === "r2_bucket",
      ) &&
      !node.properties.some((property) => property.name?.getText(file) === "jurisdiction") &&
      foreignBuckets[path] === undefined
    )
      failures.push(`${at(file, node)}: a bucket bound by name needs the configured jurisdiction.`);
  });

// The seam itself, against a namespace that records which jurisdiction each call reached.
type Id = { readonly at: string; readonly name: string; equals(other: Id): boolean };
const recorded: string[] = [];
const namespace = (at: string) => {
  const id = (name: string): Id => ({
    at,
    name,
    equals: (other) => other.at === at && other.name === name,
  });
  const stub = { fetch: () => Promise.resolve(new Response(null)) };
  const note = (call: string) => recorded.push(`${call}@${at}`);
  return {
    jurisdiction: (jurisdiction: string) => namespace(`${at}/${jurisdiction}`),
    idFromName: (name: string) => (note("idFromName"), id(name)),
    idFromString: (value: string) => (note("idFromString"), id(value)),
    newUniqueId: () => (note("newUniqueId"), id(crypto.randomUUID())),
    get: () => (note("get"), stub),
    getByName: () => (note("getByName"), stub),
  };
};
const plain = {
  name: "Probe",
  getByName: () => (recorded.push("handle.getByName@Probe"), {}),
} as unknown as Cloudflare.DurableObject<unknown>;

const evaluate = (configured: string | undefined) => {
  recorded.length = 0;
  const env = configured === undefined ? {} : { CLOUD_JURISDICTION: configured };
  return Effect.runSyncExit(
    Effect.gen(function* () {
      const native = yield* yield* durableNamespace("Probe");
      const named = native.idFromName("object");
      native.get(native.idFromString("object"));
      native.getByName("object");
      native.newUniqueId();
      const handle = yield* inJurisdiction(Effect.succeed(plain));
      handle.getByName("object");
      return {
        same: handle === plain,
        equal: named.equals(native.idFromName("object") as never),
        bucket: yield* bucketJurisdiction,
        calls: [...recorded],
      };
    }).pipe(
      Effect.provideService(Cloudflare.WorkerEnvironment, { Probe: namespace("Probe") }),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
    ),
  );
};

// GitHub Actions passes an unset variable as an empty string.
for (const configured of [undefined, "", "eu", "fedramp"]) {
  const exit = evaluate(configured);
  const label = `CLOUD_JURISDICTION=${configured === undefined ? "<unset>" : JSON.stringify(configured)}`;
  const jurisdiction = configured === "" ? undefined : configured;
  if (Exit.isFailure(exit)) {
    failures.push(`${label} failed: ${exit.cause}`);
    continue;
  }
  const { same, equal, bucket, calls } = exit.value;
  const expected = jurisdiction === undefined ? "Probe" : `Probe/${jurisdiction}`;
  const stray = calls.filter((call) => !call.endsWith(`@${expected}`));
  if (stray.length > 0 || calls.length !== 7)
    failures.push(`${label}: calls reached ${calls.join(", ")}, not only ${expected}.`);
  if (!equal) failures.push(`${label}: an object's ID does not equal its own name's.`);
  if (jurisdiction === undefined && !same)
    failures.push(`${label}: the handle must stay Alchemy's own.`);
  if (jurisdiction === undefined && calls.includes("handle.getByName@Probe") === false)
    failures.push(`${label}: the handle did not address the plain namespace.`);
  if (JSON.stringify(bucket) !== JSON.stringify(jurisdiction === undefined ? {} : { jurisdiction }))
    failures.push(`${label}: buckets get ${JSON.stringify(bucket)}.`);
}
for (const unsupported of ["us", "fedramp-high", "EU"])
  if (Exit.isSuccess(evaluate(unsupported)))
    failures.push(`CLOUD_JURISDICTION=${JSON.stringify(unsupported)} must stop the deploy.`);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(
  `Jurisdiction: ${classes.size} Durable Object classes and every bucket reach CLOUD_JURISDICTION.`,
);
