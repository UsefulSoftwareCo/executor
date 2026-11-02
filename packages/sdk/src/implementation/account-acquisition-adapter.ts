import { Effect } from "effect";
import type { AccountCheckResult, InteractiveStart, InteractiveStatus } from "apps/contracts";
import type {
  AccountAcquisitionAccountContext,
  AccountAcquisitionContext,
  AccountAcquisitionDriver,
} from "../contracts/account-acquisition-driver.ts";

/** Promise callbacks for hosts whose credential backend is authored outside Effect. */
export interface PromiseAccountAcquisitionDriver<
  Context extends AccountAcquisitionAccountContext = AccountAcquisitionAccountContext,
> {
  readonly id: string;
  readonly revision: string;
  readonly start: (
    context: AccountAcquisitionContext,
    reconnect?: Context,
  ) => Promise<InteractiveStart>;
  readonly status: (
    context: AccountAcquisitionContext,
    input: { readonly session: string },
  ) => Promise<InteractiveStatus>;
  readonly submit?: (
    context: AccountAcquisitionContext,
    input: { readonly session: string; readonly value: string },
  ) => Promise<InteractiveStatus>;
  readonly cancel: (
    context: AccountAcquisitionContext,
    input: { readonly session: string },
  ) => Promise<void>;
  readonly remove: (context: Context) => Promise<void>;
  readonly check?: (context: Context) => Promise<AccountCheckResult | void>;
}

const callback = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (error) => error });

/** The host owns callback lifetime and aborts the supplied context signal when it ends. */
export const accountAcquisitionDriver = <Context extends AccountAcquisitionAccountContext>(
  driver: PromiseAccountAcquisitionDriver<Context>,
): AccountAcquisitionDriver<Context> => {
  const { submit, check } = driver;
  return {
    id: driver.id,
    revision: driver.revision,
    start: (context, reconnect) => callback(() => driver.start(context, reconnect)),
    status: (context, input) => callback(() => driver.status(context, input)),
    cancel: (context, input) => callback(() => driver.cancel(context, input)),
    remove: (context) => callback(() => driver.remove(context)),
    ...(submit === undefined
      ? {}
      : {
          submit: (context: AccountAcquisitionContext, input: Parameters<typeof submit>[1]) =>
            callback(() => submit(context, input)),
        }),
    ...(check === undefined ? {} : { check: (context: Context) => callback(() => check(context)) }),
  };
};
