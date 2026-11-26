import { Array as Arr, Effect, Option } from "effect";
import type { Executor } from "../contracts/executor.ts";
import {
  packageLabel,
  packageScope,
  publishingDomain,
  type PackageName,
  type Publication,
  type PublicationReadiness,
  RegistryError,
} from "../contracts/registry.ts";

const revisionZeroPackageName = /^@[a-z0-9][a-z0-9-]{0,79}\/[a-z0-9][a-z0-9-]{0,62}$/u;
const publishingSuffix = `.${publishingDomain}`;

const revisionZeroName = (name: PackageName): Option.Option<PackageName> => {
  const scope = packageScope(name);
  const read = scope.endsWith(publishingSuffix)
    ? `@${scope.slice(0, -publishingSuffix.length)}/${packageLabel(name)}`
    : name;
  return revisionZeroPackageName.test(read) ? Option.some(read) : Option.none();
};
export const scopedNameFor = (name: PackageName): Option.Option<PackageName> =>
  revisionZeroPackageName.test(name)
    ? Option.some(`@${packageScope(name)}${publishingSuffix}/${packageLabel(name)}`)
    : Option.none();
const namesReadAs = (name: PackageName): ReadonlyArray<PackageName> => [
  name,
  ...Option.toArray(scopedNameFor(name)),
];
const readable = (publication: Publication) =>
  Option.map(revisionZeroName(publication.name), (name) => ({ ...publication, name }));
const leftOut = (count: number) =>
  count > 0
    ? Effect.annotateCurrentSpan("registry.listings_unreadable_by_client", count)
    : Effect.void;

const answersFor = (registry: Executor["registry"], name: PackageName) =>
  Effect.forEach(
    namesReadAs(name),
    (candidate) =>
      registry.list({ name: candidate }).pipe(
        Effect.map((all) => Option.some(all.filter((listing) => listing.name === candidate))),
        Effect.catchTag("RegistryError", (error) =>
          error.reason === "not-found" ? Effect.succeedNone : Effect.fail(error),
        ),
      ),
    { concurrency: "unbounded" },
  );
const publishedAs = (registry: Executor["registry"], name: PackageName) =>
  Effect.map(answersFor(registry, name), (answers) => Arr.getSomes(answers).flat());

const selected = (registry: Executor["registry"], name: PackageName) =>
  Effect.gen(function* () {
    const answers = yield* answersFor(registry, name);
    const found = Arr.getSomes(answers).flat();
    if (found.length === 0 && Option.isNone(Option.flatten(Arr.head(answers))))
      return Option.none<ReadonlyArray<Publication>>();
    const names = Arr.dedupe(found.map((listing) => listing.name));
    if (names.length > 1) {
      yield* Effect.annotateCurrentSpan("registry.ambiguous_for_client", true);
      yield* Effect.logWarning(
        `Refused ${name} for an Executor release up to 2.0.0-beta.15: the public listings ${names.join(" and ")} both read as that name there.`,
      );
      return yield* new RegistryError({ reason: "conflict" });
    }
    return Option.some(found);
  });
const selectedName = (registry: Executor["registry"], name: PackageName) =>
  Effect.map(selected(registry, name), (found) =>
    Option.match(Option.flatMap(found, Arr.head), {
      onNone: () => name,
      onSome: (listing) => listing.name,
    }),
  );

export const packageNameFromRevision = (
  registry: Executor["registry"],
  revision: number,
  name: PackageName,
) => (revision >= 1 ? Effect.succeed(name) : selectedName(registry, name));

export const publicationForRevision = (
  registry: Executor["registry"],
  revision: number,
  publication: Publication,
) =>
  revision >= 1
    ? Effect.succeed(publication)
    : Option.match(readable(publication), {
        onNone: () => Effect.fail(new RegistryError({ reason: "invalid-response" })),
        onSome: (listing) => selected(registry, listing.name).pipe(Effect.as(listing)),
      });

export const publicationsForRevision = (
  registry: Executor["registry"],
  revision: number,
  all: ReadonlyArray<Publication>,
) =>
  revision >= 1
    ? Effect.succeed(all)
    : Effect.forEach(all, (publication) =>
        Option.match(readable(publication), {
          onNone: () => Effect.succeedNone,
          onSome: (listing) =>
            Effect.map(publishedAs(registry, listing.name), (found) =>
              found.every((other) => other.name === publication.name)
                ? Option.some(listing)
                : Option.none(),
            ),
        }),
      ).pipe(
        Effect.map(Arr.getSomes),
        Effect.tap((listings) => leftOut(all.length - listings.length)),
      );

const revisionZeroCatalog = (all: ReadonlyArray<Publication>) =>
  Effect.gen(function* () {
    const named = all.flatMap((publication) => Option.toArray(readable(publication)));
    const readers = new Map<string, number>();
    for (const { name } of named) readers.set(name, (readers.get(name) ?? 0) + 1);
    const listings = named.filter(({ name }) => readers.get(name) === 1);
    yield* leftOut(all.length - listings.length);
    return listings;
  });

export const readinessForRevision = (
  revision: number,
  readiness: PublicationReadiness | null,
): PublicationReadiness | null => {
  if (revision >= 1 || readiness === null) return readiness;
  const names =
    readiness.status === "ready"
      ? [readiness.manifest.name]
      : readiness.suggestedName === null
        ? []
        : [readiness.suggestedName];
  return names.every((name) => Option.exists(revisionZeroName(name), (read) => read === name))
    ? readiness
    : null;
};

export const registryForRevision = (
  registry: Executor["registry"],
  revision: number,
): Executor["registry"] =>
  revision >= 1
    ? registry
    : {
        list: (input = {}) => {
          const { name } = input;
          return name === undefined
            ? registry.list({}).pipe(Effect.flatMap(revisionZeroCatalog))
            : selected(registry, name).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(new RegistryError({ reason: "not-found" })),
                    onSome: (found) =>
                      Effect.succeed(found.map((listing) => ({ ...listing, name }))),
                  }),
                ),
              );
        },
        snapshot: (input) =>
          selectedName(registry, input.name).pipe(
            Effect.flatMap((name) => registry.snapshot({ ...input, name })),
            Effect.map((snapshot) => ({
              ...snapshot,
              publication: { ...snapshot.publication, name: input.name },
            })),
          ),
        file: (input) =>
          selectedName(registry, input.name).pipe(
            Effect.flatMap((name) => registry.file({ ...input, name })),
          ),
      };
