import type { QueryContext, WebhookContext } from "apps";
import { github, gmail } from "./providers.ts";

/** Shared requirements contain declarations, never selected credentials. */
export const requirements = { accounts: { github, gmail } };
/** The same account shape with interactive query capabilities. */
export type QueryCtx = QueryContext<typeof requirements>;
/** Webhook handlers cannot request interactive input. */
export type WebhookCtx = WebhookContext<typeof requirements>;
