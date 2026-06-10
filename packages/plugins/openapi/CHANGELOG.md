# @executor-js/plugin-openapi

## 1.5.1

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.1
  - @executor-js/config@1.5.1
  - @executor-js/api@1.4.23
  - @executor-js/react@1.4.23

## 1.5.0

### Patch Changes

- [#893](https://github.com/RhysSullivan/executor/pull/893) [`7d7fbbd`](https://github.com/RhysSullivan/executor/commit/7d7fbbda9c0912e70334dcc809ec755ba3328f68) Thanks [@dmmulroy](https://github.com/dmmulroy)! - Batch OpenAPI operation metadata writes through plugin storage so adding large built-in OpenAPI sources no longer performs thousands of sequential D1 operations.

- [#922](https://github.com/RhysSullivan/executor/pull/922) [`1ba0193`](https://github.com/RhysSullivan/executor/commit/1ba01932919e6aee25a76c4c093841df8539adad) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Move `effect` from `dependencies` to `peerDependencies` in the published library packages so consumers provide a single shared Effect instance.

- Updated dependencies [[`7d7fbbd`](https://github.com/RhysSullivan/executor/commit/7d7fbbda9c0912e70334dcc809ec755ba3328f68), [`1ba0193`](https://github.com/RhysSullivan/executor/commit/1ba01932919e6aee25a76c4c093841df8539adad)]:
  - @executor-js/sdk@1.5.0
  - @executor-js/config@1.5.0
  - @executor-js/api@1.4.22
  - @executor-js/react@1.4.22
