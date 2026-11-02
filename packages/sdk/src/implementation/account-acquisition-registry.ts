import { Effect } from "effect";
import { AccountAcquisitionUnavailable } from "../contracts/account-acquisition-driver.ts";
import type {
  AccountAcquisitionBinding,
  AccountAcquisitionRegistration,
} from "../contracts/account-acquisition-driver.ts";
import type { ProviderId } from "../contracts/shared.ts";

const key = (...values: readonly string[]) => JSON.stringify(values);

/** Exact retained revisions resolve saved work; only one revision may accept new work per method. */
export const makeAcquisitionRegistry = (
  registrations: readonly AccountAcquisitionRegistration[],
) => {
  const retained = new Map<string, AccountAcquisitionRegistration>();
  const current = new Map<string, AccountAcquisitionRegistration>();
  for (const registration of registrations) {
    const { driver, provider, method } = registration;
    const revisionKey = key(driver.id, driver.revision, provider, method);
    const methodKey = key(provider, method);
    if (
      !driver.id.trim() ||
      !driver.revision.trim() ||
      !method.trim() ||
      driver.id.length > 255 ||
      driver.revision.length > 255 ||
      retained.has(revisionKey) ||
      (registration.current && current.has(methodKey))
    )
      return Effect.fail(new AccountAcquisitionUnavailable({ reason: "registration" }));
    retained.set(revisionKey, registration);
    if (registration.current) current.set(methodKey, registration);
  }
  return Effect.succeed({
    current: (provider: ProviderId, method: string) => current.get(key(provider, method)),
    retained: (
      binding: Pick<AccountAcquisitionBinding, "driver" | "driverRevision" | "provider" | "method">,
    ) => {
      const registration = retained.get(
        key(binding.driver, binding.driverRevision, binding.provider, binding.method),
      );
      return registration === undefined
        ? Effect.fail(new AccountAcquisitionUnavailable({ reason: "registration" }))
        : Effect.succeed(registration);
    },
  });
};

export type AcquisitionRegistry = Effect.Success<ReturnType<typeof makeAcquisitionRegistry>>;
