import { isIdentifier } from "../utils.js";

const message =
  "Do not use Match.orElse as a catch-all fallback. End the Match chain with Match.exhaustive (or Match.option / Match.orElseAbsurd when partiality is intentional) so unmatched cases fail at compile time.";

const isMatchOrElse = (node) =>
  node?.type === "MemberExpression" &&
  isIdentifier(node.object, "Match") &&
  isIdentifier(node.property, "orElse");

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow Match.orElse fallbacks; use exhaustive matchers.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (isMatchOrElse(node.callee)) {
          context.report({ node, message });
        }
      },
    };
  },
};
