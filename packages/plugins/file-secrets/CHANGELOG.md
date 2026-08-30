# @executor-js/plugin-file-secrets

## 1.6.6

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.6.6

## 1.6.5

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.6.5

## 1.6.4

### Patch Changes

- [#1838](https://github.com/UsefulSoftwareCo/executor/pull/1838) [`939b96f`](https://github.com/UsefulSoftwareCo/executor/commit/939b96f694a420cd6151c4e402cff7f1ab4b327a) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Import plugin-authoring symbols from `@executor-js/sdk/core` instead of the package root. The published root is the Promise surface and does not export `StorageError`, `definePlugin`, `PluginCtx`, or `Plugin`, so both packages failed to load when installed from npm.

- Updated dependencies [[`ffcfbc0`](https://github.com/UsefulSoftwareCo/executor/commit/ffcfbc0de27d0ae55215839fb70395b0b7d9a65c), [`10e16a5`](https://github.com/UsefulSoftwareCo/executor/commit/10e16a5baa2648657b70038e7d11429c58e4d242), [`515d6aa`](https://github.com/UsefulSoftwareCo/executor/commit/515d6aa391a04a3579a7b10f974ec316a563cf7a), [`06bf742`](https://github.com/UsefulSoftwareCo/executor/commit/06bf74254f3432e8d75fd8b493ef7a435ea4bc84)]:
  - @executor-js/sdk@1.6.4

## 1.6.3

### Patch Changes

- Updated dependencies [[`c1f51b7`](https://github.com/UsefulSoftwareCo/executor/commit/c1f51b7f96328b795669bb3d241667660dc2b060), [`02b52cd`](https://github.com/UsefulSoftwareCo/executor/commit/02b52cd01b09d3601ffe88d1f9c0b777f26e76ae)]:
  - @executor-js/sdk@1.6.3

## 1.6.2

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.6.2

## 1.6.1

### Patch Changes

- Updated dependencies [[`55180cb`](https://github.com/UsefulSoftwareCo/executor/commit/55180cb1487f9a3a28ddc0ee0bedfab8464c1f72)]:
  - @executor-js/sdk@1.6.1

## 1.6.0

### Patch Changes

- Updated dependencies [[`a2d1417`](https://github.com/UsefulSoftwareCo/executor/commit/a2d141758e478274813c8c24d354e1fd0f66af49)]:
  - @executor-js/sdk@1.6.0

## 1.5.42

### Patch Changes

- Updated dependencies [[`d3f0617`](https://github.com/UsefulSoftwareCo/executor/commit/d3f0617deec06c57e0d6e1479fe668f79daf977d)]:
  - @executor-js/sdk@1.5.42

## 1.5.41

### Patch Changes

- Updated dependencies [[`d572658`](https://github.com/UsefulSoftwareCo/executor/commit/d572658d74097917412256f10a3ea2e3974f44dd)]:
  - @executor-js/sdk@1.5.41

## 1.5.40

### Patch Changes

- Updated dependencies [[`8ba64f6`](https://github.com/UsefulSoftwareCo/executor/commit/8ba64f675f6d6ab5302d4f68390c0b055d006f4a)]:
  - @executor-js/sdk@1.5.40

## 1.5.39

### Patch Changes

- Updated dependencies [[`6c316c7`](https://github.com/UsefulSoftwareCo/executor/commit/6c316c77a9efc98784976236852b58c6156e016e)]:
  - @executor-js/sdk@1.5.39

## 1.5.38

### Patch Changes

- Updated dependencies [[`6a924dd`](https://github.com/UsefulSoftwareCo/executor/commit/6a924dd98de916d6ff8cea2329bf672f149b64f4)]:
  - @executor-js/sdk@1.5.38

## 1.5.37

### Patch Changes

- Updated dependencies [[`657b913`](https://github.com/UsefulSoftwareCo/executor/commit/657b9135b8b841495b362936bf60bdca998c16eb)]:
  - @executor-js/sdk@1.5.37

## 1.5.36

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.36

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
