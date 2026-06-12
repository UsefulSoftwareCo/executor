# @executor-js/plugin-graphql

## 1.5.9

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.9
  - @executor-js/config@1.5.9
  - @executor-js/api@1.4.29
  - @executor-js/react@1.4.29

## 1.5.8

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.8
  - @executor-js/config@1.5.8
  - @executor-js/api@1.4.28
  - @executor-js/react@1.4.28

## 1.5.7

### Patch Changes

- [#964](https://github.com/RhysSullivan/executor/pull/964) [`7cee242`](https://github.com/RhysSullivan/executor/commit/7cee242f07687b0d8711201c620d8c61594adc15) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **Faster integrations with large API specs**

  Resolved OpenAPI spec text and GraphQL introspection snapshots are now stored content-addressed in the plugin blob store instead of inline in each integration's stored config. Listing integrations no longer loads multi-megabyte spec blobs it immediately discards, which makes the integrations surface dramatically faster for workspaces with large specs. Existing integrations keep working: rows that still inline a spec resolve unchanged and are rewritten in place the next time they are imported or refreshed.

- Updated dependencies [[`7cee242`](https://github.com/RhysSullivan/executor/commit/7cee242f07687b0d8711201c620d8c61594adc15), [`7cee242`](https://github.com/RhysSullivan/executor/commit/7cee242f07687b0d8711201c620d8c61594adc15)]:
  - @executor-js/sdk@1.5.7
  - @executor-js/api@1.4.27
  - @executor-js/config@1.5.7
  - @executor-js/react@1.4.27

## 1.5.4

### Patch Changes

- Updated dependencies [[`f485e4a`](https://github.com/RhysSullivan/executor/commit/f485e4a23cf3756b9e628cf2d9242fbc0b3da178)]:
  - @executor-js/react@1.4.26
  - @executor-js/sdk@1.5.4
  - @executor-js/config@1.5.4
  - @executor-js/api@1.4.26

## 1.5.3

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.3
  - @executor-js/config@1.5.3
  - @executor-js/api@1.4.25
  - @executor-js/react@1.4.25

## 1.5.2

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.2
  - @executor-js/config@1.5.2
  - @executor-js/api@1.4.24
  - @executor-js/react@1.4.24

## 1.5.1

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.1
  - @executor-js/config@1.5.1
  - @executor-js/api@1.4.23
  - @executor-js/react@1.4.23

## 1.5.0

### Patch Changes

- [#922](https://github.com/RhysSullivan/executor/pull/922) [`1ba0193`](https://github.com/RhysSullivan/executor/commit/1ba01932919e6aee25a76c4c093841df8539adad) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Move `effect` from `dependencies` to `peerDependencies` in the published library packages so consumers provide a single shared Effect instance.

- [#891](https://github.com/RhysSullivan/executor/pull/891) [`9c9bcb6`](https://github.com/RhysSullivan/executor/commit/9c9bcb663e48ebb21a71f8058812319c1ec2a242) Thanks [@oscnord](https://github.com/oscnord)! - GraphQL sources now emit named operations (e.g. `query Hello { ... }`) instead of anonymous ones. This fixes invocation against servers that reject anonymous operations, and gives APM tooling that keys on the operation name a meaningful value. The operation name is derived from the root field name.

- Updated dependencies [[`7d7fbbd`](https://github.com/RhysSullivan/executor/commit/7d7fbbda9c0912e70334dcc809ec755ba3328f68), [`1ba0193`](https://github.com/RhysSullivan/executor/commit/1ba01932919e6aee25a76c4c093841df8539adad)]:
  - @executor-js/sdk@1.5.0
  - @executor-js/config@1.5.0
  - @executor-js/api@1.4.22
  - @executor-js/react@1.4.22
