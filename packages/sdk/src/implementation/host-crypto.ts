import { Effect } from "effect";
import { Digest, SecureRandom } from "effect/crypto";

export type HostCrypto = {
  readonly random: SecureRandom.SecureRandom["Service"];
  readonly digest: Digest.Digest["Service"];
};

export const hostCrypto: Effect.Effect<
  HostCrypto,
  never,
  SecureRandom.SecureRandom | Digest.Digest
> = Effect.all({ random: SecureRandom.SecureRandom, digest: Digest.Digest });
