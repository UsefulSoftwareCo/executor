const messages = {
  defaultApp:
    "Use `export default defineApp(...)` directly, with `defineApp` imported from `apps` by a named import.",
  legacyRequirements:
    "Legacy top-level `accounts` requirements are unsupported; declare accounts under `user` or `app`.",
  legacyContext:
    "Read accounts through `ctx.user.accounts` or `ctx.app.accounts`, not directly from framework context.",
  missingApproval:
    "Every `mutation` must explicitly declare `approval`; use `approval: undefined` for an explicit no-approval choice.",
  unknownApproval:
    "Cannot prove this mutation's `approval`; use a local const options object with an explicit `approval` property.",
};

export function ruleMeta(description) {
  return { type: "problem", docs: { description }, schema: [], messages };
}
