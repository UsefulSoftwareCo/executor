# @executor-js/plugin-graphql

## 1.6.8

### Patch Changes

- [#1919](https://github.com/UsefulSoftwareCo/executor/pull/1919) [`caa0391`](https://github.com/UsefulSoftwareCo/executor/commit/caa03919a8f2a5c82ed13bc4ea9060e964af3a79) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **Workspace writes now require an administrator**

  Executor bindings accept `orgWrites: "allowed" | "denied" | "request"`.
  Request-aware hosts use `"request"` and bind `CurrentOrgWriteAccess` from the
  authenticated principal for each request. An approval, decline, cancellation,
  or form response also rebinds the paused execution to the resumer's current
  access. Browser approvals derive access from the authenticated browser user's
  live organization membership when that user posts the decision, rather than
  from the earlier MCP request waiting for it or the user's global role. Self-host
  uses the same Better Auth membership lookup for ordinary requests and browser
  decisions. A demotion before either kind of resume therefore takes effect
  before the paused execution can reach a workspace-write sink.

  `Principal` now declares its role model explicitly: organization-backed hosts
  carry `orgRoleModel: "organization"` and an optional normalized admin/member
  role, while hosts without roles carry `orgRoleModel: "none"` and cannot also
  carry an organization role. Missing role data under the organization model
  fails closed, including legacy persisted MCP session metadata. Cloud derives
  roles from WorkOS memberships and self-host derives them from Better Auth.

  Members may still read and execute shared workspace resources and perform
  operational maintenance such as token refresh and tool-catalog synchronization.
  User-requested workspace mutations now return `OrgWriteDeniedError` (HTTP 403):
  workspace connections and reconnects, organization OAuth clients and connect
  flows, tool policies, and integration add/update/replace/remove/health-check
  operations. Personal connection management remains available.

  Pasted connection credentials, OAuth client secrets, OAuth connection tokens,
  and dependent tool discovery run only after the outermost transaction commits
  their row, including when a plugin wraps creation in `ctx.transaction`. Each
  committed row records unique provider item references owned by that write
  attempt. Reads resolve only those recorded references, so the post-commit
  window fails closed with a retryable incomplete-write error and can never
  resolve a predecessor's credential. A process crash leaves detectable missing
  references; a later executor incarnation can atomically replace and retry a
  stranded pasted connection, while OAuth client and connection retries replace
  their rows through their existing update paths.

  If credential persistence fails while the process remains alive, row and
  provider compensation restore the prior state where possible and surface
  incomplete cleanup explicitly. Best-effort cleanup can leave inert orphaned
  attempt items, but an attempt never shares an item reference with a successor,
  eliminating the former successor-clobber interval without requiring provider
  compare-and-set support.

- Updated dependencies [[`31a8042`](https://github.com/UsefulSoftwareCo/executor/commit/31a8042450475fd86ea580f4dbd5dcc3c290c008), [`b5271a6`](https://github.com/UsefulSoftwareCo/executor/commit/b5271a6f0cb6d0c42a6b9fbcdffe70fc2aad8bc6), [`caa0391`](https://github.com/UsefulSoftwareCo/executor/commit/caa03919a8f2a5c82ed13bc4ea9060e964af3a79)]:
  - @executor-js/sdk@1.6.8
  - @executor-js/api@1.4.71
  - @executor-js/config@1.6.8
  - @executor-js/react@1.4.71

## 1.6.7

### Patch Changes

- Updated dependencies [[`98d6c6a`](https://github.com/UsefulSoftwareCo/executor/commit/98d6c6ad3272fca371fc2d8b14b2e332100d8322)]:
  - @executor-js/sdk@1.6.7
  - @executor-js/api@1.4.70
  - @executor-js/config@1.6.7
  - @executor-js/react@1.4.70

## 1.6.6

### Patch Changes

- Updated dependencies [[`9a1fbd5`](https://github.com/UsefulSoftwareCo/executor/commit/9a1fbd5f0de25f622f303c76f998443c1bb72063)]:
  - @executor-js/react@1.4.69
  - @executor-js/api@1.4.69
  - @executor-js/sdk@1.6.6
  - @executor-js/config@1.6.6

## 1.6.5

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.6.5
  - @executor-js/config@1.6.5
  - @executor-js/api@1.4.68
  - @executor-js/react@1.4.68

## 1.6.4

### Patch Changes

- Updated dependencies [[`ffcfbc0`](https://github.com/UsefulSoftwareCo/executor/commit/ffcfbc0de27d0ae55215839fb70395b0b7d9a65c), [`10e16a5`](https://github.com/UsefulSoftwareCo/executor/commit/10e16a5baa2648657b70038e7d11429c58e4d242), [`9dcfaa5`](https://github.com/UsefulSoftwareCo/executor/commit/9dcfaa5ee8ad2ebc17407caf94d8d4dcf55e3562), [`515d6aa`](https://github.com/UsefulSoftwareCo/executor/commit/515d6aa391a04a3579a7b10f974ec316a563cf7a), [`06bf742`](https://github.com/UsefulSoftwareCo/executor/commit/06bf74254f3432e8d75fd8b493ef7a435ea4bc84)]:
  - @executor-js/sdk@1.6.4
  - @executor-js/react@1.4.67
  - @executor-js/api@1.4.67
  - @executor-js/config@1.6.4

## 1.6.3

### Patch Changes

- Updated dependencies [[`66fb1a4`](https://github.com/UsefulSoftwareCo/executor/commit/66fb1a4154226d28691ca83bdf6f3daa417ef0ce), [`c1f51b7`](https://github.com/UsefulSoftwareCo/executor/commit/c1f51b7f96328b795669bb3d241667660dc2b060), [`d7e4b73`](https://github.com/UsefulSoftwareCo/executor/commit/d7e4b73a86b8e413af70e0fcb26f38a35a3f4546), [`02b52cd`](https://github.com/UsefulSoftwareCo/executor/commit/02b52cd01b09d3601ffe88d1f9c0b777f26e76ae)]:
  - @executor-js/react@1.4.66
  - @executor-js/sdk@1.6.3
  - @executor-js/api@1.4.66
  - @executor-js/config@1.6.3

## 1.6.2

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.6.2
  - @executor-js/config@1.6.2
  - @executor-js/api@1.4.65
  - @executor-js/react@1.4.65

## 1.6.1

### Patch Changes

- Updated dependencies [[`9dff4e8`](https://github.com/UsefulSoftwareCo/executor/commit/9dff4e8e6598e7d3108634a71269245ba9b480bb), [`55180cb`](https://github.com/UsefulSoftwareCo/executor/commit/55180cb1487f9a3a28ddc0ee0bedfab8464c1f72)]:
  - @executor-js/react@1.4.64
  - @executor-js/sdk@1.6.1
  - @executor-js/api@1.4.64
  - @executor-js/config@1.6.1

## 1.6.0

### Patch Changes

- Updated dependencies [[`a2d1417`](https://github.com/UsefulSoftwareCo/executor/commit/a2d141758e478274813c8c24d354e1fd0f66af49), [`2bdbedf`](https://github.com/UsefulSoftwareCo/executor/commit/2bdbedf257f54d7c209e8c856c618174c10d6bb3)]:
  - @executor-js/sdk@1.6.0
  - @executor-js/react@1.4.63
  - @executor-js/api@1.4.63
  - @executor-js/config@1.6.0

## 1.5.42

### Patch Changes

- Updated dependencies [[`d3f0617`](https://github.com/UsefulSoftwareCo/executor/commit/d3f0617deec06c57e0d6e1479fe668f79daf977d)]:
  - @executor-js/sdk@1.5.42
  - @executor-js/api@1.4.62
  - @executor-js/config@1.5.42
  - @executor-js/react@1.4.62

## 1.5.41

### Patch Changes

- Updated dependencies [[`d572658`](https://github.com/UsefulSoftwareCo/executor/commit/d572658d74097917412256f10a3ea2e3974f44dd)]:
  - @executor-js/sdk@1.5.41
  - @executor-js/api@1.4.61
  - @executor-js/config@1.5.41
  - @executor-js/react@1.4.61

## 1.5.40

### Patch Changes

- Updated dependencies [[`8ba64f6`](https://github.com/UsefulSoftwareCo/executor/commit/8ba64f675f6d6ab5302d4f68390c0b055d006f4a)]:
  - @executor-js/sdk@1.5.40
  - @executor-js/api@1.4.60
  - @executor-js/config@1.5.40
  - @executor-js/react@1.4.60

## 1.5.39

### Patch Changes

- Updated dependencies [[`6c316c7`](https://github.com/UsefulSoftwareCo/executor/commit/6c316c77a9efc98784976236852b58c6156e016e)]:
  - @executor-js/sdk@1.5.39
  - @executor-js/api@1.4.59
  - @executor-js/config@1.5.39
  - @executor-js/react@1.4.59

## 1.5.38

### Patch Changes

- Updated dependencies [[`6a924dd`](https://github.com/UsefulSoftwareCo/executor/commit/6a924dd98de916d6ff8cea2329bf672f149b64f4), [`1de85fc`](https://github.com/UsefulSoftwareCo/executor/commit/1de85fc0201c0c23c0e71e003c49228d406af6c8)]:
  - @executor-js/sdk@1.5.38
  - @executor-js/react@1.4.58
  - @executor-js/api@1.4.58
  - @executor-js/config@1.5.38

## 1.5.37

### Patch Changes

- Updated dependencies [[`657b913`](https://github.com/UsefulSoftwareCo/executor/commit/657b9135b8b841495b362936bf60bdca998c16eb)]:
  - @executor-js/sdk@1.5.37
  - @executor-js/api@1.4.57
  - @executor-js/config@1.5.37
  - @executor-js/react@1.4.57

## 1.5.36

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.36
  - @executor-js/config@1.5.36
  - @executor-js/api@1.4.56
  - @executor-js/react@1.4.56

## 1.5.35

### Patch Changes

- Updated dependencies [[`1b9b1f1`](https://github.com/UsefulSoftwareCo/executor/commit/1b9b1f10313834a625a411169ebf83f6181589df)]:
  - @executor-js/sdk@1.5.35
  - @executor-js/api@1.4.55
  - @executor-js/config@1.5.35
  - @executor-js/react@1.4.55

## 1.5.34

### Patch Changes

- Updated dependencies [[`e2712db`](https://github.com/UsefulSoftwareCo/executor/commit/e2712dbff98145c5c340832ffbdcb21113b9dd78), [`7207347`](https://github.com/UsefulSoftwareCo/executor/commit/720734756a70b1b4f1564bdf82dc4118e5de2b76), [`0c4e9b4`](https://github.com/UsefulSoftwareCo/executor/commit/0c4e9b49fecb35ad71c92a464c3ea01131ff9d6f)]:
  - @executor-js/sdk@1.5.34
  - @executor-js/api@1.4.54
  - @executor-js/config@1.5.34
  - @executor-js/react@1.4.54

## 1.5.33

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.33
  - @executor-js/config@1.5.33
  - @executor-js/api@1.4.53
  - @executor-js/react@1.4.53

## 1.5.32

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.32
  - @executor-js/config@1.5.32
  - @executor-js/api@1.4.52
  - @executor-js/react@1.4.52

## 1.5.31

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.31
  - @executor-js/config@1.5.31
  - @executor-js/api@1.4.51
  - @executor-js/react@1.4.51

## 1.5.30

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.30
  - @executor-js/config@1.5.30
  - @executor-js/api@1.4.50
  - @executor-js/react@1.4.50

## 1.5.29

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.29
  - @executor-js/config@1.5.29
  - @executor-js/api@1.4.49
  - @executor-js/react@1.4.49

## 1.5.28

### Patch Changes

- Updated dependencies [[`1c48182`](https://github.com/UsefulSoftwareCo/executor/commit/1c4818254e71dc4ee27ff95f489e2c5cf330a450)]:
  - @executor-js/sdk@1.5.28
  - @executor-js/api@1.4.48
  - @executor-js/config@1.5.28
  - @executor-js/react@1.4.48

## 1.5.27

### Patch Changes

- Updated dependencies [[`c7ab1e2`](https://github.com/RhysSullivan/executor/commit/c7ab1e2d56884e0453af85f6399fd25a39f04785)]:
  - @executor-js/api@1.4.47
  - @executor-js/react@1.4.47
  - @executor-js/sdk@1.5.27
  - @executor-js/config@1.5.27

## 1.5.26

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.26
  - @executor-js/config@1.5.26
  - @executor-js/api@1.4.46
  - @executor-js/react@1.4.46

## 1.5.25

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.25
  - @executor-js/config@1.5.25
  - @executor-js/api@1.4.45
  - @executor-js/react@1.4.45

## 1.5.24

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.24
  - @executor-js/config@1.5.24
  - @executor-js/api@1.4.44
  - @executor-js/react@1.4.44

## 1.5.23

### Patch Changes

- [#1199](https://github.com/RhysSullivan/executor/pull/1199) [`29936d5`](https://github.com/RhysSullivan/executor/commit/29936d5981256f8f953797d9ce8ce073ac6a0b6a) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Fix the GraphQL plugin generating invalid operations against large schemas, and make field selection caller-controlled instead of a baked-in guess.

  Previously each tool froze a recursive, depth- and count-bounded selection at sync time. Against a rich schema (GitLab) this produced invalid GraphQL (composite fields with no sub-selection, nested fields missing required arguments) so every call over a rich return type failed, and the arbitrary bound silently truncated which fields came back.

  Generated tools now default to selecting only scalar/enum leaf fields of the return type (always valid, always within a server's query-complexity budget), and expose an optional `select` input carrying a GraphQL selection set so a caller can request nested or list data per call (including supplying nested required arguments). Fixes [#1146](https://github.com/RhysSullivan/executor/issues/1146).

- Updated dependencies [[`29936d5`](https://github.com/RhysSullivan/executor/commit/29936d5981256f8f953797d9ce8ce073ac6a0b6a), [`29936d5`](https://github.com/RhysSullivan/executor/commit/29936d5981256f8f953797d9ce8ce073ac6a0b6a)]:
  - @executor-js/api@1.4.43
  - @executor-js/react@1.4.43
  - @executor-js/sdk@1.5.23
  - @executor-js/config@1.5.23

## 1.5.22

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.22
  - @executor-js/config@1.5.22
  - @executor-js/api@1.4.42
  - @executor-js/react@1.4.42

## 1.5.21

### Patch Changes

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

- [#922](https://github.com/RhysSullivan/executor/pull/922) [`1ba0193`](https://github.com/RhysSullivan/executor/commit/1ba01932919e6aee25a76c4c093841df8539adad) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Move `effect` from `dependencies` to `peerDependencies` in the published library packages so consumers provide a single shared Effect instance.

- [#891](https://github.com/RhysSullivan/executor/pull/891) [`9c9bcb6`](https://github.com/RhysSullivan/executor/commit/9c9bcb663e48ebb21a71f8058812319c1ec2a242) Thanks [@oscnord](https://github.com/oscnord)! - GraphQL sources now emit named operations (e.g. `query Hello { ... }`) instead of anonymous ones. This fixes invocation against servers that reject anonymous operations, and gives APM tooling that keys on the operation name a meaningful value. The operation name is derived from the root field name.

- Updated dependencies [[`7d7fbbd`](https://github.com/RhysSullivan/executor/commit/7d7fbbda9c0912e70334dcc809ec755ba3328f68), [`1ba0193`](https://github.com/RhysSullivan/executor/commit/1ba01932919e6aee25a76c4c093841df8539adad)]:
  - @executor-js/sdk@1.5.0
  - @executor-js/config@1.5.0
  - @executor-js/api@1.4.22
  - @executor-js/react@1.4.22
