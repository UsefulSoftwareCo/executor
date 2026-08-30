# @executor-js/plugin-openapi

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

- [#1530](https://github.com/UsefulSoftwareCo/executor/pull/1530) [`85b1955`](https://github.com/UsefulSoftwareCo/executor/commit/85b1955b4d24c332e637e15a025d64455e28a626) Thanks [@BittuBarnwal7479](https://github.com/BittuBarnwal7479)! - Multipart file fields in an OpenAPI spec now accept and send real files. A `multipart/form-data` property typed as a binary or byte string is rewritten into the SDK's tool-file schema when the tool is extracted, so an agent supplies a file the same way it does everywhere else. On invocation those values are decoded back into `File`/`Blob` parts — as bare properties and inside arrays, with a per-property `encoding.contentType` applied to each file part — instead of being JSON-stringified into the form body, which is what upstreams were previously rejecting. A file whose base64 payload does not decode now fails the invocation and names the field, rather than sending the file envelope as JSON.

  The rewrite advertises only the shapes the request encoder can deliver. Two are deliberately left alone:
  - A binary field nested inside an object property. Only top-level multipart properties and direct items of a top-level array property become form parts.
  - A multipart body schema, or one of its properties, behind a `$ref`. Component schemas are carried through unresolved by design — the streaming compile path never materializes `components.schemas` — so a `$ref`'d file field keeps its declared binary string type.

  The rewrite reads the request schema's own `properties` map rather than walking every object key, so a `default`, `example`, or vendor extension that happens to look like a binary string schema is untouched. Descriptions, titles, and nullability on the replaced field are carried onto the file schema.

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

- [#1755](https://github.com/UsefulSoftwareCo/executor/pull/1755) [`7c12aee`](https://github.com/UsefulSoftwareCo/executor/commit/7c12aeea390225291ce4c97865b392237ee7934d) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Make Microsoft Graph slice URLs first-class spec sources instead of a hidden substitution. Catalog tiles now point directly at the slice release assets, the stored specUrl is exactly what gets fetched, and selection narrowing travels visibly in the URL fragment; requesting the upstream monolith URL fetches the monolith, never a silently swapped slice.

- [#1753](https://github.com/UsefulSoftwareCo/executor/pull/1753) [`ddbf0fe`](https://github.com/UsefulSoftwareCo/executor/commit/ddbf0feba38c8502d78fa20c3081391b8ba3d112) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Serve Microsoft Graph preset selections from precomputed slice release assets instead of the 43MB upstream monolith. The monolith fetch almost never survives a 128MB Workers isolate (production traces show one completion in 30 days), so covered selections — every catalog preset, plus any combination within the default bundle — now read a 4–19MB filtered document built offline by the graph-slices workflow, with the monolith path kept only as a fallback and for full-graph/custom-scope selections.

- [#1751](https://github.com/UsefulSoftwareCo/executor/pull/1751) [`0007474`](https://github.com/UsefulSoftwareCo/executor/commit/0007474602d8da3642648f216bfdb0f09eb0914f) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Preview OpenAPI spec-format selections (Microsoft Graph) through the streaming structural-split path instead of a whole-document parse, and guard generic whole-document parses by parsed-tree size (line count for block YAML, text size for JSON). Previewing a Graph preset URL previously parsed the 43MB source whole and killed the 128MB Workers isolate mid-request, surfacing as an empty 503; it now streams within budget, and oversized generic specs fail with an actionable error instead of taking down the isolate.

- Updated dependencies [[`9dff4e8`](https://github.com/UsefulSoftwareCo/executor/commit/9dff4e8e6598e7d3108634a71269245ba9b480bb), [`55180cb`](https://github.com/UsefulSoftwareCo/executor/commit/55180cb1487f9a3a28ddc0ee0bedfab8464c1f72)]:
  - @executor-js/react@1.4.64
  - @executor-js/sdk@1.6.1
  - @executor-js/api@1.4.64
  - @executor-js/config@1.6.1

## 1.6.0

### Patch Changes

- [#1660](https://github.com/UsefulSoftwareCo/executor/pull/1660) [`c11bef2`](https://github.com/UsefulSoftwareCo/executor/commit/c11bef2cd049db7bbf51b15e18761b14acccb534) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **Cloudflare ships as MCP-only, with code mode opted out**

  The Cloudflare OpenAPI preset is gone from the default catalog; the MCP preset is the one Cloudflare entry. Its endpoint now pins `?codemode=false` because Cloudflare's MCP server otherwise hides the tool catalog behind a single code-execution tool, and executor already provides the code-execution surface. Hand-entered `mcp.cloudflare.com` URLs missing the opt-out get an inline warning in the add flow telling the user to append `?codemode=false`.

- [#1669](https://github.com/UsefulSoftwareCo/executor/pull/1669) [`46cea2c`](https://github.com/UsefulSoftwareCo/executor/commit/46cea2cbb1f414ae58ac876819a51b11967909a6) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Request Gmail's basic-settings scope alongside full mailbox access so Google integrations can create and manage Gmail filters without including domain-admin-only sharing settings.

- Updated dependencies [[`a2d1417`](https://github.com/UsefulSoftwareCo/executor/commit/a2d141758e478274813c8c24d354e1fd0f66af49), [`2bdbedf`](https://github.com/UsefulSoftwareCo/executor/commit/2bdbedf257f54d7c209e8c856c618174c10d6bb3)]:
  - @executor-js/sdk@1.6.0
  - @executor-js/react@1.4.63
  - @executor-js/api@1.4.63
  - @executor-js/config@1.6.0

## 1.5.42

### Patch Changes

- [#1642](https://github.com/UsefulSoftwareCo/executor/pull/1642) [`32206c7`](https://github.com/UsefulSoftwareCo/executor/commit/32206c7f78654f638bfd27c25c71c30c3d6354be) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Preserve an integration's selected OAuth consent scopes when refreshing converted API specifications, so Google Gmail refreshes do not restore operations that require broader scopes.

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

- [#1428](https://github.com/UsefulSoftwareCo/executor/pull/1428) [`df01d91`](https://github.com/UsefulSoftwareCo/executor/commit/df01d9197e7b4fca9bd0adaca0705a80435e188c) Thanks [@saga-agent](https://github.com/saga-agent)! - Use the versioned Google Photos raw upload endpoint so generated upload tools send media to `/v1/uploads` instead of the invalid `/uploads` path.

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

- [#1430](https://github.com/UsefulSoftwareCo/executor/pull/1430) [`a86cc4e`](https://github.com/UsefulSoftwareCo/executor/commit/a86cc4e6d0252c90834f40ee09837d8a19cab7fe) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - OpenAPI invocations now bound how long a buffered (non-streaming) response body may take to arrive. An upstream that returns headers quickly and then stalls the body previously hung the call indefinitely on runtimes without a platform subrequest limit; it now aborts after the response-body timeout (default 60s, configurable via `invokeOptions.responseBodyTimeoutMs`) with a distinct `upstream_response_body_timeout` failure.

- [#1427](https://github.com/UsefulSoftwareCo/executor/pull/1427) [`7207347`](https://github.com/UsefulSoftwareCo/executor/commit/720734756a70b1b4f1564bdf82dc4118e5de2b76) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Apply persisted RFC 6902 overrides to OpenAPI specifications during preview, import, and refresh so upstream documents can be corrected without maintaining a fork. Figma imports automatically narrow OAuth to the scopes supported by its OAuth app configuration.

- [#1426](https://github.com/UsefulSoftwareCo/executor/pull/1426) [`171de20`](https://github.com/UsefulSoftwareCo/executor/commit/171de204725d10405c693549febc3a1cce2c24d8) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Do not add unadvertised OpenID Connect identity scopes to OAuth authorization requests derived from OpenAPI specifications.

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

- [#1389](https://github.com/UsefulSoftwareCo/executor/pull/1389) [`9e38928`](https://github.com/UsefulSoftwareCo/executor/commit/9e38928f0fda9032b64b26990270c5d2b6690d13) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Advertise NDJSON operation outputs as arrays. Endpoints declaring `application/stream+json`, `application/x-ndjson`, or `application/jsonl` responses (for example Vercel's runtime-logs) spec the schema of one line, but invocations return an array of parsed lines; describe previews now wrap the line schema in an array so generated code matches what actually comes back. Existing integrations with NDJSON operations are stale-marked once so their tool catalogs rebuild with the corrected schemas.

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

- [#1213](https://github.com/RhysSullivan/executor/pull/1213) [`dc9bf71`](https://github.com/RhysSullivan/executor/commit/dc9bf717b81a3b719a137b25d01a8fd28e6cd699) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Allow a plain string `body` for octet-stream uploads again. Operations like Microsoft Graph's drive item content upload were rejecting string bodies with "request body must be bytes; provide bodyBase64", even though the request layer already sends a string through fine. String bodies now go through as UTF-8 bytes; binary content still uses `bodyBase64`.

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
