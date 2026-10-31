import { resolve } from "node:path";
import { createBindings, propertyName, unwrapExpression, walkAst } from "./ast.mjs";

import { ruleMeta } from "./rule-meta.mjs";
import { noLegacyAccountsRule } from "./legacy-accounts.mjs";
import { noGlobalFetchRule } from "./global-fetch.mjs";
import { plainFrameworkBindingsRule } from "./plain-framework-bindings.mjs";

const defaultAppExport = {
  meta: {
    ...ruleMeta("Require the resolved root app module to default-export `defineApp` from `apps`."),
    schema: [
      {
        type: "object",
        properties: { entryFile: { type: "string" } },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const entryFile = context.options[0]?.entryFile;
    if (entryFile && resolve(context.cwd, context.filename) !== resolve(context.cwd, entryFile))
      return {};
    return {
      Program(program) {
        const exported = program.body.find((node) => node.type === "ExportDefaultDeclaration");
        const value = unwrapExpression(exported?.declaration);
        if (
          value?.type !== "CallExpression" ||
          createBindings(context).resolveSymbol(value.callee) !== "defineApp"
        ) {
          context.report({ node: exported?.declaration ?? program, messageId: "defaultApp" });
        }
      },
    };
  },
};

function objectPropertyName(property) {
  return propertyName(property.key, property.computed);
}

function analyzeMutationOptions(expression, bindings, seen = new Set()) {
  const node = unwrapExpression(expression);
  if (node?.type === "ObjectExpression") {
    let state = { kind: "missing", node };
    for (const property of node.properties ?? []) {
      if (property.type === "SpreadElement") {
        const result = analyzeMutationOptions(property.argument, bindings, seen);
        if (result.kind !== "missing") state = result;
      } else if (["ObjectProperty", "Property", "ObjectMethod"].includes(property.type)) {
        const name = objectPropertyName(property);
        if (name === "approval") state = { kind: "explicit", node: property };
        else if (property.computed && name === undefined)
          state = { kind: "unknown", node: property };
      }
    }
    return state;
  }
  if (node?.type !== "Identifier") return { kind: "unknown", node };
  const variable = bindings.variableOf(node);
  if (!variable || seen.has(variable)) return { kind: "unknown", node };
  const initializer = bindings.localInitializer(variable);
  if (!initializer) return { kind: "unknown", node };
  seen.add(variable);
  const result = analyzeMutationOptions(initializer, bindings, seen);
  seen.delete(variable);
  return result;
}

const mutationApproval = {
  meta: ruleMeta("Require explicit approval ownership on every imported `mutation` call."),
  create(context) {
    return {
      Program(program) {
        const bindings = createBindings(context);
        walkAst(program, (node) => {
          if (node.type !== "CallExpression") return;
          const symbol = bindings.resolveSymbol(node.callee);
          if (symbol !== "mutation") return;
          const options = analyzeMutationOptions(node.arguments?.[0], bindings);
          if (options.kind !== "explicit") {
            context.report({
              node: node.arguments?.[0] ?? node.callee,
              messageId: options.kind === "unknown" ? "unknownApproval" : "missingApproval",
            });
          }
        });
      },
    };
  },
};

export default {
  meta: { name: "executor-apps" },
  rules: {
    "plain-framework-bindings": plainFrameworkBindingsRule,
    "default-app-export": defaultAppExport,
    "no-legacy-accounts": noLegacyAccountsRule,
    "mutation-approval": mutationApproval,
    "no-global-fetch": noGlobalFetchRule,
  },
};
