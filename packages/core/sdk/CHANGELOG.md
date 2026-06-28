# @executor-js/sdk

## 1.5.21

## 1.5.20

## 1.5.19

## 1.5.18

## 1.5.17

## 1.5.16

## 1.5.15

### Patch Changes

- Surface binary tool results as model-native file outputs across OpenAPI and upstream MCP integrations.

## 1.5.14

## 1.5.13

## 1.5.12

## 1.5.11

## 1.5.10

## 1.5.9

## 1.5.8

## 1.5.7

### Patch Changes

- [#964](https://github.com/RhysSullivan/executor/pull/964) [`7cee242`](https://github.com/RhysSullivan/executor/commit/7cee242f07687b0d8711201c620d8c61594adc15) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **Faster integrations with large API specs**

  Resolved OpenAPI spec text and GraphQL introspection snapshots are now stored content-addressed in the plugin blob store instead of inline in each integration's stored config. Listing integrations no longer loads multi-megabyte spec blobs it immediately discards, which makes the integrations surface dramatically faster for workspaces with large specs. Existing integrations keep working: rows that still inline a spec resolve unchanged and are rewritten in place the next time they are imported or refreshed.

- [#964](https://github.com/RhysSullivan/executor/pull/964) [`7cee242`](https://github.com/RhysSullivan/executor/commit/7cee242f07687b0d8711201c620d8c61594adc15) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Republish from committed source. Versions 1.5.5 and 1.5.6 of the library packages were published directly to npm to fix installs resolving the wrong `fumadb` dependency (the vendored database layer is now scoped as `@executor-js/fumadb`); that fix landed in the repo separately, and this release brings the recorded package versions back in line with npm.

- Updated dependencies [[`7cee242`](https://github.com/RhysSullivan/executor/commit/7cee242f07687b0d8711201c620d8c61594adc15)]:
  - @executor-js/fumadb@1.5.7

## 1.5.4

## 1.5.3

## 1.5.2

## 1.5.1

## 1.5.0

### Patch Changes

- [#893](https://github.com/RhysSullivan/executor/pull/893) [`7d7fbbd`](https://github.com/RhysSullivan/executor/commit/7d7fbbda9c0912e70334dcc809ec755ba3328f68) Thanks [@dmmulroy](https://github.com/dmmulroy)! - Batch OpenAPI operation metadata writes through plugin storage so adding large built-in OpenAPI sources no longer performs thousands of sequential D1 operations.

- [#922](https://github.com/RhysSullivan/executor/pull/922) [`1ba0193`](https://github.com/RhysSullivan/executor/commit/1ba01932919e6aee25a76c4c093841df8539adad) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Move `effect` from `dependencies` to `peerDependencies` in the published library packages so consumers provide a single shared Effect instance.
