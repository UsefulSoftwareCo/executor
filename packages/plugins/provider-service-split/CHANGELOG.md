# @executor-js/plugin-provider-service-split

## 0.0.4

### Patch Changes

- [#1404](https://github.com/UsefulSoftwareCo/executor/pull/1404) [`5e0dd15`](https://github.com/UsefulSoftwareCo/executor/commit/5e0dd15291daaedf10f6eb8e03c5afdca8787764) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - The provider service split boot migration now skips an org whose Google or Microsoft integration cannot be migrated (for example a config without a stored specHash) instead of failing the whole migration and blocking server startup. A daemon that does fail during boot now exits with the underlying error message instead of hanging with a generic "Unknown error".

- Updated dependencies []:
  - @executor-js/sdk@1.5.33
  - @executor-js/plugin-openapi@1.5.33

## 0.0.3

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.32
  - @executor-js/plugin-openapi@1.5.32

## 0.0.2

### Patch Changes

- Updated dependencies [[`9e38928`](https://github.com/UsefulSoftwareCo/executor/commit/9e38928f0fda9032b64b26990270c5d2b6690d13)]:
  - @executor-js/plugin-openapi@1.5.31
  - @executor-js/sdk@1.5.31

## 0.0.1

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.30
  - @executor-js/plugin-openapi@1.5.30

## 0.0.0

### Patch Changes

- Initial internal package.
