import { Effect } from "effect";
import type {
  AccountAcquisitionBinding,
  AccountAcquisitionHost,
  AccountAcquisitionSource,
} from "../contracts/account-acquisition-driver.ts";
import type { StoredAccount } from "../contracts/storage.ts";

export type DriverAccount = Pick<
  StoredAccount,
  "id" | "owner" | "provider" | "method" | "credentialGeneration"
>;
export type AccountDriverResolver = Pick<AccountAcquisitionHost, "binding" | "source">;

export const driverBindingMatches = (binding: AccountAcquisitionBinding, account: DriverAccount) =>
  binding.account === account.id &&
  binding.owner === account.owner &&
  binding.provider === account.provider &&
  binding.method === account.method &&
  binding.generation === account.credentialGeneration;

export const retainedDriverBinding = (
  resolver: AccountDriverResolver | undefined,
  account: DriverAccount,
) =>
  resolver === undefined
    ? Effect.succeed(undefined)
    : resolver
        .binding({
          account: account.id,
          owner: account.owner,
        })
        .pipe(
          Effect.map((binding) =>
            binding !== undefined && driverBindingMatches(binding, account) ? binding : undefined,
          ),
        );

/** Run only within the transaction that claims or writes the result, using its Query context. */
export const driverSourceCurrent = (source: AccountAcquisitionSource, account: DriverAccount) =>
  source.current.pipe(
    Effect.map(
      (binding) =>
        binding.removal === null &&
        driverBindingMatches(binding, account) &&
        binding.driver === source.binding.driver &&
        binding.driverRevision === source.binding.driverRevision &&
        binding.revision === source.binding.revision &&
        source.source.kind === "driver" &&
        source.source.id === binding.driver &&
        source.source.version === binding.driverRevision,
    ),
    Effect.catchTags({
      AccountNotFound: () => Effect.succeed(false),
      AccountAcquisitionUnavailable: () => Effect.succeed(false),
    }),
  );
