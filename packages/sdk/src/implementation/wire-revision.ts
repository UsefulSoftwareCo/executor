/**
 * Registry and publication results as a client reading an earlier wire revision sees them.
 *
 * Revision 0 reads a listing in a publishing scope by its organization's slug, `@acme/notes` for
 * `@acme.executor.community/notes`, as packages were named before scopes, and any other listing by
 * its own name. A registry may publish `@acme/notes` itself, so a name such a client sends is
 * resolved against the names the registry publishes, never rewritten by its form alone. When the
 * registry publishes both, the name could select either: neither is listed to the client, and a
 * request naming it is refused. A listing the client named is answered by the name it sent, which it
 * can read: a release after 2.0.0-beta.15 that states no revision may send a full name and requires
 * the answer to name the same. Names quoted from source files are never rewritten, so readiness a
 * client cannot read is withheld instead.
 *
 * A name selects whichever listing it names when the request arrives, which need not be the one the
 * client was shown: that listing may have been replaced, or its organization renamed and its slug
 * taken by another. So a revision 0 name is resolved only to list a listing, or for a request that
 * also names the commit it was shown, which the registry checks in the same read that returns its
 * source: source, files, and copies into the caller's own organization. A removal names no commit,
 * so app management refuses a removal by a name revision 0 reads for a scoped listing and gives the
 * full name instead; a full name means only itself.
 */
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

/** Package names as revision 0 decodes them: no dot in the scope. */
const revisionZeroPackageName = /^@[a-z0-9][a-z0-9-]{0,79}\/[a-z0-9][a-z0-9-]{0,62}$/u;
const publishingSuffix = `.${publishingDomain}`;

/** The name revision 0 reads a listing by, if it can read one. */
const revisionZeroName = (name: PackageName): Option.Option<PackageName> => {
  const scope = packageScope(name);
  const read = scope.endsWith(publishingSuffix)
    ? `@${scope.slice(0, -publishingSuffix.length)}/${packageLabel(name)}`
    : name;
  return revisionZeroPackageName.test(read) ? Option.some(read) : Option.none();
};
/**
 * The listing name in a publishing scope that revision 0 reads as `name`: for `@acme/notes`,
 * `@acme.executor.community/notes`. None for any other name, which means only itself.
 */
export const scopedNameFor = (name: PackageName): Option.Option<PackageName> =>
  revisionZeroPackageName.test(name)
    ? Option.some(`@${packageScope(name)}${publishingSuffix}/${packageLabel(name)}`)
    : Option.none();
/** Every listing name revision 0 reads as `name`: itself, and its label in its slug's publishing scope. */
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

/**
 * The registry's answer for each listing name revision 0 reads as `name`, `name` itself first: the
 * listings under that exact name, or none when the registry states it has no such listing, as a
 * remote registry may.
 */
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
/** The published listings revision 0 reads as `name`, found by their exact names. */
const publishedAs = (registry: Executor["registry"], name: PackageName) =>
  Effect.map(answersFor(registry, name), (answers) => Arr.getSomes(answers).flat());

/**
 * The listings revision 0's `name` selects, all under one published name. None when no listing
 * reads as it and the registry states it has no listing named `name`, which the client is answered
 * with as this release's clients are. When two published names read as it, the client cannot have
 * told them apart, so the request is refused rather than sent to either.
 */
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
/** The listing name revision 0's `name` selects; unchanged when nothing is published under it. */
const selectedName = (registry: Executor["registry"], name: PackageName) =>
  Effect.map(selected(registry, name), (found) =>
    Option.match(Option.flatMap(found, Arr.head), {
      onNone: () => name,
      onSome: (listing) => listing.name,
    }),
  );

/**
 * The listing name a client reading wire `revision` means by `name`, for a request that names the
 * commit it was shown. Never resolve one for a write that names no commit.
 */
export const packageNameFromRevision = (
  registry: Executor["registry"],
  revision: number,
  name: PackageName,
) => (revision >= 1 ? Effect.succeed(name) : selectedName(registry, name));

/**
 * One listing for a client reading wire `revision`. The client named it, or its owner published it
 * under the organization's slug, so its name reads unless another listing reads the same.
 */
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

/**
 * Listings for a client reading wire `revision`. Ones it cannot read, or cannot tell apart from
 * another published listing, are left out and counted.
 */
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

/** The whole catalog for revision 0, without the listings it cannot read or tell apart by name. */
const revisionZeroCatalog = (all: ReadonlyArray<Publication>) =>
  Effect.gen(function* () {
    const named = all.flatMap((publication) => Option.toArray(readable(publication)));
    const readers = new Map<string, number>();
    for (const { name } of named) readers.set(name, (readers.get(name) ?? 0) + 1);
    const listings = named.filter(({ name }) => readers.get(name) === 1);
    yield* leftOut(all.length - listings.length);
    return listings;
  });

/** Readiness for a client reading wire `revision`, or null when it names a package the client cannot read. */
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

/** Registry reads for a client reading wire `revision`. */
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
