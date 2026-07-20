# @executor-js/plugin-provider-service-split

## 0.0.6

### Patch Changes

- Updated dependencies [[`1b9b1f1`](https://github.com/UsefulSoftwareCo/executor/commit/1b9b1f10313834a625a411169ebf83f6181589df)]:
  - @executor-js/sdk@1.5.35
  - @executor-js/plugin-openapi@1.5.35

## 0.0.5

### Patch Changes

- Updated dependencies [[`e2712db`](https://github.com/UsefulSoftwareCo/executor/commit/e2712dbff98145c5c340832ffbdcb21113b9dd78), [`a86cc4e`](https://github.com/UsefulSoftwareCo/executor/commit/a86cc4e6d0252c90834f40ee09837d8a19cab7fe), [`7207347`](https://github.com/UsefulSoftwareCo/executor/commit/720734756a70b1b4f1564bdf82dc4118e5de2b76), [`0c4e9b4`](https://github.com/UsefulSoftwareCo/executor/commit/0c4e9b49fecb35ad71c92a464c3ea01131ff9d6f), [`171de20`](https://github.com/UsefulSoftwareCo/executor/commit/171de204725d10405c693549febc3a1cce2c24d8)]:
  - @executor-js/sdk@1.5.34
  - @executor-js/plugin-openapi@1.5.34

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
