# @executor-js/plugin-graphql

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
