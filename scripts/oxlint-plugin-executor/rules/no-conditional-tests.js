import { getCallName, isTestLike } from "../utils.js";

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow conditional expect calls inside tests.",
    },
  },
  create(context) {
    if (!isTestLike(context.filename)) return {};

    let conditionalDepth = 0;

    const enterConditional = () => {
      conditionalDepth++;
    };
    const exitConditional = () => {
      conditionalDepth--;
    };

    return {
      CallExpression(node) {
        if (conditionalDepth === 0) return;
        const name = getCallName(node.callee);
        if (name !== "expect") return;
        context.report({
          node,
          message:
            "Avoid conditional expect calls; split the test or assert both branches explicitly. Skill: wrdn-effect-vitest-tests.",
        });
      },
      IfStatement: enterConditional,
      "IfStatement:exit": exitConditional,
      ConditionalExpression: enterConditional,
      "ConditionalExpression:exit": exitConditional,
      LogicalExpression: enterConditional,
      "LogicalExpression:exit": exitConditional,
      SwitchCase: enterConditional,
      "SwitchCase:exit": exitConditional,
    };
  },
};
