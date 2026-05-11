import fs from "node:fs";
import path from "node:path";

import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.js";

const schemaClassExportCache = new Map();

const message =
  "Use a structural Schema.Struct for HttpApiEndpoint payloads; construct Schema.Class values inside handlers after decoding.";

const SCHEMA_CLASS_PATTERN =
  /export\s+class\s+([A-Za-z_$][\w$]*)\s+extends\s+Schema\.(?:Class|TaggedClass|ErrorClass|TaggedErrorClass)\b/g;

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow Schema.Class-backed schemas as HttpApiEndpoint payload schemas.",
    },
  },
  create(context) {
    const schemaClassNames = new Set();

    const addImportedSchemaClasses = (node) => {
      const specifier = node.source.value;
      if (typeof specifier !== "string" || !specifier.startsWith(".")) return;

      const exportedClassNames = readSchemaClassExports(context.filename, specifier);
      if (exportedClassNames.size === 0) return;

      for (const imported of node.specifiers ?? []) {
        if (imported.type !== "ImportSpecifier") continue;
        const importedName = getPropertyName(imported.imported);
        const localName = imported.local?.name;
        if (importedName && localName && exportedClassNames.has(importedName)) {
          schemaClassNames.add(localName);
        }
      }
    };

    return {
      ImportDeclaration: addImportedSchemaClasses,

      ClassDeclaration(node) {
        if (!node.id?.name || !isSchemaClassExtends(node.superClass)) return;
        schemaClassNames.add(node.id.name);
      },

      CallExpression(node) {
        if (!isHttpApiEndpointCall(node.callee)) return;

        for (const arg of node.arguments ?? []) {
          const payload = getObjectPropertyValue(arg, "payload");
          if (!payload || !isSchemaClassPayload(payload, schemaClassNames)) continue;

          context.report({
            node: payload,
            message,
          });
        }
      },
    };
  },
};

function isHttpApiEndpointCall(callee) {
  const expression = unwrapExpression(callee);
  if (expression?.type !== "MemberExpression") return false;
  return isIdentifier(unwrapExpression(expression.object), "HttpApiEndpoint");
}

function getObjectPropertyValue(node, name) {
  const expression = unwrapExpression(node);
  if (expression?.type !== "ObjectExpression") return undefined;

  for (const property of expression.properties ?? []) {
    if (property.type === "SpreadElement") continue;
    if (getPropertyName(property.key) === name) return unwrapExpression(property.value);
  }
  return undefined;
}

function isSchemaClassPayload(node, schemaClassNames) {
  const expression = unwrapExpression(node);
  if (isIdentifier(expression) && schemaClassNames.has(expression.name)) return true;
  return isSchemaClassCall(expression);
}

function isSchemaClassExtends(node) {
  const expression = unwrapExpression(node);
  return isSchemaClassCall(expression);
}

function isSchemaClassCall(node) {
  const expression = unwrapExpression(node);
  if (expression?.type !== "CallExpression") return false;

  let callee = unwrapExpression(expression.callee);
  while (callee?.type === "CallExpression") {
    callee = unwrapExpression(callee.callee);
  }

  if (callee?.type !== "MemberExpression") return false;
  if (!isIdentifier(unwrapExpression(callee.object), "Schema")) return false;
  const method = getPropertyName(callee.property);
  return (
    method === "Class" ||
    method === "TaggedClass" ||
    method === "ErrorClass" ||
    method === "TaggedErrorClass"
  );
}

function readSchemaClassExports(filename, specifier) {
  const resolved = resolveImport(filename, specifier);
  if (!resolved) return new Set();
  if (schemaClassExportCache.has(resolved)) return schemaClassExportCache.get(resolved);

  const source = fs.readFileSync(resolved, "utf8");
  const names = new Set();
  for (const match of source.matchAll(SCHEMA_CLASS_PATTERN)) {
    names.add(match[1]);
  }
  schemaClassExportCache.set(resolved, names);
  return names;
}

function resolveImport(filename, specifier) {
  const base = path.resolve(path.dirname(filename), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
    path.join(base, "index.js"),
  ];
  return candidates.find(
    (candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile(),
  );
}
