# @executor-js/plugin-openapi

## 1.5.24

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.24
  - @executor-js/config@1.5.24
  - @executor-js/api@1.4.44
  - @executor-js/react@1.4.44

## 1.5.23

### Patch Changes

- Updated dependencies [[`29936d5`](https://github.com/RhysSullivan/executor/commit/29936d5981256f8f953797d9ce8ce073ac6a0b6a), [`29936d5`](https://github.com/RhysSullivan/executor/commit/29936d5981256f8f953797d9ce8ce073ac6a0b6a)]:
  - @executor-js/api@1.4.43
  - @executor-js/react@1.4.43
  - @executor-js/sdk@1.5.23
  - @executor-js/config@1.5.23

## 1.5.22

### Patch Changes

- [#1137](https://github.com/RhysSullivan/executor/pull/1137) [`1a1f9aa`](https://github.com/RhysSullivan/executor/commit/1a1f9aaae4e4d0f73311fd643919cdfaa637c124) Thanks [@zrm625](https://github.com/zrm625)! - Add a Google Photos preset with raw upload support and binary-safe `bodyBase64` handling.

- Updated dependencies []:
  - @executor-js/sdk@1.5.22
  - @executor-js/config@1.5.22
  - @executor-js/api@1.4.42
  - @executor-js/react@1.4.42

## 1.5.21

### Patch Changes

- [#1151](https://github.com/RhysSullivan/executor/pull/1151) [`4b361b9`](https://github.com/RhysSullivan/executor/commit/4b361b9f7220f679f582137f5375b29c3b72f919) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Derive separate credential inputs for OpenAPI auth strategies that require multiple API key headers.

- Updated dependencies []:
  - @executor-js/sdk@1.5.21
  - @executor-js/config@1.5.21
  - @executor-js/api@1.4.41
  - @executor-js/react@1.4.41

## 1.5.20

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.20
  - @executor-js/config@1.5.20
  - @executor-js/api@1.4.40
  - @executor-js/react@1.4.40

## 1.5.19

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.19
  - @executor-js/config@1.5.19
  - @executor-js/api@1.4.39
  - @executor-js/react@1.4.39

## 1.5.18

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.18
  - @executor-js/config@1.5.18
  - @executor-js/api@1.4.38
  - @executor-js/react@1.4.38

## 1.5.17

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.17
  - @executor-js/config@1.5.17
  - @executor-js/api@1.4.37
  - @executor-js/react@1.4.37

## 1.5.16

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.16
  - @executor-js/config@1.5.16
  - @executor-js/api@1.4.36
  - @executor-js/react@1.4.36

## 1.5.15

### Patch Changes

- Surface binary tool results as model-native file outputs across OpenAPI and upstream MCP integrations.

- Updated dependencies []:
  - @executor-js/sdk@1.5.15
  - @executor-js/api@1.4.35
  - @executor-js/config@1.5.15
  - @executor-js/react@1.4.35

## 1.5.14

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.14
  - @executor-js/config@1.5.14
  - @executor-js/api@1.4.34
  - @executor-js/react@1.4.34

## 1.5.13

### Patch Changes

- Updated dependencies []:
  - @executor-js/api@1.4.33
  - @executor-js/react@1.4.33
  - @executor-js/sdk@1.5.13
  - @executor-js/config@1.5.13

## 1.5.12

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.12
  - @executor-js/config@1.5.12
  - @executor-js/api@1.4.32
  - @executor-js/react@1.4.32

## 1.5.11

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.11
  - @executor-js/config@1.5.11
  - @executor-js/api@1.4.31
  - @executor-js/react@1.4.31

## 1.5.10

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.10
  - @executor-js/config@1.5.10
  - @executor-js/api@1.4.30
  - @executor-js/react@1.4.30

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

- [#893](https://github.com/RhysSullivan/executor/pull/893) [`7d7fbbd`](https://github.com/RhysSullivan/executor/commit/7d7fbbda9c0912e70334dcc809ec755ba3328f68) Thanks [@dmmulroy](https://github.com/dmmulroy)! - Batch OpenAPI operation metadata writes through plugin storage so adding large built-in OpenAPI sources no longer performs thousands of sequential D1 operations.

- [#922](https://github.com/RhysSullivan/executor/pull/922) [`1ba0193`](https://github.com/RhysSullivan/executor/commit/1ba01932919e6aee25a76c4c093841df8539adad) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Move `effect` from `dependencies` to `peerDependencies` in the published library packages so consumers provide a single shared Effect instance.

- Updated dependencies [[`7d7fbbd`](https://github.com/RhysSullivan/executor/commit/7d7fbbda9c0912e70334dcc809ec755ba3328f68), [`1ba0193`](https://github.com/RhysSullivan/executor/commit/1ba01932919e6aee25a76c4c093841df8539adad)]:
  - @executor-js/sdk@1.5.0
  - @executor-js/config@1.5.0
  - @executor-js/api@1.4.22
  - @executor-js/react@1.4.22
