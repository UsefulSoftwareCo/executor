# @executor-js/plugin-file-secrets

## 1.5.35

### Patch Changes

- Updated dependencies [[`1b9b1f1`](https://github.com/UsefulSoftwareCo/executor/commit/1b9b1f10313834a625a411169ebf83f6181589df)]:
  - @executor-js/sdk@1.5.35

## 1.5.34

### Patch Changes

- [#1431](https://github.com/UsefulSoftwareCo/executor/pull/1431) [`39c2bfd`](https://github.com/UsefulSoftwareCo/executor/commit/39c2bfdc605b03c18bb332ea1dfa14df7e374a00) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - `fileSecretsPlugin()` now stores `auth.json` under `EXECUTOR_DATA_DIR` when that variable is set (an explicit `directory` option still wins; the XDG location remains the fallback when it is unset). Existing secrets in the legacy XDG location are migrated automatically on first use. This keeps all daemon state under one directory, so persisting `EXECUTOR_DATA_DIR` alone preserves credentials across environment recreation.

- Updated dependencies [[`e2712db`](https://github.com/UsefulSoftwareCo/executor/commit/e2712dbff98145c5c340832ffbdcb21113b9dd78), [`7207347`](https://github.com/UsefulSoftwareCo/executor/commit/720734756a70b1b4f1564bdf82dc4118e5de2b76), [`0c4e9b4`](https://github.com/UsefulSoftwareCo/executor/commit/0c4e9b49fecb35ad71c92a464c3ea01131ff9d6f)]:
  - @executor-js/sdk@1.5.34

## 1.5.33

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.33

## 1.5.32

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.32

## 1.5.31

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.31

## 1.5.30

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.30

## 1.5.29

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.29

## 1.5.28

### Patch Changes

- Updated dependencies [[`1c48182`](https://github.com/UsefulSoftwareCo/executor/commit/1c4818254e71dc4ee27ff95f489e2c5cf330a450)]:
  - @executor-js/sdk@1.5.28

## 1.5.27

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.27

## 1.5.26

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.26

## 1.5.25

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.25

## 1.5.24

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.24

## 1.5.23

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.23

## 1.5.22

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.22

## 1.5.21

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.21

## 1.5.20

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.20

## 1.5.19

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.19

## 1.5.18

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.18

## 1.5.17

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.17

## 1.5.16

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.16

## 1.5.15

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.15

## 1.5.14

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.14

## 1.5.13

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.13

## 1.5.12

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.12

## 1.5.11

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.11

## 1.5.10

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.10

## 1.5.9

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.9

## 1.5.8

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.8

## 1.5.7

### Patch Changes

- Updated dependencies [[`7cee242`](https://github.com/RhysSullivan/executor/commit/7cee242f07687b0d8711201c620d8c61594adc15), [`7cee242`](https://github.com/RhysSullivan/executor/commit/7cee242f07687b0d8711201c620d8c61594adc15)]:
  - @executor-js/sdk@1.5.7

## 1.5.4

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.4

## 1.5.3

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.3

## 1.5.2

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.2

## 1.5.1

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.1

## 1.5.0

### Patch Changes

- [#922](https://github.com/RhysSullivan/executor/pull/922) [`1ba0193`](https://github.com/RhysSullivan/executor/commit/1ba01932919e6aee25a76c4c093841df8539adad) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Move `effect` from `dependencies` to `peerDependencies` in the published library packages so consumers provide a single shared Effect instance.

- Updated dependencies [[`7d7fbbd`](https://github.com/RhysSullivan/executor/commit/7d7fbbda9c0912e70334dcc809ec755ba3328f68), [`1ba0193`](https://github.com/RhysSullivan/executor/commit/1ba01932919e6aee25a76c4c093841df8539adad)]:
  - @executor-js/sdk@1.5.0
