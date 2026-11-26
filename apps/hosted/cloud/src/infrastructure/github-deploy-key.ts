import { createPublicKey } from "node:crypto";
import { Resource } from "alchemy";
import { isResolved } from "alchemy/Diff";
import { GitHubCredentials } from "alchemy/GitHub";
import { Octokit } from "alchemy/GitHub/Octokit";
import * as Provider from "alchemy/Provider";
import { Effect, Schema } from "effect";

export interface GitHubDeployKeyProps {
  readonly owner: string;
  readonly repository: string;
  readonly title: string;
  readonly publicKey: string;
  readonly readOnly: boolean;
}

export type GitHubDeployKey = Resource<
  "Executor.GitHubDeployKey",
  GitHubDeployKeyProps,
  {
    readonly keyId: number;
    readonly owner: string;
    readonly repository: string;
    readonly key: string;
    readonly readOnly: boolean;
  }
>;

export const GitHubDeployKey = Resource<GitHubDeployKey>("Executor.GitHubDeployKey");

class DeployKeyProvisioningFailed extends Schema.TaggedError<DeployKeyProvisioningFailed>()(
  "DeployKeyProvisioningFailed",
  { operation: Schema.String, message: Schema.String, status: Schema.optional(Schema.Number) },
) {}

const HttpFailure = Schema.Struct({ status: Schema.Number });

const Jwk = Schema.Struct({
  kty: Schema.Literal("EC"),
  crv: Schema.Literal("P-256"),
  x: Schema.String,
  y: Schema.String,
});

const openSshPublicKey = (pem: string) =>
  Effect.gen(function* () {
    const jwk = yield* Schema.decodeUnknownEffect(Jwk)(
      createPublicKey(pem).export({ format: "jwk" }),
    );
    const field = (bytes: Buffer) => {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(bytes.length);
      return Buffer.concat([length, bytes]);
    };
    const point = Buffer.concat([
      Buffer.from([4]),
      Buffer.from(jwk.x, "base64url"),
      Buffer.from(jwk.y, "base64url"),
    ]);
    const blob = Buffer.concat([
      field(Buffer.from("ecdsa-sha2-nistp256")),
      field(Buffer.from("nistp256")),
      field(point),
    ]);
    return `ecdsa-sha2-nistp256 ${blob.toString("base64")}`;
  }).pipe(
    Effect.mapError(
      () =>
        new DeployKeyProvisioningFailed({
          operation: "encode public key",
          message: "The deploy key's public key must be a P-256 PEM spki key.",
        }),
    ),
  );

export const gitHubDeployKeyProvider = () =>
  Provider.effect(
    GitHubDeployKey,
    Effect.gen(function* () {
      const credentials = yield* GitHubCredentials;
      const request = <A>(
        operation: string,
        call: (octokit: Effect.Success<typeof Octokit>) => Promise<A>,
      ) =>
        Octokit.pipe(
          Effect.provideService(GitHubCredentials, credentials),
          Effect.flatMap((octokit) =>
            Effect.tryPromise({
              try: () => call(octokit),
              catch: (error) =>
                new DeployKeyProvisioningFailed({
                  operation,
                  message: error instanceof Error ? error.message : String(error),
                  status: Schema.is(HttpFailure)(error) ? error.status : undefined,
                }),
            }),
          ),
        );
      const notFound = (error: DeployKeyProvisioningFailed) => error.status === 404;

      return {
        stables: ["keyId"],
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news) || olds === undefined) return undefined;
          return news.owner !== olds.owner ||
            news.repository !== olds.repository ||
            news.title !== olds.title ||
            news.publicKey !== olds.publicKey ||
            news.readOnly !== olds.readOnly
            ? { action: "replace" as const }
            : undefined;
        }),
        read: Effect.fn(function* ({ output }) {
          if (output === undefined) return undefined;
          const found = yield* request("read deploy key", (octokit) =>
            octokit.rest.repos.getDeployKey({
              owner: output.owner,
              repo: output.repository,
              key_id: output.keyId,
            }),
          ).pipe(
            Effect.map(({ data }) => data),
            Effect.catchIf(notFound, () => Effect.succeed(undefined)),
          );
          if (found === undefined) return undefined;
          return { ...output, key: found.key, readOnly: found.read_only };
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          const key = yield* openSshPublicKey(news.publicKey);
          if (output !== undefined) {
            const existing = yield* request("read deploy key", (octokit) =>
              octokit.rest.repos.getDeployKey({
                owner: output.owner,
                repo: output.repository,
                key_id: output.keyId,
              }),
            ).pipe(
              Effect.map(({ data }) => data),
              Effect.catchIf(notFound, () => Effect.succeed(undefined)),
            );
            if (
              existing !== undefined &&
              existing.key === key &&
              existing.read_only === news.readOnly
            )
              return output;
          }
          const { data } = yield* request("add deploy key", (octokit) =>
            octokit.rest.repos.createDeployKey({
              owner: news.owner,
              repo: news.repository,
              title: news.title,
              key,
              read_only: news.readOnly,
            }),
          );
          return {
            keyId: data.id,
            owner: news.owner,
            repository: news.repository,
            key: data.key,
            readOnly: data.read_only,
          };
        }),
        delete: ({ output }) =>
          request("remove deploy key", (octokit) =>
            octokit.rest.repos.deleteDeployKey({
              owner: output.owner,
              repo: output.repository,
              key_id: output.keyId,
            }),
          ).pipe(
            Effect.catchIf(notFound, () => Effect.void),
            Effect.asVoid,
          ),
      };
    }),
  );
