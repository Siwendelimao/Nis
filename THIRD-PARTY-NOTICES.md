# 第三方开源组件声明 / Third-Party Notices

NIS 使用了以下开源软件。感谢每一位作者与维护者。

- 盘点时间：2026-10-11
- JavaScript/TypeScript 依赖：**579** 个包（去重后）
- Rust 依赖：**939** 个 crate

> 本文件由 `scan_third_party.mjs` + `gen_notices.mjs` 自动生成；改动依赖后重新跑一遍即可。

## 一、许可分布（JavaScript/TypeScript）

| 许可 | 包数 |
| --- | --- |
| MIT | 411 |
| Apache-2.0 | 66 |
| ISC | 52 |
| BSD-3-Clause | 25 |
| BSD-2-Clause | 9 |
| Unlicense | 3 |
| LicenseRef-LICENSE | 3 |
| MPL-2.0 | 3 |
| 0BSD | 2 |
| MIT-0 | 1 |
| BSD | 1 |
| EPL-2.0 | 1 |
| Standard 'no charge' license: https://gsap.com/standard-license. | 1 |
| UNKNOWN | 1 |

## 二、需要特别说明的三个依赖

| 包 | 情况 | 本项目的处理 |
| --- | --- | --- |
| **GSAP** | 不使用标准开源许可，而是 GreenSock 官方自定义的 "no charge" 条款（Standard License）：允许免费商用，但限制「转售 GSAP 本身 / 开发与 GSAP 直接竞争的产品」 | 本项目仅在界面动画中使用，不使用其 Club 付费插件，也不构成对 GSAP 的转售或竞品 |
| **jszip** | 采用 `MIT OR GPL-3.0-or-later` 双许可 | 本项目**选择 MIT 条款**使用 |
| **khroma** | 包内 package.json 未声明 license 字段（上游遗漏），实际为 MIT | 按 MIT 使用，并在此注明 |

### 其余需要人工复核的许可

- jszip@3.10.1 :: (MIT OR GPL-3.0-or-later)
- khroma@2.1.0 :: UNKNOWN

## 三、JavaScript/TypeScript 依赖清单

| 包 | 版本 | 许可 | 仓库 |
| --- | --- | --- | --- |
| @agentclientprotocol/codex-acp | 2.1.1 | Apache-2.0 | https://github.com/agentclientprotocol/codex-acp |
| @agentclientprotocol/sdk | 1.7.0 | Apache-2.0 | https://github.com/agentclientprotocol/typescript-sdk |
| @aiden0z/pptx-renderer | 1.2.4 | Apache-2.0 | https://github.com/aiden0z/pptx-renderer |
| @antfu/install-pkg | 1.1.0 | MIT | https://github.com/antfu/install-pkg |
| @anthropic-ai/sdk | 0.129.0 | MIT | github:anthropics/anthropic-sdk-typescript |
| @aws-sdk/client-bedrock-runtime | 3.1127.0 | Apache-2.0 | https://github.com/aws/aws-sdk-js-v3 |
| @aws-sdk/core | 3.978.2 | Apache-2.0 | https://github.com/aws/aws-sdk-js-v3 |
| @aws-sdk/credential-provider-env | 3.972.73 | Apache-2.0 | https://github.com/aws/aws-sdk-js-v3 |
| @aws-sdk/credential-provider-http | 3.972.75 | Apache-2.0 | https://github.com/aws/aws-sdk-js-v3 |
| @aws-sdk/credential-provider-ini | 3.973.18 | Apache-2.0 | https://github.com/aws/aws-sdk-js-v3 |
| @aws-sdk/credential-provider-login | 3.972.80 | Apache-2.0 | https://github.com/aws/aws-sdk-js-v3 |
| @aws-sdk/credential-provider-node | 3.972.85 | Apache-2.0 | https://github.com/aws/aws-sdk-js-v3 |
| @aws-sdk/credential-provider-process | 3.972.73 | Apache-2.0 | https://github.com/aws/aws-sdk-js-v3 |
| @aws-sdk/credential-provider-sso | 3.973.17 | Apache-2.0 | https://github.com/aws/aws-sdk-js-v3 |
| @aws-sdk/credential-provider-web-identity | 3.972.79 | Apache-2.0 | https://github.com/aws/aws-sdk-js-v3 |
| @aws-sdk/eventstream-handler-node | 3.972.36 | Apache-2.0 | https://github.com/aws/aws-sdk-js-v3 |
| @aws-sdk/middleware-eventstream | 3.972.31 | Apache-2.0 | https://github.com/aws/aws-sdk-js-v3 |
| @aws-sdk/middleware-websocket | 3.972.55 | Apache-2.0 | https://github.com/aws/aws-sdk-js-v3 |
| @aws-sdk/nested-clients | 3.997.47 | Apache-2.0 | https://github.com/aws/aws-sdk-js-v3 |
| @aws-sdk/signature-v4-multi-region | 3.996.48 | Apache-2.0 | https://github.com/aws/aws-sdk-js-v3 |
| @aws-sdk/token-providers | 3.1127.0 | Apache-2.0 | https://github.com/aws/aws-sdk-js-v3 |
| @aws-sdk/types | 3.974.6 | Apache-2.0 | https://github.com/aws/aws-sdk-js-v3 |
| @aws-sdk/xml-builder | 3.972.41 | Apache-2.0 | https://github.com/aws/aws-sdk-js-v3 |
| @aws/lambda-invoke-store | 0.3.0 | Apache-2.0 | https://github.com/awslabs/aws-lambda-invoke-store |
| @babel/helper-string-parser | 7.29.7 | MIT | https://github.com/babel/babel |
| @babel/helper-validator-identifier | 7.29.7 | MIT | https://github.com/babel/babel |
| @babel/parser | 7.29.8 | MIT | https://github.com/babel/babel |
| @babel/runtime | 7.29.10 | MIT | https://github.com/babel/babel |
| @babel/types | 7.29.8 | MIT | https://github.com/babel/babel |
| @braintree/sanitize-url | 7.1.2 | MIT | https://github.com/braintree/sanitize-url |
| @chevrotain/cst-dts-gen | 11.1.2 | Apache-2.0 | git://github.com/Chevrotain/chevrotain |
| @chevrotain/gast | 11.1.2 | Apache-2.0 | git://github.com/Chevrotain/chevrotain |
| @chevrotain/regexp-to-ast | 11.1.2 | Apache-2.0 | git://github.com/Chevrotain/chevrotain |
| @chevrotain/types | 11.1.2 | Apache-2.0 | git://github.com/Chevrotain/chevrotain |
| @chevrotain/utils | 11.1.2 | Apache-2.0 | git://github.com/Chevrotain/chevrotain |
| @earendil-works/pi-agent-core | 1.1.0 | MIT | https://github.com/earendil-works/pi |
| @earendil-works/pi-ai | 1.1.0 | MIT | https://github.com/earendil-works/pi |
| @earendil-works/pi-telemetry | 1.1.0 | MIT | https://github.com/earendil-works/pi |
| @esbuild/win32-x64 | 0.28.2 | MIT | https://github.com/evanw/esbuild |
| @esbuild/win32-x64 | 0.25.12 | MIT | https://github.com/evanw/esbuild |
| @esotericsoftware/spine-canvas | 4.3.13 | LicenseRef-LICENSE | https://github.com/EsotericSoftware/spine-runtimes |
| @esotericsoftware/spine-core | 4.3.13 | LicenseRef-LICENSE | https://github.com/EsotericSoftware/spine-runtimes |
| @esotericsoftware/spine-pixi-v8 | 4.3.13 | LicenseRef-LICENSE | https://github.com/EsotericSoftware/spine-runtimes |
| @google/genai | 2.21.0 | Apache-2.0 | https://github.com/googleapis/js-genai |
| @hono/node-server | 2.1.1 | MIT | https://github.com/honojs/node-server |
| @iconify/types | 2.0.0 | MIT | https://github.com/iconify/iconify |
| @iconify/utils | 3.1.4 | MIT | https://github.com/iconify/iconify |
| @jridgewell/gen-mapping | 0.3.13 | MIT | https://github.com/jridgewell/sourcemaps |
| @jridgewell/remapping | 2.3.5 | MIT | https://github.com/jridgewell/sourcemaps |
| @jridgewell/resolve-uri | 3.1.2 | MIT | https://github.com/jridgewell/resolve-uri |
| @jridgewell/sourcemap-codec | 1.5.5 | MIT | https://github.com/jridgewell/sourcemaps |
| @jridgewell/trace-mapping | 0.3.31 | MIT | https://github.com/jridgewell/sourcemaps |
| @kenjiuno/decompressrtf | 0.1.4 | BSD-2-Clause | github:HiraokaHyperTools/DeCompressRTF |
| @kenjiuno/msgreader | 1.28.0 | Apache-2.0 | github:HiraokaHyperTools/msgreader |
| @mapbox/togeojson | 0.16.2 | BSD-2-Clause | git://github.com/mapbox/togeojson |
| @mermaid-js/parser | 1.2.1 | MIT | https://github.com/mermaid-js/mermaid |
| @mermaid-js/parser | 2.0.0 | MIT | https://github.com/mermaid-js/mermaid |
| @modelcontextprotocol/sdk | 1.30.0 | MIT | https://github.com/modelcontextprotocol/typescript-sdk |
| @napi-rs/canvas | 1.0.7 | MIT | https://github.com/Brooooooklyn/canvas |
| @napi-rs/canvas-win32-x64-msvc | 1.0.7 | MIT | https://github.com/Brooooooklyn/canvas |
| @open-file-viewer/core | 0.1.42 | MIT | https://github.com/xushanpei/open-file-viewer |
| @open-file-viewer/vue | 0.1.42 | MIT | https://github.com/xushanpei/open-file-viewer |
| @openai/codex | 0.159.3 | Apache-2.0 | https://github.com/openai/codex |
| @openai/codex | 0.159.3-win32-x64 | Apache-2.0 | https://github.com/openai/codex |
| @pixi/colord | 2.9.6 | MIT | omgovich/colord |
| @protobufjs/aspromise | 1.1.2 | BSD-3-Clause | https://github.com/dcodeIO/protobuf.js |
| @protobufjs/base64 | 1.1.2 | BSD-3-Clause | https://github.com/dcodeIO/protobuf.js |
| @protobufjs/codegen | 2.0.5 | BSD-3-Clause | https://github.com/dcodeIO/protobuf.js |
| @protobufjs/eventemitter | 1.1.1 | BSD-3-Clause | https://github.com/dcodeIO/protobuf.js |
| @protobufjs/fetch | 1.1.1 | BSD-3-Clause | https://github.com/dcodeIO/protobuf.js |
| @protobufjs/float | 1.0.2 | BSD-3-Clause | https://github.com/dcodeIO/protobuf.js |
| @protobufjs/path | 1.1.2 | BSD-3-Clause | https://github.com/dcodeIO/protobuf.js |
| @protobufjs/pool | 1.1.0 | BSD-3-Clause | https://github.com/dcodeIO/protobuf.js |
| @protobufjs/utf8 | 1.1.2 | BSD-3-Clause | https://github.com/protobufjs/protobuf.js |
| @rollup/rollup-win32-x64-gnu | 4.62.4 | MIT | https://github.com/rollup/rollup |
| @rollup/rollup-win32-x64-msvc | 4.62.4 | MIT | https://github.com/rollup/rollup |
| @smithy/core | 3.35.2 | Apache-2.0 | https://github.com/smithy-lang/smithy-typescript |
| @smithy/credential-provider-imds | 4.5.2 | Apache-2.0 | https://github.com/smithy-lang/smithy-typescript |
| @smithy/fetch-http-handler | 5.8.0 | Apache-2.0 | https://github.com/smithy-lang/smithy-typescript |
| @smithy/node-http-handler | 4.12.1 | Apache-2.0 | https://github.com/smithy-lang/smithy-typescript |
| @smithy/signature-v4 | 5.7.4 | Apache-2.0 | https://github.com/smithy-lang/smithy-typescript |
| @smithy/types | 4.19.0 | Apache-2.0 | https://github.com/smithy-lang/smithy-typescript |
| @stablelib/base64 | 1.0.1 | MIT | https://github.com/StableLib/stablelib |
| @tailwindcss/node | 4.3.3 | MIT | https://github.com/tailwindlabs/tailwindcss |
| @tailwindcss/oxide | 4.3.3 | MIT | https://github.com/tailwindlabs/tailwindcss |
| @tailwindcss/oxide-win32-x64-msvc | 4.3.3 | MIT | https://github.com/tailwindlabs/tailwindcss |
| @tailwindcss/vite | 4.3.3 | MIT | https://github.com/tailwindlabs/tailwindcss |
| @tauri-apps/api | 2.11.1 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| @tauri-apps/cli | 2.11.4 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| @tauri-apps/cli-win32-x64-msvc | 2.11.4 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| @tauri-apps/plugin-dialog | 2.7.2 | MIT OR Apache-2.0 | https://github.com/tauri-apps/plugins-workspace |
| @tauri-apps/plugin-notification | 2.4.0 | MIT OR Apache-2.0 | https://github.com/tauri-apps/plugins-workspace |
| @tauri-apps/plugin-store | 2.4.4 | MIT OR Apache-2.0 | https://github.com/tauri-apps/plugins-workspace |
| @types/d3 | 7.4.3 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-array | 3.2.2 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-axis | 3.0.6 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-brush | 3.0.6 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-chord | 3.0.6 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-color | 3.1.3 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-contour | 3.0.6 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-delaunay | 6.0.4 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-dispatch | 3.0.7 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-drag | 3.0.7 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-dsv | 3.0.7 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-ease | 3.0.2 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-fetch | 3.0.7 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-force | 3.0.10 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-format | 3.0.4 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-geo | 3.1.1 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-hierarchy | 3.1.7 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-interpolate | 3.0.4 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-path | 3.1.1 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-polygon | 3.0.2 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-quadtree | 3.0.6 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-random | 3.0.4 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-scale | 4.0.9 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-scale-chromatic | 3.1.0 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-selection | 3.0.11 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-shape | 3.1.8 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-time | 3.0.4 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-time-format | 4.0.3 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-timer | 3.0.2 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-transition | 3.0.9 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-zoom | 3.0.8 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/debug | 4.1.13 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/earcut | 3.0.0 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/estree | 1.0.9 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/geojson | 7946.0.16 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/hast | 3.0.5 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/katex | 0.16.8 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/mdast | 4.0.4 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/ms | 2.1.0 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/node | 22.20.1 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/qrcode | 1.5.6 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/retry | 0.12.0 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/trusted-types | 2.0.7 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/unist | 3.0.3 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/ws | 8.18.1 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @upsetjs/venn.js | 2.0.0 | MIT | https://github.com/upsetjs/venn.js |
| @vitejs/plugin-vue | 5.2.4 | MIT | https://github.com/vitejs/vite-plugin-vue |
| @vue/compiler-core | 3.5.41 | MIT | https://github.com/vuejs/core |
| @vue/compiler-dom | 3.5.41 | MIT | https://github.com/vuejs/core |
| @vue/compiler-sfc | 3.5.41 | MIT | https://github.com/vuejs/core |
| @vue/compiler-ssr | 3.5.41 | MIT | https://github.com/vuejs/core |
| @vue/devtools-api | 7.7.10 | MIT | https://github.com/vuejs/devtools |
| @vue/devtools-kit | 7.7.10 | MIT | https://github.com/vuejs/devtools |
| @vue/devtools-shared | 7.7.10 | MIT | https://github.com/vuejs/devtools |
| @vue/reactivity | 3.5.41 | MIT | https://github.com/vuejs/core |
| @vue/runtime-core | 3.5.41 | MIT | https://github.com/vuejs/core |
| @vue/runtime-dom | 3.5.41 | MIT | https://github.com/vuejs/core |
| @vue/server-renderer | 3.5.41 | MIT | https://github.com/vuejs/core |
| @vue/shared | 3.5.41 | MIT | https://github.com/vuejs/core |
| @webgpu/types | 0.1.72 | BSD-3-Clause | gpuweb/types |
| @xmldom/xmldom | 0.8.14 | MIT | git://github.com/xmldom/xmldom |
| accepts | 2.0.0 | MIT | jshttp/accepts |
| adler-32 | 1.3.1 | Apache-2.0 | git://github.com/SheetJS/js-adler32 |
| ag-psd | 30.2.0 | MIT | https://github.com/Agamnentzar/ag-psd |
| agent-base | 9.0.0 | MIT | https://github.com/TooTallNate/proxy-agents |
| ajv | 8.20.0 | MIT | ajv-validator/ajv |
| ajv-formats | 3.0.1 | MIT | https://github.com/ajv-validator/ajv-formats |
| ansi-regex | 5.0.1 | MIT | chalk/ansi-regex |
| ansi-styles | 4.3.0 | MIT | chalk/ansi-styles |
| argparse | 1.0.10 | MIT | nodeca/argparse |
| base64-js | 1.5.1 | MIT | git://github.com/beatgammit/base64-js |
| bignumber.js | 9.3.1 | MIT | https://github.com/MikeMcl/bignumber.js |
| birpc | 2.9.0 | MIT | https://github.com/antfu-collective/birpc |
| bluebird | 3.4.7 | MIT | git://github.com/petkaantonov/bluebird |
| body-parser | 2.3.0 | MIT | expressjs/body-parser |
| bowser | 2.14.1 | MIT | https://github.com/bowser-js/bowser |
| buffer-equal-constant-time | 1.0.1 | BSD-3-Clause | git@github.com:goinstant/buffer-equal-constant-time |
| buffer-from | 1.1.2 | MIT | LinusU/buffer-from |
| bundle-name | 4.1.1 | MIT | sindresorhus/bundle-name |
| but-unzip | 0.1.10 | Apache-2.0 |  |
| bytes | 3.1.2 | MIT | visionmedia/bytes.js |
| call-bind-apply-helpers | 1.0.2 | MIT | https://github.com/ljharb/call-bind-apply-helpers |
| call-bound | 1.0.4 | MIT | https://github.com/ljharb/call-bound |
| camelcase | 5.3.1 | MIT | sindresorhus/camelcase |
| ccount | 2.0.1 | MIT | wooorm/ccount |
| cfb | 1.2.2 | Apache-2.0 | git://github.com/SheetJS/js-cfb |
| character-entities | 2.0.2 | MIT | wooorm/character-entities |
| chevrotain | 11.1.2 | Apache-2.0 | git://github.com/Chevrotain/chevrotain |
| cliui | 6.0.0 | ISC | http://github.com/yargs/cliui |
| cobe | 2.0.1 | MIT | shuding/cobe |
| codepage | 1.15.0 | Apache-2.0 | git://github.com/SheetJS/js-codepage |
| color-convert | 2.0.1 | MIT | Qix-/color-convert |
| color-name | 1.1.4 | MIT | git@github.com:colorjs/color-name |
| commander | 15.0.0 | MIT | https://github.com/tj/commander.js |
| commander | 2.20.3 | MIT | https://github.com/tj/commander.js |
| commander | 6.2.1 | MIT | https://github.com/tj/commander.js |
| commander | 7.2.0 | MIT | https://github.com/tj/commander.js |
| commander | 8.3.0 | MIT | https://github.com/tj/commander.js |
| concat-stream | 2.0.0 | MIT | http://github.com/maxogden/concat-stream |
| content-disposition | 1.1.0 | MIT | jshttp/content-disposition |
| content-type | 1.0.5 | MIT | jshttp/content-type |
| cookie | 0.7.2 | MIT | jshttp/cookie |
| cookie-signature | 1.2.2 | MIT | https://github.com/visionmedia/node-cookie-signature |
| copy-anything | 4.0.5 | MIT | https://github.com/mesqueeb/copy-anything |
| core-util-is | 1.0.3 | MIT | git://github.com/isaacs/core-util-is |
| cors | 2.8.6 | MIT | expressjs/cors |
| cose-base | 1.0.3 | MIT | https://github.com/iVis-at-Bilkent/cose-base |
| cose-base | 2.2.0 | MIT | https://github.com/iVis-at-Bilkent/cose-base |
| crc-32 | 1.2.2 | Apache-2.0 | git://github.com/SheetJS/js-crc32 |
| cross-spawn | 7.0.6 | MIT | git@github.com:moxystudio/node-cross-spawn |
| csstype | 3.2.3 | MIT | https://github.com/frenic/csstype |
| cytoscape | 3.34.1 | MIT | https://github.com/cytoscape/cytoscape.js |
| cytoscape-cose-bilkent | 4.1.0 | MIT | https://github.com/cytoscape/cytoscape.js-cose-bilkent |
| cytoscape-fcose | 2.2.0 | MIT | https://github.com/iVis-at-Bilkent/cytoscape.js-fcose |
| d3 | 7.9.0 | ISC | https://github.com/d3/d3 |
| d3-array | 2.12.1 | BSD-3-Clause | https://github.com/d3/d3-array |
| d3-array | 3.2.4 | ISC | https://github.com/d3/d3-array |
| d3-axis | 3.0.0 | ISC | https://github.com/d3/d3-axis |
| d3-brush | 3.0.0 | ISC | https://github.com/d3/d3-brush |
| d3-chord | 3.0.1 | ISC | https://github.com/d3/d3-chord |
| d3-color | 3.1.0 | ISC | https://github.com/d3/d3-color |
| d3-contour | 4.0.2 | ISC | https://github.com/d3/d3-contour |
| d3-delaunay | 6.0.4 | ISC | https://github.com/d3/d3-delaunay |
| d3-dispatch | 3.0.1 | ISC | https://github.com/d3/d3-dispatch |
| d3-drag | 3.0.0 | ISC | https://github.com/d3/d3-drag |
| d3-dsv | 3.0.1 | ISC | https://github.com/d3/d3-dsv |
| d3-ease | 3.0.1 | BSD-3-Clause | https://github.com/d3/d3-ease |
| d3-fetch | 3.0.1 | ISC | https://github.com/d3/d3-fetch |
| d3-force | 3.0.0 | ISC | https://github.com/d3/d3-force |
| d3-format | 3.1.2 | ISC | https://github.com/d3/d3-format |
| d3-geo | 3.1.1 | ISC | https://github.com/d3/d3-geo |
| d3-hierarchy | 3.1.2 | ISC | https://github.com/d3/d3-hierarchy |
| d3-interpolate | 3.0.1 | ISC | https://github.com/d3/d3-interpolate |
| d3-path | 3.1.0 | ISC | https://github.com/d3/d3-path |
| d3-path | 1.0.9 | BSD-3-Clause | https://github.com/d3/d3-path |
| d3-polygon | 3.0.1 | ISC | https://github.com/d3/d3-polygon |
| d3-quadtree | 3.0.1 | ISC | https://github.com/d3/d3-quadtree |
| d3-random | 3.0.1 | ISC | https://github.com/d3/d3-random |
| d3-sankey | 0.12.3 | BSD-3-Clause | https://github.com/d3/d3-sankey |
| d3-scale | 4.0.2 | ISC | https://github.com/d3/d3-scale |
| d3-scale-chromatic | 3.1.0 | ISC | https://github.com/d3/d3-scale-chromatic |
| d3-selection | 3.0.0 | ISC | https://github.com/d3/d3-selection |
| d3-shape | 1.3.7 | BSD-3-Clause | https://github.com/d3/d3-shape |
| d3-shape | 3.2.0 | ISC | https://github.com/d3/d3-shape |
| d3-time | 3.1.0 | ISC | https://github.com/d3/d3-time |
| d3-time-format | 4.1.0 | ISC | https://github.com/d3/d3-time-format |
| d3-timer | 3.0.1 | ISC | https://github.com/d3/d3-timer |
| d3-transition | 3.0.1 | ISC | https://github.com/d3/d3-transition |
| d3-zoom | 3.0.0 | ISC | https://github.com/d3/d3-zoom |
| dagre-d3-es | 7.0.14 | MIT | https://github.com/tbo47/dagre-es |
| data-uri-to-buffer | 4.0.1 | MIT | git://github.com/TooTallNate/node-data-uri-to-buffer |
| dayjs | 1.11.23 | MIT | https://github.com/iamkun/dayjs |
| debug | 4.4.3 | MIT | git://github.com/debug-js/debug |
| decamelize | 1.2.0 | MIT | sindresorhus/decamelize |
| decode-named-character-reference | 1.3.0 | MIT | wooorm/decode-named-character-reference |
| default-browser | 5.5.1 | MIT | sindresorhus/default-browser |
| default-browser-id | 5.0.1 | MIT | sindresorhus/default-browser-id |
| define-lazy-prop | 3.0.0 | MIT | sindresorhus/define-lazy-prop |
| delaunator | 5.1.0 | ISC | https://github.com/mapbox/delaunator |
| depd | 2.0.0 | MIT | dougwilson/nodejs-depd |
| dequal | 2.0.3 | MIT | lukeed/dequal |
| detect-libc | 2.1.2 | Apache-2.0 | git://github.com/lovell/detect-libc |
| devlop | 1.1.0 | MIT | wooorm/devlop |
| dijkstrajs | 1.0.3 | MIT | git://github.com/tcort/dijkstrajs |
| dingbat-to-unicode | 1.0.1 | BSD-2-Clause | https://github.com/mwilliamson/dingbat-to-unicode |
| docx-preview | 0.3.7 | Apache-2.0 | https://github.com/VolodymyrBaydalka/docxjs |
| dompurify | 3.4.14 | (MPL-2.0 OR Apache-2.0) | git://github.com/cure53/DOMPurify |
| duck | 0.1.12 | BSD | https://github.com/mwilliamson/duck.js |
| dunder-proto | 1.0.1 | MIT | https://github.com/es-shims/dunder-proto |
| earcut | 3.2.3 | ISC | git://github.com/mapbox/earcut |
| ecdsa-sig-formatter | 1.0.11 | Apache-2.0 | ssh://git@github.com/Brightspace/node-ecdsa-sig-formatter |
| echarts | 6.1.0 | Apache-2.0 | https://github.com/apache/echarts |
| ee-first | 1.1.1 | MIT | jonathanong/ee-first |
| elkjs | 0.9.3 | EPL-2.0 | https://github.com/kieler/elkjs |
| emf-converter | 2.0.2 | Apache-2.0 | https://github.com/ChristopherVR/emf-converter |
| emoji-regex | 8.0.0 | MIT | https://github.com/mathiasbynens/emoji-regex |
| encodeurl | 2.0.0 | MIT | pillarjs/encodeurl |
| enhanced-resolve | 5.24.5 | MIT | https://github.com/webpack/enhanced-resolve |
| entities | 7.0.1 | BSD-2-Clause | https://github.com/fb55/entities |
| es-define-property | 1.0.1 | MIT | https://github.com/ljharb/es-define-property |
| es-errors | 1.3.0 | MIT | https://github.com/ljharb/es-errors |
| es-object-atoms | 1.1.2 | MIT | https://github.com/ljharb/es-object-atoms |
| es-toolkit | 1.51.0 | MIT | https://github.com/toss/es-toolkit |
| esbuild | 0.28.2 | MIT | https://github.com/evanw/esbuild |
| esbuild | 0.25.12 | MIT | https://github.com/evanw/esbuild |
| escape-html | 1.0.3 | MIT | component/escape-html |
| escape-string-regexp | 5.0.0 | MIT | sindresorhus/escape-string-regexp |
| estree-walker | 2.0.2 | MIT | https://github.com/Rich-Harris/estree-walker |
| etag | 1.8.1 | MIT | jshttp/etag |
| eventemitter3 | 5.0.4 | MIT | git://github.com/primus/eventemitter3 |
| eventsource | 3.0.7 | MIT | git://git@github.com/EventSource/eventsource |
| eventsource-parser | 3.1.1 | MIT | ssh://git@github.com/rexxars/eventsource-parser |
| express | 5.2.1 | MIT | expressjs/express |
| express-rate-limit | 8.7.0 | MIT | https://github.com/express-rate-limit/express-rate-limit |
| extend | 3.0.2 | MIT | https://github.com/justmoon/node-extend |
| fast-deep-equal | 3.1.3 | MIT | https://github.com/epoberezkin/fast-deep-equal |
| fast-sha256 | 1.3.0 | Unlicense | https://github.com/dchest/fast-sha256-js |
| fast-uri | 3.1.6 | BSD-3-Clause | https://github.com/fastify/fast-uri |
| fastdom | 1.0.12 | MIT | git://github.com/wilsonpage/fastdom |
| fdir | 6.5.0 | MIT | https://github.com/thecodrr/fdir |
| fetch-blob | 3.2.0 | MIT | https://github.com/node-fetch/fetch-blob |
| fflate | 0.8.3 | MIT | https://github.com/101arrowz/fflate |
| finalhandler | 2.1.1 | MIT | pillarjs/finalhandler |
| find-up | 4.1.0 | MIT | sindresorhus/find-up |
| formdata-polyfill | 4.0.10 | MIT | https://jimmywarting@github.com/jimmywarting/FormData |
| forwarded | 0.2.0 | MIT | jshttp/forwarded |
| frac | 1.1.2 | Apache-2.0 | git://github.com/SheetJS/frac |
| fresh | 2.0.0 | MIT | jshttp/fresh |
| function-bind | 1.1.2 | MIT | https://github.com/Raynos/function-bind |
| gaxios | 7.3.1 | Apache-2.0 | https://github.com/googleapis/google-cloud-node |
| gcp-metadata | 8.1.2 | Apache-2.0 | https://github.com/googleapis/google-cloud-node-core |
| get-caller-file | 2.0.5 | ISC | https://github.com/stefanpenner/get-caller-file |
| get-intrinsic | 1.3.0 | MIT | https://github.com/ljharb/get-intrinsic |
| get-proto | 1.0.1 | MIT | https://github.com/ljharb/get-proto |
| gifuct-js | 2.1.2 | MIT | https://github.com/matt-way/gifuct-js |
| google-auth-library | 10.9.1 | Apache-2.0 | https://github.com/googleapis/google-cloud-node |
| google-logging-utils | 1.1.3 | Apache-2.0 | https://github.com/googleapis/google-cloud-node-core |
| gopd | 1.2.0 | MIT | https://github.com/ljharb/gopd |
| graceful-fs | 4.2.11 | ISC | https://github.com/isaacs/node-graceful-fs |
| gsap | 3.15.0 | Standard 'no charge' license: https://gsap.com/standard-license. | https://github.com/greensock/GSAP |
| hachure-fill | 0.5.2 | MIT | https://github.com/pshihn/hachure-fill |
| has-symbols | 1.1.0 | MIT | git://github.com/inspect-js/has-symbols |
| hasown | 2.0.4 | MIT | https://github.com/inspect-js/hasOwn |
| heic2any | 0.0.4 | MIT | https://github.com/alexcorvi/heic2any |
| hls.js | 1.7.1 | Apache-2.0 | https://github.com/video-dev/hls.js |
| hono | 4.13.5 | MIT | https://github.com/honojs/hono |
| hookable | 5.5.3 | MIT | unjs/hookable |
| http-errors | 2.0.1 | MIT | jshttp/http-errors |
| http-proxy-agent | 9.1.0 | MIT | https://github.com/TooTallNate/proxy-agents |
| https-proxy-agent | 9.1.0 | MIT | https://github.com/TooTallNate/proxy-agents |
| hyparquet | 1.29.1 | MIT | https://github.com/hyparam/hyparquet |
| iconv-lite | 0.7.3 | MIT | https://github.com/pillarjs/iconv-lite |
| iconv-lite | 0.6.3 | MIT | git://github.com/ashtuchkin/iconv-lite |
| immediate | 3.0.6 | MIT | git://github.com/calvinmetcalf/immediate |
| import-meta-resolve | 4.2.0 | MIT | wooorm/import-meta-resolve |
| inherits | 2.0.4 | ISC | git://github.com/isaacs/inherits |
| internmap | 1.0.1 | ISC | https://github.com/mbostock/internmap |
| internmap | 2.0.3 | ISC | https://github.com/mbostock/internmap |
| ip-address | 10.7.0 | MIT | https://github.com/beaugunderson/ip-address |
| ipaddr.js | 1.9.1 | MIT | git://github.com/whitequark/ipaddr.js |
| is-docker | 3.0.0 | MIT | sindresorhus/is-docker |
| is-fullwidth-code-point | 3.0.0 | MIT | sindresorhus/is-fullwidth-code-point |
| is-in-ssh | 1.0.0 | MIT | sindresorhus/is-in-ssh |
| is-inside-container | 1.0.0 | MIT | sindresorhus/is-inside-container |
| is-promise | 4.0.0 | MIT | https://github.com/then/is-promise |
| is-what | 5.5.0 | MIT | https://github.com/mesqueeb/is-what |
| is-wsl | 3.1.1 | MIT | sindresorhus/is-wsl |
| isarray | 1.0.0 | MIT | git://github.com/juliangruber/isarray |
| isexe | 2.0.0 | ISC | https://github.com/isaacs/isexe |
| ismobilejs | 1.1.1 | MIT | https://github.com/kaimallea/isMobile |
| jiti | 2.7.0 | MIT | unjs/jiti |
| jose | 6.2.10 | MIT | panva/jose |
| js-binary-schema-parser | 2.0.3 | MIT | https://github.com/matt-way/jsBinarySchemaParser |
| json-bigint | 1.0.0 | MIT | git@github.com:sidorares/json-bigint |
| json-schema-to-ts | 3.1.1 | MIT | https://github.com/ThomasAribart/json-schema-to-ts |
| json-schema-traverse | 1.0.0 | MIT | https://github.com/epoberezkin/json-schema-traverse |
| json-schema-typed | 8.0.2 | BSD-2-Clause | https://github.com/RemyRylan/json-schema-typed |
| jszip | 3.10.1 | (MIT OR GPL-3.0-or-later) | https://github.com/Stuk/jszip |
| jwa | 2.0.1 | MIT | git://github.com/brianloveswords/node-jwa |
| jws | 4.0.1 | MIT | git://github.com/brianloveswords/node-jws |
| katex | 0.16.47 | MIT | https://github.com/KaTeX/KaTeX |
| katex | 0.18.7 | MIT | https://github.com/KaTeX/KaTeX |
| khroma | 2.1.0 | UNKNOWN | github:fabiospampinato/khroma |
| layout-base | 1.0.2 | MIT | https://github.com/iVis-at-Bilkent/layout-base |
| layout-base | 2.0.1 | MIT | https://github.com/iVis-at-Bilkent/layout-base |
| leaflet | 1.9.4 | BSD-2-Clause | git://github.com/Leaflet/Leaflet |
| lie | 3.3.0 | MIT | https://github.com/calvinmetcalf/lie |
| lightningcss | 1.32.0 | MPL-2.0 | https://github.com/parcel-bundler/lightningcss |
| lightningcss-win32-x64-msvc | 1.32.0 | MPL-2.0 | https://github.com/parcel-bundler/lightningcss |
| locate-path | 5.0.0 | MIT | sindresorhus/locate-path |
| lodash-es | 4.17.23 | MIT | lodash/lodash |
| lodash-es | 4.18.1 | MIT | lodash/lodash |
| long | 5.3.2 | Apache-2.0 | https://github.com/dcodeIO/long.js |
| longest-streak | 3.1.0 | MIT | wooorm/longest-streak |
| lop | 0.4.2 | BSD-2-Clause | https://github.com/mwilliamson/lop |
| lucide-vue-next | 0.475.0 | ISC | https://github.com/lucide-icons/lucide |
| magic-string | 0.30.21 | MIT | https://github.com/Rich-Harris/magic-string |
| mammoth | 1.12.1 | BSD-2-Clause | https://github.com/mwilliamson/mammoth.js |
| markdown-table | 3.0.4 | MIT | wooorm/markdown-table |
| marked | 18.0.10 | MIT | https://github.com/markedjs/marked |
| marked | 16.4.2 | MIT | git://github.com/markedjs/marked |
| math-intrinsics | 1.1.0 | MIT | https://github.com/es-shims/math-intrinsics |
| mdast-util-find-and-replace | 3.0.2 | MIT | syntax-tree/mdast-util-find-and-replace |
| mdast-util-from-markdown | 2.0.3 | MIT | syntax-tree/mdast-util-from-markdown |
| mdast-util-gfm | 3.1.0 | MIT | syntax-tree/mdast-util-gfm |
| mdast-util-gfm-autolink-literal | 2.0.1 | MIT | syntax-tree/mdast-util-gfm-autolink-literal |
| mdast-util-gfm-footnote | 2.1.0 | MIT | syntax-tree/mdast-util-gfm-footnote |
| mdast-util-gfm-strikethrough | 2.0.0 | MIT | syntax-tree/mdast-util-gfm-strikethrough |
| mdast-util-gfm-table | 2.0.0 | MIT | syntax-tree/mdast-util-gfm-table |
| mdast-util-gfm-task-list-item | 2.0.0 | MIT | syntax-tree/mdast-util-gfm-task-list-item |
| mdast-util-math | 3.0.0 | MIT | syntax-tree/mdast-util-math |
| mdast-util-phrasing | 4.1.0 | MIT | syntax-tree/mdast-util-phrasing |
| mdast-util-to-markdown | 2.1.2 | MIT | syntax-tree/mdast-util-to-markdown |
| mdast-util-to-string | 4.0.0 | MIT | syntax-tree/mdast-util-to-string |
| media-typer | 1.1.1 | MIT | jshttp/media-typer |
| merge-descriptors | 2.0.0 | MIT | sindresorhus/merge-descriptors |
| mermaid | 11.17.0 | MIT | https://github.com/mermaid-js/mermaid |
| mermaid | 12.0.0 | MIT | https://github.com/mermaid-js/mermaid |
| mgrs | 1.0.0 | MIT | git://github.com/proj4js/mgrs |
| micromark | 4.0.2 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark |
| micromark-core-commonmark | 2.0.3 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-core-commonmark |
| micromark-extension-gfm | 3.0.0 | MIT | micromark/micromark-extension-gfm |
| micromark-extension-gfm-autolink-literal | 2.1.0 | MIT | micromark/micromark-extension-gfm-autolink-literal |
| micromark-extension-gfm-footnote | 2.1.0 | MIT | micromark/micromark-extension-gfm-footnote |
| micromark-extension-gfm-strikethrough | 2.1.0 | MIT | micromark/micromark-extension-gfm-strikethrough |
| micromark-extension-gfm-table | 2.1.1 | MIT | micromark/micromark-extension-gfm-table |
| micromark-extension-gfm-tagfilter | 2.0.0 | MIT | micromark/micromark-extension-gfm-tagfilter |
| micromark-extension-gfm-task-list-item | 2.1.0 | MIT | micromark/micromark-extension-gfm-task-list-item |
| micromark-extension-math | 3.1.0 | MIT | micromark/micromark-extension-math |
| micromark-factory-destination | 2.0.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-factory-destination |
| micromark-factory-label | 2.0.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-factory-label |
| micromark-factory-space | 2.0.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-factory-space |
| micromark-factory-title | 2.0.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-factory-title |
| micromark-factory-whitespace | 2.0.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-factory-whitespace |
| micromark-util-character | 2.1.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-util-character |
| micromark-util-chunked | 2.0.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-util-chunked |
| micromark-util-classify-character | 2.0.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-util-classify-character |
| micromark-util-combine-extensions | 2.0.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-util-combine-extensions |
| micromark-util-decode-numeric-character-reference | 2.0.2 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-util-decode-numeric-character-reference |
| micromark-util-decode-string | 2.0.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-util-decode-string |
| micromark-util-encode | 2.0.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-util-encode |
| micromark-util-html-tag-name | 2.0.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-util-html-tag-name |
| micromark-util-normalize-identifier | 2.0.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-util-normalize-identifier |
| micromark-util-resolve-all | 2.0.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-util-resolve-all |
| micromark-util-sanitize-uri | 2.0.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-util-sanitize-uri |
| micromark-util-subtokenize | 2.1.0 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-util-subtokenize |
| micromark-util-symbol | 2.0.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-util-symbol |
| micromark-util-types | 2.0.2 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-util-types |
| mime-db | 1.54.0 | MIT | jshttp/mime-db |
| mime-types | 3.0.2 | MIT | jshttp/mime-types |
| minimist | 1.2.8 | MIT | git://github.com/minimistjs/minimist |
| mitt | 3.0.1 | MIT | developit/mitt |
| ms | 2.1.3 | MIT | vercel/ms |
| nanoid | 3.3.18 | MIT | ai/nanoid |
| negotiator | 1.1.0 | MIT | jshttp/negotiator |
| node-domexception | 1.0.0 | MIT | https://github.com/jimmywarting/node-domexception |
| node-fetch | 3.3.2 | MIT | https://github.com/node-fetch/node-fetch |
| object-assign | 4.1.1 | MIT | sindresorhus/object-assign |
| object-inspect | 1.13.4 | MIT | git://github.com/inspect-js/object-inspect |
| ogl | 1.0.11 | Unlicense | https://gordonnl@github.com/oframe/ogl |
| on-finished | 2.4.1 | MIT | jshttp/on-finished |
| once | 1.4.0 | ISC | git://github.com/isaacs/once |
| open | 11.0.4 | MIT | sindresorhus/open |
| openai | 7.19.0 | Apache-2.0 | github:openai/openai-node |
| option | 0.2.4 | BSD-2-Clause | https://github.com/mwilliamson/node-options |
| p-limit | 2.3.0 | MIT | sindresorhus/p-limit |
| p-locate | 4.1.0 | MIT | sindresorhus/p-locate |
| p-retry | 4.6.2 | MIT | sindresorhus/p-retry |
| p-try | 2.2.0 | MIT | sindresorhus/p-try |
| package-manager-detector | 1.8.0 | MIT | https://github.com/antfu-collective/package-manager-detector |
| pako | 2.2.0 | (MIT AND Zlib) | nodeca/pako |
| pako | 2.1.0 | (MIT AND Zlib) | nodeca/pako |
| pako | 1.0.11 | (MIT AND Zlib) | nodeca/pako |
| parse-svg-path | 0.2.0 | MIT | git://github.com/jkroso/parse-svg-path |
| parsedbf | 2.0.0 | MIT | git://github.com/calvinmetcalf/parseDBF |
| parseurl | 1.3.3 | MIT | pillarjs/parseurl |
| partial-json | 0.1.7 | MIT | https://github.com/promplate/partial-json-parser-js |
| path-data-parser | 0.1.0 | MIT | https://github.com/pshihn/path-data-parser |
| path-exists | 4.0.0 | MIT | sindresorhus/path-exists |
| path-is-absolute | 1.0.1 | MIT | sindresorhus/path-is-absolute |
| path-key | 3.1.1 | MIT | sindresorhus/path-key |
| path-to-regexp | 8.4.2 | MIT | https://github.com/pillarjs/path-to-regexp |
| pdfjs-dist | 6.2.108 | Apache-2.0 | https://github.com/mozilla/pdf.js |
| perfect-debounce | 1.0.0 | MIT | unjs/perfect-debounce |
| picocolors | 1.1.1 | ISC | alexeyraspopov/picocolors |
| picomatch | 4.0.5 | MIT | micromatch/picomatch |
| pinia | 3.0.4 | MIT | https://github.com/vuejs/pinia |
| pixi.js | 8.19.0 | MIT | https://github.com/pixijs/pixijs |
| pkce-challenge | 5.0.1 | MIT | https://github.com/crouchcd/pkce-challenge |
| playwright-core | 1.62.1 | Apache-2.0 | https://github.com/microsoft/playwright |
| pngjs | 5.0.0 | MIT | git://github.com/lukeapage/pngjs |
| points-on-curve | 0.2.0 | MIT | https://github.com/pshihn/bezier-points |
| points-on-path | 0.2.1 | MIT | https://github.com/pshihn/points-on-path |
| postal-mime | 2.7.6 | MIT-0 | https://github.com/postalsys/postal-mime |
| postcss | 8.5.26 | MIT | postcss/postcss |
| powershell-utils | 0.2.1 | MIT | sindresorhus/powershell-utils |
| prismjs | 1.30.0 | MIT | https://github.com/PrismJS/prism |
| process-nextick-args | 2.0.1 | MIT | https://github.com/calvinmetcalf/process-nextick-args |
| proj4 | 2.21.0 | MIT | https://github.com/proj4js/proj4js |
| protobufjs | 7.6.6 | BSD-3-Clause | protobufjs/protobuf.js |
| proxy-addr | 2.0.7 | MIT | jshttp/proxy-addr |
| proxy-agent-negotiate | 1.1.0 | MIT | https://github.com/TooTallNate/proxy-agents |
| qrcode | 1.5.4 | MIT | git://github.com/soldair/node-qrcode |
| qs | 6.15.3 | BSD-3-Clause | https://github.com/ljharb/qs |
| range-parser | 1.3.0 | MIT | jshttp/range-parser |
| raw-body | 3.0.2 | MIT | stream-utils/raw-body |
| react | 19.2.8 | MIT | https://github.com/react/react |
| react-dom | 19.2.8 | MIT | https://github.com/react/react |
| readable-stream | 3.6.2 | MIT | git://github.com/nodejs/readable-stream |
| readable-stream | 2.3.8 | MIT | git://github.com/nodejs/readable-stream |
| require-directory | 2.1.1 | MIT | git://github.com/troygoode/node-require-directory |
| require-from-string | 2.0.2 | MIT | floatdrop/require-from-string |
| require-main-filename | 2.0.0 | ISC | ssh://git@github.com/yargs/require-main-filename |
| retry | 0.13.1 | MIT | git://github.com/tim-kos/node-retry |
| rfdc | 1.4.1 | MIT | https://github.com/davidmarkclements/rfdc |
| robust-predicates | 3.0.3 | Unlicense | https://github.com/mourner/robust-predicates |
| rollup | 4.62.4 | MIT | https://github.com/rollup/rollup |
| roughjs | 4.6.6 | MIT | https://github.com/pshihn/rough |
| router | 2.2.0 | MIT | pillarjs/router |
| run-applescript | 7.1.0 | MIT | sindresorhus/run-applescript |
| rw | 1.3.3 | BSD-3-Clause | http://github.com/mbostock/rw |
| safe-buffer | 5.2.1 | MIT | git://github.com/feross/safe-buffer |
| safe-buffer | 5.1.2 | MIT | git://github.com/feross/safe-buffer |
| safer-buffer | 2.1.2 | MIT | https://github.com/ChALkeR/safer-buffer |
| scheduler | 0.27.0 | MIT | https://github.com/facebook/react |
| seek-bzip | 2.0.0 | MIT | https://github.com/cscott/seek-bzip |
| send | 1.2.1 | MIT | pillarjs/send |
| serve-static | 2.2.1 | MIT | expressjs/serve-static |
| set-blocking | 2.0.0 | ISC | https://github.com/yargs/set-blocking |
| setimmediate | 1.0.5 | MIT | YuzuJS/setImmediate |
| setprototypeof | 1.2.0 | ISC | https://github.com/wesleytodd/setprototypeof |
| shebang-command | 2.0.0 | MIT | kevva/shebang-command |
| shebang-regex | 3.0.0 | MIT | sindresorhus/shebang-regex |
| shpjs | 6.2.0 | MIT | git://github.com/calvinmetcalf/shapefile-js |
| side-channel | 1.1.1 | MIT | https://github.com/ljharb/side-channel |
| side-channel-list | 1.0.1 | MIT | https://github.com/ljharb/side-channel-list |
| side-channel-map | 1.0.1 | MIT | https://github.com/ljharb/side-channel-map |
| side-channel-weakmap | 1.0.2 | MIT | https://github.com/ljharb/side-channel-weakmap |
| source-map-js | 1.2.1 | BSD-3-Clause | 7rulnik/source-map-js |
| speakingurl | 14.0.1 | BSD-3-Clause | https://github.com/pid/speakingurl |
| sprintf-js | 1.0.3 | BSD-3-Clause | https://github.com/alexei/sprintf.js |
| ssf | 0.11.2 | Apache-2.0 | git://github.com/SheetJS/ssf |
| standardwebhooks | 1.1.1 | MIT | https://github.com/standard-webhooks/standard-webhooks |
| statuses | 2.0.2 | MIT | jshttp/statuses |
| strictdom | 1.0.1 | MIT | git://github.com/wilsonpage/strictdom |
| string_decoder | 1.1.1 | MIT | git://github.com/nodejs/string_decoder |
| string_decoder | 1.3.0 | MIT | git://github.com/nodejs/string_decoder |
| string-width | 4.2.3 | MIT | sindresorhus/string-width |
| strip-ansi | 6.0.1 | MIT | chalk/strip-ansi |
| stylis | 4.4.0 | MIT | https://github.com/thysultan/stylis.js |
| superjson | 2.2.6 | MIT | https://github.com/blitz-js/superjson |
| tailwindcss | 4.3.3 | MIT | https://github.com/tailwindlabs/tailwindcss |
| tapable | 2.3.3 | MIT | http://github.com/webpack/tapable |
| thinking-orbs | 0.2.0 | MIT | https://github.com/Jakubantalik/thinking-orbs |
| three | 0.184.0 | MIT | https://github.com/mrdoob/three.js |
| three | 0.128.0 | MIT | https://github.com/mrdoob/three.js |
| tiny-lru | 11.4.7 | BSD-3-Clause | git://github.com/avoidwork/tiny-lru |
| tinyexec | 1.3.0 | MIT | https://github.com/tinylibs/tinyexec |
| tinyglobby | 0.2.17 | MIT | https://github.com/SuperchupuDev/tinyglobby |
| toidentifier | 1.0.1 | MIT | component/toidentifier |
| topojson-client | 3.1.0 | ISC | https://github.com/topojson/topojson-client |
| ts-algebra | 2.0.0 | MIT | https://github.com/ThomasAribart/ts-algebra |
| ts-dedent | 2.3.0 | MIT | https://github.com/tamino-martinius/node-ts-dedent |
| tslib | 2.8.1 | 0BSD | https://github.com/Microsoft/tslib |
| tslib | 2.3.0 | 0BSD | https://github.com/Microsoft/tslib |
| tsx | 4.23.12 | MIT | privatenumber/tsx |
| type-is | 2.1.0 | MIT | jshttp/type-is |
| typebox | 1.3.27 | MIT | https://github.com/sinclairzx81/typebox |
| typedarray | 0.0.6 | MIT | git://github.com/substack/typedarray |
| typescript | 5.9.3 | Apache-2.0 | https://github.com/microsoft/TypeScript |
| underscore | 1.13.8 | MIT | git://github.com/jashkenas/underscore |
| undici | 8.10.1 | MIT | https://github.com/nodejs/undici |
| undici-types | 6.21.0 | MIT | https://github.com/nodejs/undici |
| unist-util-is | 6.0.1 | MIT | syntax-tree/unist-util-is |
| unist-util-remove-position | 5.0.0 | MIT | syntax-tree/unist-util-remove-position |
| unist-util-stringify-position | 4.0.0 | MIT | syntax-tree/unist-util-stringify-position |
| unist-util-visit | 5.1.0 | MIT | syntax-tree/unist-util-visit |
| unist-util-visit-parents | 6.0.2 | MIT | syntax-tree/unist-util-visit-parents |
| unpipe | 1.0.0 | MIT | stream-utils/unpipe |
| utif | 3.1.0 | MIT | github:photopea/UTIF.js |
| util-deprecate | 1.0.2 | MIT | git://github.com/TooTallNate/util-deprecate |
| uuid | 14.0.2 | MIT | https://github.com/uuidjs/uuid |
| vary | 1.1.2 | MIT | jshttp/vary |
| vite | 6.4.3 | MIT | https://github.com/vitejs/vite |
| vscode-jsonrpc | 9.0.3 | MIT | https://github.com/Microsoft/vscode-languageserver-node |
| vue | 3.5.41 | MIT | https://github.com/vuejs/core |
| web-streams-polyfill | 3.3.3 | MIT | https://github.com/MattiasBuelens/web-streams-polyfill |
| which | 2.0.2 | ISC | git://github.com/isaacs/node-which |
| which-module | 2.0.1 | ISC | https://github.com/nexdrew/which-module |
| wkt-parser | 1.5.6 | MIT | https://github.com/proj4js/wkt-parser |
| wmf | 1.0.2 | Apache-2.0 | git://github.com/SheetJS/js-wmf |
| word | 0.3.0 | Apache-2.0 | git://github.com/SheetJS/js-word |
| wrap-ansi | 6.2.0 | MIT | chalk/wrap-ansi |
| wrappy | 1.0.2 | ISC | https://github.com/npm/wrappy |
| ws | 8.21.3 | MIT | https://github.com/websockets/ws |
| wsl-utils | 1.0.1 | MIT | sindresorhus/wsl-utils |
| xlsx | 0.18.5 | Apache-2.0 | git://github.com/SheetJS/sheetjs |
| xmlbuilder | 10.1.1 | MIT | git://github.com/oozcitak/xmlbuilder-js |
| xz-decompress | 0.2.3 | MIT | https://github.com/httptoolkit/xz-decompress |
| y18n | 4.0.3 | ISC | git@github.com:yargs/y18n |
| yargs | 15.4.1 | MIT | https://github.com/yargs/yargs |
| yargs-parser | 18.1.3 | ISC | https://github.com/yargs/yargs-parser |
| zod | 4.5.2 | MIT | https://github.com/colinhacks/zod |
| zod-to-json-schema | 3.25.2 | ISC | https://github.com/StefanTerdell/zod-to-json-schema |
| zrender | 6.1.0 | BSD-3-Clause | https://github.com/ecomfe/zrender |
| zwitch | 2.0.4 | MIT | wooorm/zwitch |

## 四、Rust 依赖清单

> ⚠️ Cargo.lock 不记录许可字段，下表仅列名字与版本；Tauri 生态绝大多数为 MIT / Apache-2.0，
> 发布前建议用 `cargo license` 或 crates.io API 补全后再对外发布。

| crate | 版本 | 来源 |
| --- | --- | --- |
| adler2 | 2.0.1 | frontend(rust) |
| adler2 | 2.0.1 | setup(rust) |
| aho-corasick | 1.1.5 | frontend(rust) |
| aho-corasick | 1.1.5 | setup(rust) |
| alloc-no-stdlib | 2.0.4 | frontend(rust) |
| alloc-no-stdlib | 2.0.4 | setup(rust) |
| alloc-stdlib | 0.2.4 | frontend(rust) |
| alloc-stdlib | 0.2.4 | setup(rust) |
| android_system_properties | 0.1.6 | frontend(rust) |
| android_system_properties | 0.1.6 | setup(rust) |
| anyhow | 1.0.104 | frontend(rust) |
| anyhow | 1.0.104 | setup(rust) |
| async-broadcast | 0.7.2 | frontend(rust) |
| async-channel | 2.5.0 | frontend(rust) |
| async-executor | 1.14.0 | frontend(rust) |
| async-io | 2.6.0 | frontend(rust) |
| async-lock | 3.4.2 | frontend(rust) |
| async-process | 2.5.0 | frontend(rust) |
| async-recursion | 1.1.1 | frontend(rust) |
| async-signal | 0.2.14 | frontend(rust) |
| async-task | 4.7.1 | frontend(rust) |
| async-trait | 0.1.92 | frontend(rust) |
| atk | 0.18.2 | frontend(rust) |
| atk | 0.18.2 | setup(rust) |
| atk-sys | 0.18.2 | frontend(rust) |
| atk-sys | 0.18.2 | setup(rust) |
| atomic-waker | 1.1.2 | frontend(rust) |
| atomic-waker | 1.1.2 | setup(rust) |
| autocfg | 1.5.1 | frontend(rust) |
| autocfg | 1.5.1 | setup(rust) |
| base64 | 0.21.7 | frontend(rust) |
| base64 | 0.22.1 | frontend(rust) |
| base64 | 0.23.1 | frontend(rust) |
| base64 | 0.21.7 | setup(rust) |
| base64 | 0.22.1 | setup(rust) |
| base64 | 0.23.1 | setup(rust) |
| bit-set | 0.8.0 | frontend(rust) |
| bit-set | 0.8.0 | setup(rust) |
| bit-vec | 0.8.0 | frontend(rust) |
| bit-vec | 0.8.0 | setup(rust) |
| bitflags | 1.3.2 | frontend(rust) |
| bitflags | 2.13.2 | frontend(rust) |
| bitflags | 1.3.2 | setup(rust) |
| bitflags | 2.13.2 | setup(rust) |
| block-buffer | 0.10.4 | frontend(rust) |
| block-buffer | 0.10.4 | setup(rust) |
| block2 | 0.6.2 | frontend(rust) |
| block2 | 0.6.2 | setup(rust) |
| blocking | 1.7.0 | frontend(rust) |
| brotli | 8.0.4 | frontend(rust) |
| brotli | 8.0.4 | setup(rust) |
| brotli-decompressor | 5.0.3 | frontend(rust) |
| brotli-decompressor | 5.0.3 | setup(rust) |
| bs58 | 0.5.1 | frontend(rust) |
| bs58 | 0.5.1 | setup(rust) |
| bumpalo | 3.20.3 | frontend(rust) |
| bumpalo | 3.20.3 | setup(rust) |
| bytemuck | 1.25.2 | frontend(rust) |
| bytemuck | 1.25.2 | setup(rust) |
| byteorder | 1.5.0 | frontend(rust) |
| byteorder | 1.5.0 | setup(rust) |
| bytes | 1.12.1 | frontend(rust) |
| bytes | 1.12.1 | setup(rust) |
| cairo-rs | 0.18.5 | frontend(rust) |
| cairo-rs | 0.18.5 | setup(rust) |
| cairo-sys-rs | 0.18.2 | frontend(rust) |
| cairo-sys-rs | 0.18.2 | setup(rust) |
| camino | 1.2.5 | frontend(rust) |
| camino | 1.2.5 | setup(rust) |
| cargo_metadata | 0.19.2 | frontend(rust) |
| cargo_metadata | 0.19.2 | setup(rust) |
| cargo_toml | 0.22.3 | frontend(rust) |
| cargo_toml | 0.22.3 | setup(rust) |
| cargo-platform | 0.1.9 | frontend(rust) |
| cargo-platform | 0.1.9 | setup(rust) |
| cc | 1.4.6 | frontend(rust) |
| cc | 1.4.6 | setup(rust) |
| cesu8 | 1.1.0 | frontend(rust) |
| cesu8 | 1.1.0 | setup(rust) |
| cfb | 0.7.3 | frontend(rust) |
| cfb | 0.7.3 | setup(rust) |
| cfg-expr | 0.15.8 | frontend(rust) |
| cfg-expr | 0.15.8 | setup(rust) |
| cfg-if | 1.0.4 | frontend(rust) |
| cfg-if | 1.0.4 | setup(rust) |
| chrono | 0.4.45 | frontend(rust) |
| chrono | 0.4.45 | setup(rust) |
| combine | 4.6.8 | frontend(rust) |
| combine | 4.6.8 | setup(rust) |
| concurrent-queue | 2.5.0 | frontend(rust) |
| cookie | 0.18.2 | frontend(rust) |
| cookie | 0.18.2 | setup(rust) |
| core-foundation | 0.10.1 | frontend(rust) |
| core-foundation | 0.10.1 | setup(rust) |
| core-foundation-sys | 0.8.7 | frontend(rust) |
| core-foundation-sys | 0.8.7 | setup(rust) |
| core-graphics | 0.25.0 | frontend(rust) |
| core-graphics | 0.25.0 | setup(rust) |
| core-graphics-types | 0.2.0 | frontend(rust) |
| core-graphics-types | 0.2.0 | setup(rust) |
| cpufeatures | 0.2.17 | frontend(rust) |
| cpufeatures | 0.2.17 | setup(rust) |
| crc32fast | 1.5.2 | frontend(rust) |
| crc32fast | 1.5.2 | setup(rust) |
| crossbeam-channel | 0.5.17 | frontend(rust) |
| crossbeam-channel | 0.5.17 | setup(rust) |
| crossbeam-utils | 0.8.23 | frontend(rust) |
| crossbeam-utils | 0.8.23 | setup(rust) |
| crypto-common | 0.1.7 | frontend(rust) |
| crypto-common | 0.1.7 | setup(rust) |
| cssparser | 0.36.0 | frontend(rust) |
| cssparser | 0.36.0 | setup(rust) |
| cssparser-macros | 0.6.1 | frontend(rust) |
| cssparser-macros | 0.6.1 | setup(rust) |
| ctor | 0.8.0 | frontend(rust) |
| ctor | 0.8.0 | setup(rust) |
| ctor-proc-macro | 0.0.7 | frontend(rust) |
| ctor-proc-macro | 0.0.7 | setup(rust) |
| darling | 0.24.1 | frontend(rust) |
| darling | 0.24.1 | setup(rust) |
| darling_core | 0.24.1 | frontend(rust) |
| darling_core | 0.24.1 | setup(rust) |
| darling_macro | 0.24.1 | frontend(rust) |
| darling_macro | 0.24.1 | setup(rust) |
| dbus | 0.9.12 | frontend(rust) |
| dbus | 0.9.12 | setup(rust) |
| defmt | 1.1.1 | frontend(rust) |
| defmt | 1.1.1 | setup(rust) |
| defmt-macros | 1.1.1 | frontend(rust) |
| defmt-macros | 1.1.1 | setup(rust) |
| defmt-parser | 1.0.0 | frontend(rust) |
| defmt-parser | 1.0.0 | setup(rust) |
| deranged | 0.5.8 | frontend(rust) |
| deranged | 0.5.8 | setup(rust) |
| derive_more | 2.1.1 | frontend(rust) |
| derive_more | 2.1.1 | setup(rust) |
| derive_more-impl | 2.1.1 | frontend(rust) |
| derive_more-impl | 2.1.1 | setup(rust) |
| digest | 0.10.7 | frontend(rust) |
| digest | 0.10.7 | setup(rust) |
| dirs | 6.0.0 | frontend(rust) |
| dirs | 6.0.0 | setup(rust) |
| dirs-sys | 0.5.0 | frontend(rust) |
| dirs-sys | 0.5.0 | setup(rust) |
| dispatch2 | 0.3.1 | frontend(rust) |
| dispatch2 | 0.3.1 | setup(rust) |
| displaydoc | 0.2.7 | frontend(rust) |
| displaydoc | 0.2.7 | setup(rust) |
| dlopen2 | 0.8.2 | frontend(rust) |
| dlopen2 | 0.8.2 | setup(rust) |
| dlopen2_derive | 0.4.3 | frontend(rust) |
| dlopen2_derive | 0.4.3 | setup(rust) |
| dom_query | 0.27.0 | frontend(rust) |
| dom_query | 0.27.0 | setup(rust) |
| dpi | 0.1.2 | frontend(rust) |
| dpi | 0.1.2 | setup(rust) |
| dtoa | 1.0.11 | frontend(rust) |
| dtoa | 1.0.11 | setup(rust) |
| dtoa-short | 0.3.5 | frontend(rust) |
| dtoa-short | 0.3.5 | setup(rust) |
| dtor | 0.3.0 | frontend(rust) |
| dtor | 0.3.0 | setup(rust) |
| dtor-proc-macro | 0.0.6 | frontend(rust) |
| dtor-proc-macro | 0.0.6 | setup(rust) |
| dunce | 1.0.5 | frontend(rust) |
| dunce | 1.0.5 | setup(rust) |
| dyn-clone | 1.0.20 | frontend(rust) |
| dyn-clone | 1.0.20 | setup(rust) |
| embed_plist | 1.2.2 | frontend(rust) |
| embed_plist | 1.2.2 | setup(rust) |
| embed-resource | 3.0.11 | frontend(rust) |
| embed-resource | 3.0.11 | setup(rust) |
| endi | 1.1.1 | frontend(rust) |
| enumflags2 | 0.7.12 | frontend(rust) |
| enumflags2_derive | 0.7.12 | frontend(rust) |
| equivalent | 1.0.2 | frontend(rust) |
| equivalent | 1.0.2 | setup(rust) |
| erased-serde | 0.4.10 | frontend(rust) |
| erased-serde | 0.4.10 | setup(rust) |
| errno | 0.3.14 | frontend(rust) |
| event-listener | 5.4.2 | frontend(rust) |
| event-listener-strategy | 0.5.4 | frontend(rust) |
| fastrand | 2.5.0 | frontend(rust) |
| fastrand | 2.5.0 | setup(rust) |
| fdeflate | 0.3.7 | frontend(rust) |
| fdeflate | 0.3.7 | setup(rust) |
| field-offset | 0.3.6 | frontend(rust) |
| field-offset | 0.3.6 | setup(rust) |
| find-msvc-tools | 0.1.12 | frontend(rust) |
| find-msvc-tools | 0.1.12 | setup(rust) |
| flate2 | 1.1.10 | frontend(rust) |
| flate2 | 1.1.10 | setup(rust) |
| fnv | 1.0.7 | frontend(rust) |
| fnv | 1.0.7 | setup(rust) |
| foldhash | 0.2.0 | frontend(rust) |
| foldhash | 0.2.0 | setup(rust) |
| foreign-types | 0.5.0 | frontend(rust) |
| foreign-types | 0.5.0 | setup(rust) |
| foreign-types-macros | 0.2.4 | frontend(rust) |
| foreign-types-macros | 0.2.4 | setup(rust) |
| foreign-types-shared | 0.3.1 | frontend(rust) |
| foreign-types-shared | 0.3.1 | setup(rust) |
| form_urlencoded | 1.2.2 | frontend(rust) |
| form_urlencoded | 1.2.2 | setup(rust) |
| futures-channel | 0.3.34 | frontend(rust) |
| futures-channel | 0.3.34 | setup(rust) |
| futures-core | 0.3.34 | frontend(rust) |
| futures-core | 0.3.34 | setup(rust) |
| futures-executor | 0.3.34 | frontend(rust) |
| futures-executor | 0.3.34 | setup(rust) |
| futures-io | 0.3.34 | frontend(rust) |
| futures-io | 0.3.34 | setup(rust) |
| futures-lite | 2.6.1 | frontend(rust) |
| futures-macro | 0.3.34 | frontend(rust) |
| futures-macro | 0.3.34 | setup(rust) |
| futures-sink | 0.3.34 | frontend(rust) |
| futures-sink | 0.3.34 | setup(rust) |
| futures-task | 0.3.34 | frontend(rust) |
| futures-task | 0.3.34 | setup(rust) |
| futures-util | 0.3.34 | frontend(rust) |
| futures-util | 0.3.34 | setup(rust) |
| gdk | 0.18.2 | frontend(rust) |
| gdk | 0.18.2 | setup(rust) |
| gdk-pixbuf | 0.18.5 | frontend(rust) |
| gdk-pixbuf | 0.18.5 | setup(rust) |
| gdk-pixbuf-sys | 0.18.0 | frontend(rust) |
| gdk-pixbuf-sys | 0.18.0 | setup(rust) |
| gdk-sys | 0.18.2 | frontend(rust) |
| gdk-sys | 0.18.2 | setup(rust) |
| gdkwayland-sys | 0.18.2 | frontend(rust) |
| gdkwayland-sys | 0.18.2 | setup(rust) |
| gdkx11 | 0.18.2 | frontend(rust) |
| gdkx11 | 0.18.2 | setup(rust) |
| gdkx11-sys | 0.18.2 | frontend(rust) |
| gdkx11-sys | 0.18.2 | setup(rust) |
| generic-array | 0.14.7 | frontend(rust) |
| generic-array | 0.14.7 | setup(rust) |
| getrandom | 0.2.17 | frontend(rust) |
| getrandom | 0.3.4 | frontend(rust) |
| getrandom | 0.4.3 | frontend(rust) |
| getrandom | 0.2.17 | setup(rust) |
| getrandom | 0.3.4 | setup(rust) |
| getrandom | 0.4.3 | setup(rust) |
| gio | 0.18.4 | frontend(rust) |
| gio | 0.18.4 | setup(rust) |
| gio-sys | 0.18.1 | frontend(rust) |
| gio-sys | 0.18.1 | setup(rust) |
| glib | 0.18.5 | frontend(rust) |
| glib | 0.18.5 | setup(rust) |
| glib-macros | 0.18.5 | frontend(rust) |
| glib-macros | 0.18.5 | setup(rust) |
| glib-sys | 0.18.1 | frontend(rust) |
| glib-sys | 0.18.1 | setup(rust) |
| glob | 0.3.4 | frontend(rust) |
| glob | 0.3.4 | setup(rust) |
| gobject-sys | 0.18.0 | frontend(rust) |
| gobject-sys | 0.18.0 | setup(rust) |
| gtk | 0.18.2 | frontend(rust) |
| gtk | 0.18.2 | setup(rust) |
| gtk-sys | 0.18.2 | frontend(rust) |
| gtk-sys | 0.18.2 | setup(rust) |
| gtk3-macros | 0.18.2 | frontend(rust) |
| gtk3-macros | 0.18.2 | setup(rust) |
| hashbrown | 0.12.3 | frontend(rust) |
| hashbrown | 0.17.1 | frontend(rust) |
| hashbrown | 0.12.3 | setup(rust) |
| hashbrown | 0.17.1 | setup(rust) |
| heck | 0.4.1 | frontend(rust) |
| heck | 0.5.0 | frontend(rust) |
| heck | 0.4.1 | setup(rust) |
| heck | 0.5.0 | setup(rust) |
| hermit-abi | 0.5.3 | frontend(rust) |
| hex | 0.4.3 | frontend(rust) |
| hex | 0.4.3 | setup(rust) |
| html5ever | 0.38.0 | frontend(rust) |
| html5ever | 0.38.0 | setup(rust) |
| http | 1.5.0 | frontend(rust) |
| http | 1.5.0 | setup(rust) |
| http-body | 1.1.0 | frontend(rust) |
| http-body | 1.1.0 | setup(rust) |
| http-body-util | 0.1.5 | frontend(rust) |
| http-body-util | 0.1.5 | setup(rust) |
| httparse | 1.10.1 | frontend(rust) |
| httparse | 1.10.1 | setup(rust) |
| hyper | 1.11.1 | frontend(rust) |
| hyper | 1.11.1 | setup(rust) |
| hyper-util | 0.1.20 | frontend(rust) |
| hyper-util | 0.1.20 | setup(rust) |
| iana-time-zone | 0.1.65 | frontend(rust) |
| iana-time-zone | 0.1.65 | setup(rust) |
| iana-time-zone-haiku | 0.1.2 | frontend(rust) |
| iana-time-zone-haiku | 0.1.2 | setup(rust) |
| ico | 0.5.0 | frontend(rust) |
| ico | 0.5.0 | setup(rust) |
| icu_collections | 2.3.0 | frontend(rust) |
| icu_collections | 2.3.0 | setup(rust) |
| icu_locale_core | 2.3.0 | frontend(rust) |
| icu_locale_core | 2.3.0 | setup(rust) |
| icu_normalizer | 2.3.0 | frontend(rust) |
| icu_normalizer | 2.3.0 | setup(rust) |
| icu_normalizer_data | 2.3.0 | frontend(rust) |
| icu_normalizer_data | 2.3.0 | setup(rust) |
| icu_properties | 2.3.0 | frontend(rust) |
| icu_properties | 2.3.0 | setup(rust) |
| icu_properties_data | 2.3.0 | frontend(rust) |
| icu_properties_data | 2.3.0 | setup(rust) |
| icu_provider | 2.3.1 | frontend(rust) |
| icu_provider | 2.3.1 | setup(rust) |
| ident_case | 1.0.1 | frontend(rust) |
| ident_case | 1.0.1 | setup(rust) |
| idna | 1.1.0 | frontend(rust) |
| idna | 1.1.0 | setup(rust) |
| idna_adapter | 1.2.2 | frontend(rust) |
| idna_adapter | 1.2.2 | setup(rust) |
| indexmap | 1.9.3 | frontend(rust) |
| indexmap | 2.14.2 | frontend(rust) |
| indexmap | 1.9.3 | setup(rust) |
| indexmap | 2.14.2 | setup(rust) |
| infer | 0.19.0 | frontend(rust) |
| infer | 0.19.0 | setup(rust) |
| ipnet | 2.12.2 | frontend(rust) |
| ipnet | 2.12.2 | setup(rust) |
| itoa | 1.0.18 | frontend(rust) |
| itoa | 1.0.18 | setup(rust) |
| javascriptcore-rs | 1.1.2 | frontend(rust) |
| javascriptcore-rs | 1.1.2 | setup(rust) |
| javascriptcore-rs-sys | 1.1.1 | frontend(rust) |
| javascriptcore-rs-sys | 1.1.1 | setup(rust) |
| jiff | 0.2.37 | frontend(rust) |
| jiff | 0.2.37 | setup(rust) |
| jiff-core | 0.1.1 | frontend(rust) |
| jiff-core | 0.1.1 | setup(rust) |
| jiff-static | 0.2.37 | frontend(rust) |
| jiff-static | 0.2.37 | setup(rust) |
| jiff-tzdb | 0.1.8 | frontend(rust) |
| jiff-tzdb | 0.1.8 | setup(rust) |
| jiff-tzdb-platform | 0.1.3 | frontend(rust) |
| jiff-tzdb-platform | 0.1.3 | setup(rust) |
| jni | 0.21.1 | frontend(rust) |
| jni | 0.21.1 | setup(rust) |
| jni-sys | 0.3.1 | frontend(rust) |
| jni-sys | 0.4.1 | frontend(rust) |
| jni-sys | 0.3.1 | setup(rust) |
| jni-sys | 0.4.1 | setup(rust) |
| jni-sys-macros | 0.4.1 | frontend(rust) |
| jni-sys-macros | 0.4.1 | setup(rust) |
| js-sys | 0.3.105 | frontend(rust) |
| js-sys | 0.3.105 | setup(rust) |
| json-patch | 3.0.1 | frontend(rust) |
| json-patch | 3.0.1 | setup(rust) |
| jsonptr | 0.6.3 | frontend(rust) |
| jsonptr | 0.6.3 | setup(rust) |
| keyboard-types | 0.7.0 | frontend(rust) |
| keyboard-types | 0.7.0 | setup(rust) |
| libappindicator | 0.9.0 | frontend(rust) |
| libappindicator | 0.9.0 | setup(rust) |
| libappindicator-sys | 0.9.0 | frontend(rust) |
| libappindicator-sys | 0.9.0 | setup(rust) |
| libc | 0.2.189 | frontend(rust) |
| libc | 0.2.189 | setup(rust) |
| libdbus-sys | 0.2.7 | frontend(rust) |
| libdbus-sys | 0.2.7 | setup(rust) |
| libloading | 0.7.4 | frontend(rust) |
| libloading | 0.7.4 | setup(rust) |
| libredox | 0.1.24 | frontend(rust) |
| libredox | 0.1.24 | setup(rust) |
| linux-raw-sys | 0.12.1 | frontend(rust) |
| litemap | 0.8.3 | frontend(rust) |
| litemap | 0.8.3 | setup(rust) |
| lock_api | 0.4.14 | frontend(rust) |
| lock_api | 0.4.14 | setup(rust) |
| log | 0.4.34 | frontend(rust) |
| log | 0.4.34 | setup(rust) |
| mac-notification-sys | 0.6.15 | frontend(rust) |
| markup5ever | 0.38.0 | frontend(rust) |
| markup5ever | 0.38.0 | setup(rust) |
| memchr | 2.8.3 | frontend(rust) |
| memchr | 2.8.3 | setup(rust) |
| memoffset | 0.9.1 | frontend(rust) |
| memoffset | 0.9.1 | setup(rust) |
| mime | 0.3.17 | frontend(rust) |
| mime | 0.3.17 | setup(rust) |
| miniz_oxide | 0.8.9 | frontend(rust) |
| miniz_oxide | 0.9.1 | frontend(rust) |
| miniz_oxide | 0.8.9 | setup(rust) |
| miniz_oxide | 0.9.1 | setup(rust) |
| mio | 1.2.3 | frontend(rust) |
| mio | 1.2.3 | setup(rust) |
| muda | 0.19.3 | frontend(rust) |
| muda | 0.19.3 | setup(rust) |
| ndk | 0.9.0 | frontend(rust) |
| ndk | 0.9.0 | setup(rust) |
| ndk-sys | 0.6.0+11769913 | frontend(rust) |
| ndk-sys | 0.6.0+11769913 | setup(rust) |
| new_debug_unreachable | 1.0.6 | frontend(rust) |
| new_debug_unreachable | 1.0.6 | setup(rust) |
| nis-setup | 1.1.0 | setup(rust) |
| nis-ui | 1.1.0 | frontend(rust) |
| notify-rust | 4.18.0 | frontend(rust) |
| num_enum | 0.7.6 | frontend(rust) |
| num_enum | 0.7.6 | setup(rust) |
| num_enum_derive | 0.7.6 | frontend(rust) |
| num_enum_derive | 0.7.6 | setup(rust) |
| num-conv | 0.2.2 | frontend(rust) |
| num-conv | 0.2.2 | setup(rust) |
| num-traits | 0.2.19 | frontend(rust) |
| num-traits | 0.2.19 | setup(rust) |
| objc2 | 0.6.4 | frontend(rust) |
| objc2 | 0.6.4 | setup(rust) |
| objc2-app-kit | 0.3.2 | frontend(rust) |
| objc2-app-kit | 0.3.2 | setup(rust) |
| objc2-cloud-kit | 0.3.2 | frontend(rust) |
| objc2-cloud-kit | 0.3.2 | setup(rust) |
| objc2-core-data | 0.3.2 | frontend(rust) |
| objc2-core-data | 0.3.2 | setup(rust) |
| objc2-core-foundation | 0.3.2 | frontend(rust) |
| objc2-core-foundation | 0.3.2 | setup(rust) |
| objc2-core-graphics | 0.3.2 | frontend(rust) |
| objc2-core-graphics | 0.3.2 | setup(rust) |
| objc2-core-image | 0.3.2 | frontend(rust) |
| objc2-core-image | 0.3.2 | setup(rust) |
| objc2-core-location | 0.3.2 | frontend(rust) |
| objc2-core-location | 0.3.2 | setup(rust) |
| objc2-core-text | 0.3.2 | frontend(rust) |
| objc2-core-text | 0.3.2 | setup(rust) |
| objc2-encode | 4.1.0 | frontend(rust) |
| objc2-encode | 4.1.0 | setup(rust) |
| objc2-exception-helper | 0.1.1 | frontend(rust) |
| objc2-exception-helper | 0.1.1 | setup(rust) |
| objc2-foundation | 0.3.2 | frontend(rust) |
| objc2-foundation | 0.3.2 | setup(rust) |
| objc2-io-surface | 0.3.2 | frontend(rust) |
| objc2-io-surface | 0.3.2 | setup(rust) |
| objc2-quartz-core | 0.3.2 | frontend(rust) |
| objc2-quartz-core | 0.3.2 | setup(rust) |
| objc2-ui-kit | 0.3.2 | frontend(rust) |
| objc2-ui-kit | 0.3.2 | setup(rust) |
| objc2-user-notifications | 0.3.2 | frontend(rust) |
| objc2-user-notifications | 0.3.2 | setup(rust) |
| objc2-web-kit | 0.3.2 | frontend(rust) |
| objc2-web-kit | 0.3.2 | setup(rust) |
| once_cell | 1.21.4 | frontend(rust) |
| once_cell | 1.21.4 | setup(rust) |
| option-ext | 0.2.0 | frontend(rust) |
| option-ext | 0.2.0 | setup(rust) |
| ordered-stream | 0.2.0 | frontend(rust) |
| pango | 0.18.3 | frontend(rust) |
| pango | 0.18.3 | setup(rust) |
| pango-sys | 0.18.0 | frontend(rust) |
| pango-sys | 0.18.0 | setup(rust) |
| parking | 2.2.1 | frontend(rust) |
| parking_lot | 0.12.5 | frontend(rust) |
| parking_lot | 0.12.5 | setup(rust) |
| parking_lot_core | 0.9.12 | frontend(rust) |
| parking_lot_core | 0.9.12 | setup(rust) |
| percent-encoding | 2.3.2 | frontend(rust) |
| percent-encoding | 2.3.2 | setup(rust) |
| phf | 0.13.1 | frontend(rust) |
| phf | 0.13.1 | setup(rust) |
| phf_codegen | 0.13.1 | frontend(rust) |
| phf_codegen | 0.13.1 | setup(rust) |
| phf_generator | 0.13.1 | frontend(rust) |
| phf_generator | 0.13.1 | setup(rust) |
| phf_macros | 0.13.1 | frontend(rust) |
| phf_macros | 0.13.1 | setup(rust) |
| phf_shared | 0.13.1 | frontend(rust) |
| phf_shared | 0.13.1 | setup(rust) |
| pin-project-lite | 0.2.17 | frontend(rust) |
| pin-project-lite | 0.2.17 | setup(rust) |
| piper | 0.2.5 | frontend(rust) |
| pkg-config | 0.3.34 | frontend(rust) |
| pkg-config | 0.3.34 | setup(rust) |
| plist | 1.10.1 | frontend(rust) |
| plist | 1.10.1 | setup(rust) |
| png | 0.17.16 | frontend(rust) |
| png | 0.18.1 | frontend(rust) |
| png | 0.17.16 | setup(rust) |
| png | 0.18.1 | setup(rust) |
| polling | 3.11.0 | frontend(rust) |
| portable-atomic | 1.15.0 | frontend(rust) |
| portable-atomic | 1.15.0 | setup(rust) |
| portable-atomic-util | 0.2.8 | frontend(rust) |
| portable-atomic-util | 0.2.8 | setup(rust) |
| potential_utf | 0.1.6 | frontend(rust) |
| potential_utf | 0.1.6 | setup(rust) |
| powerfmt | 0.2.0 | frontend(rust) |
| powerfmt | 0.2.0 | setup(rust) |
| ppv-lite86 | 0.2.21 | frontend(rust) |
| precomputed-hash | 0.1.1 | frontend(rust) |
| precomputed-hash | 0.1.1 | setup(rust) |
| proc-macro-crate | 1.3.1 | frontend(rust) |
| proc-macro-crate | 2.0.2 | frontend(rust) |
| proc-macro-crate | 3.5.0 | frontend(rust) |
| proc-macro-crate | 1.3.1 | setup(rust) |
| proc-macro-crate | 2.0.2 | setup(rust) |
| proc-macro-crate | 3.5.0 | setup(rust) |
| proc-macro-error | 1.0.4 | frontend(rust) |
| proc-macro-error | 1.0.4 | setup(rust) |
| proc-macro-error-attr | 1.0.4 | frontend(rust) |
| proc-macro-error-attr | 1.0.4 | setup(rust) |
| proc-macro2 | 1.0.107 | frontend(rust) |
| proc-macro2 | 1.0.107 | setup(rust) |
| quick-xml | 0.42.0 | frontend(rust) |
| quick-xml | 0.42.0 | setup(rust) |
| quote | 1.0.47 | frontend(rust) |
| quote | 1.0.47 | setup(rust) |
| r-efi | 5.3.0 | frontend(rust) |
| r-efi | 6.0.0 | frontend(rust) |
| r-efi | 5.3.0 | setup(rust) |
| r-efi | 6.0.0 | setup(rust) |
| rand | 0.9.5 | frontend(rust) |
| rand_chacha | 0.9.0 | frontend(rust) |
| rand_core | 0.9.5 | frontend(rust) |
| raw-window-handle | 0.6.2 | frontend(rust) |
| raw-window-handle | 0.6.2 | setup(rust) |
| redox_syscall | 0.5.18 | frontend(rust) |
| redox_syscall | 0.5.18 | setup(rust) |
| redox_users | 0.5.2 | frontend(rust) |
| redox_users | 0.5.2 | setup(rust) |
| ref-cast | 1.0.27 | frontend(rust) |
| ref-cast | 1.0.27 | setup(rust) |
| ref-cast-impl | 1.0.27 | frontend(rust) |
| ref-cast-impl | 1.0.27 | setup(rust) |
| regex | 1.13.1 | frontend(rust) |
| regex | 1.13.1 | setup(rust) |
| regex-automata | 0.4.18 | frontend(rust) |
| regex-automata | 0.4.18 | setup(rust) |
| regex-syntax | 0.8.11 | frontend(rust) |
| regex-syntax | 0.8.11 | setup(rust) |
| reqwest | 0.13.5 | frontend(rust) |
| reqwest | 0.13.5 | setup(rust) |
| rfd | 0.16.0 | frontend(rust) |
| rfd | 0.16.0 | setup(rust) |
| rustc_version | 0.4.1 | frontend(rust) |
| rustc_version | 0.4.1 | setup(rust) |
| rustc-hash | 2.1.3 | frontend(rust) |
| rustc-hash | 2.1.3 | setup(rust) |
| rustix | 1.1.4 | frontend(rust) |
| rustversion | 1.0.23 | frontend(rust) |
| rustversion | 1.0.23 | setup(rust) |
| same-file | 1.0.6 | frontend(rust) |
| same-file | 1.0.6 | setup(rust) |
| schemars | 0.8.22 | frontend(rust) |
| schemars | 0.9.0 | frontend(rust) |
| schemars | 1.2.2 | frontend(rust) |
| schemars | 0.8.22 | setup(rust) |
| schemars | 0.9.0 | setup(rust) |
| schemars | 1.2.2 | setup(rust) |
| schemars_derive | 0.8.22 | frontend(rust) |
| schemars_derive | 0.8.22 | setup(rust) |
| scopeguard | 1.2.0 | frontend(rust) |
| scopeguard | 1.2.0 | setup(rust) |
| selectors | 0.36.1 | frontend(rust) |
| selectors | 0.36.1 | setup(rust) |
| semver | 1.0.28 | frontend(rust) |
| semver | 1.0.28 | setup(rust) |
| serde | 1.0.229 | frontend(rust) |
| serde | 1.0.229 | setup(rust) |
| serde_core | 1.0.229 | frontend(rust) |
| serde_core | 1.0.229 | setup(rust) |
| serde_derive | 1.0.229 | frontend(rust) |
| serde_derive | 1.0.229 | setup(rust) |
| serde_derive_internals | 0.29.1 | frontend(rust) |
| serde_derive_internals | 0.29.1 | setup(rust) |
| serde_json | 1.0.151 | frontend(rust) |
| serde_json | 1.0.151 | setup(rust) |
| serde_repr | 0.1.21 | frontend(rust) |
| serde_repr | 0.1.21 | setup(rust) |
| serde_spanned | 0.6.9 | frontend(rust) |
| serde_spanned | 1.1.1 | frontend(rust) |
| serde_spanned | 0.6.9 | setup(rust) |
| serde_spanned | 1.1.1 | setup(rust) |
| serde_with | 3.23.0 | frontend(rust) |
| serde_with | 3.23.0 | setup(rust) |
| serde_with_macros | 3.23.0 | frontend(rust) |
| serde_with_macros | 3.23.0 | setup(rust) |
| serde-untagged | 0.1.9 | frontend(rust) |
| serde-untagged | 0.1.9 | setup(rust) |
| serialize-to-javascript | 0.1.2 | frontend(rust) |
| serialize-to-javascript | 0.1.2 | setup(rust) |
| serialize-to-javascript-impl | 0.1.2 | frontend(rust) |
| serialize-to-javascript-impl | 0.1.2 | setup(rust) |
| servo_arc | 0.4.3 | frontend(rust) |
| servo_arc | 0.4.3 | setup(rust) |
| sha2 | 0.10.9 | frontend(rust) |
| sha2 | 0.10.9 | setup(rust) |
| shlex | 2.0.1 | frontend(rust) |
| shlex | 2.0.1 | setup(rust) |
| signal-hook-registry | 1.4.8 | frontend(rust) |
| simd-adler32 | 0.3.10 | frontend(rust) |
| simd-adler32 | 0.3.10 | setup(rust) |
| siphasher | 1.0.3 | frontend(rust) |
| siphasher | 1.0.3 | setup(rust) |
| slab | 0.4.12 | frontend(rust) |
| slab | 0.4.12 | setup(rust) |
| smallvec | 1.16.1 | frontend(rust) |
| smallvec | 1.16.1 | setup(rust) |
| socket2 | 0.6.5 | frontend(rust) |
| socket2 | 0.6.5 | setup(rust) |
| softbuffer | 0.4.8 | frontend(rust) |
| softbuffer | 0.4.8 | setup(rust) |
| soup3 | 0.5.0 | frontend(rust) |
| soup3 | 0.5.0 | setup(rust) |
| soup3-sys | 0.5.0 | frontend(rust) |
| soup3-sys | 0.5.0 | setup(rust) |
| stable_deref_trait | 1.2.1 | frontend(rust) |
| stable_deref_trait | 1.2.1 | setup(rust) |
| string_cache | 0.9.0 | frontend(rust) |
| string_cache | 0.9.0 | setup(rust) |
| string_cache_codegen | 0.6.1 | frontend(rust) |
| string_cache_codegen | 0.6.1 | setup(rust) |
| strsim | 0.11.1 | frontend(rust) |
| strsim | 0.11.1 | setup(rust) |
| swift-rs | 1.0.8 | frontend(rust) |
| swift-rs | 1.0.8 | setup(rust) |
| syn | 1.0.109 | frontend(rust) |
| syn | 2.0.119 | frontend(rust) |
| syn | 3.0.5 | frontend(rust) |
| syn | 1.0.109 | setup(rust) |
| syn | 2.0.119 | setup(rust) |
| syn | 3.0.5 | setup(rust) |
| sync_wrapper | 1.0.2 | frontend(rust) |
| sync_wrapper | 1.0.2 | setup(rust) |
| synstructure | 0.13.2 | frontend(rust) |
| synstructure | 0.13.2 | setup(rust) |
| system-deps | 6.2.2 | frontend(rust) |
| system-deps | 6.2.2 | setup(rust) |
| tao | 0.35.3 | frontend(rust) |
| tao | 0.35.3 | setup(rust) |
| tao-macros | 0.1.4 | frontend(rust) |
| tao-macros | 0.1.4 | setup(rust) |
| target-lexicon | 0.12.16 | frontend(rust) |
| target-lexicon | 0.12.16 | setup(rust) |
| tauri | 2.11.5 | frontend(rust) |
| tauri | 2.11.5 | setup(rust) |
| tauri-build | 2.6.3 | frontend(rust) |
| tauri-build | 2.6.3 | setup(rust) |
| tauri-codegen | 2.6.3 | frontend(rust) |
| tauri-codegen | 2.6.3 | setup(rust) |
| tauri-macros | 2.6.3 | frontend(rust) |
| tauri-macros | 2.6.3 | setup(rust) |
| tauri-plugin | 2.6.3 | frontend(rust) |
| tauri-plugin | 2.6.3 | setup(rust) |
| tauri-plugin-dialog | 2.7.3 | frontend(rust) |
| tauri-plugin-dialog | 2.7.3 | setup(rust) |
| tauri-plugin-fs | 2.5.2 | frontend(rust) |
| tauri-plugin-fs | 2.5.2 | setup(rust) |
| tauri-plugin-notification | 2.4.0 | frontend(rust) |
| tauri-plugin-store | 2.4.4 | frontend(rust) |
| tauri-runtime | 2.11.3 | frontend(rust) |
| tauri-runtime | 2.11.3 | setup(rust) |
| tauri-runtime-wry | 2.11.4 | frontend(rust) |
| tauri-runtime-wry | 2.11.4 | setup(rust) |
| tauri-utils | 2.9.3 | frontend(rust) |
| tauri-utils | 2.9.3 | setup(rust) |
| tauri-winres | 0.3.6 | frontend(rust) |
| tauri-winres | 0.3.6 | setup(rust) |
| tauri-winrt-notification | 0.7.3 | frontend(rust) |
| tempfile | 3.27.0 | frontend(rust) |
| tendril | 0.5.1 | frontend(rust) |
| tendril | 0.5.1 | setup(rust) |
| thiserror | 1.0.69 | frontend(rust) |
| thiserror | 2.0.20 | frontend(rust) |
| thiserror | 1.0.69 | setup(rust) |
| thiserror | 2.0.20 | setup(rust) |
| thiserror-impl | 1.0.69 | frontend(rust) |
| thiserror-impl | 2.0.20 | frontend(rust) |
| thiserror-impl | 1.0.69 | setup(rust) |
| thiserror-impl | 2.0.20 | setup(rust) |
| time | 0.3.55 | frontend(rust) |
| time | 0.3.55 | setup(rust) |
| time-core | 0.1.9 | frontend(rust) |
| time-core | 0.1.9 | setup(rust) |
| time-macros | 0.2.32 | frontend(rust) |
| time-macros | 0.2.32 | setup(rust) |
| tinystr | 0.8.4 | frontend(rust) |
| tinystr | 0.8.4 | setup(rust) |
| tinyvec | 1.13.3 | frontend(rust) |
| tinyvec | 1.13.3 | setup(rust) |
| tokio | 1.53.1 | frontend(rust) |
| tokio | 1.53.1 | setup(rust) |
| tokio-macros | 2.7.2 | frontend(rust) |
| tokio-util | 0.7.19 | frontend(rust) |
| tokio-util | 0.7.19 | setup(rust) |
| toml | 0.8.2 | frontend(rust) |
| toml | 0.9.12+spec-1.1.0 | frontend(rust) |
| toml | 1.1.6+spec-1.1.0 | frontend(rust) |
| toml | 0.8.2 | setup(rust) |
| toml | 0.9.12+spec-1.1.0 | setup(rust) |
| toml | 1.1.6+spec-1.1.0 | setup(rust) |
| toml_datetime | 0.6.3 | frontend(rust) |
| toml_datetime | 0.7.5+spec-1.1.0 | frontend(rust) |
| toml_datetime | 1.1.1+spec-1.1.0 | frontend(rust) |
| toml_datetime | 0.6.3 | setup(rust) |
| toml_datetime | 0.7.5+spec-1.1.0 | setup(rust) |
| toml_datetime | 1.1.1+spec-1.1.0 | setup(rust) |
| toml_edit | 0.19.15 | frontend(rust) |
| toml_edit | 0.20.2 | frontend(rust) |
| toml_edit | 0.25.15+spec-1.1.0 | frontend(rust) |
| toml_edit | 0.19.15 | setup(rust) |
| toml_edit | 0.20.2 | setup(rust) |
| toml_edit | 0.25.15+spec-1.1.0 | setup(rust) |
| toml_parser | 1.1.3+spec-1.1.0 | frontend(rust) |
| toml_parser | 1.1.3+spec-1.1.0 | setup(rust) |
| toml_writer | 1.1.2+spec-1.1.0 | frontend(rust) |
| toml_writer | 1.1.2+spec-1.1.0 | setup(rust) |
| tower | 0.5.3 | frontend(rust) |
| tower | 0.5.3 | setup(rust) |
| tower-http | 0.6.11 | frontend(rust) |
| tower-http | 0.6.11 | setup(rust) |
| tower-layer | 0.3.3 | frontend(rust) |
| tower-layer | 0.3.3 | setup(rust) |
| tower-service | 0.3.3 | frontend(rust) |
| tower-service | 0.3.3 | setup(rust) |
| tracing | 0.1.44 | frontend(rust) |
| tracing | 0.1.44 | setup(rust) |
| tracing-attributes | 0.1.31 | frontend(rust) |
| tracing-core | 0.1.36 | frontend(rust) |
| tracing-core | 0.1.36 | setup(rust) |
| tray-icon | 0.24.2 | frontend(rust) |
| tray-icon | 0.24.2 | setup(rust) |
| try-lock | 0.2.5 | frontend(rust) |
| try-lock | 0.2.5 | setup(rust) |
| typeid | 1.0.3 | frontend(rust) |
| typeid | 1.0.3 | setup(rust) |
| typenum | 1.20.1 | frontend(rust) |
| typenum | 1.20.1 | setup(rust) |
| uds_windows | 1.2.1 | frontend(rust) |
| unic-char-property | 0.9.0 | frontend(rust) |
| unic-char-property | 0.9.0 | setup(rust) |
| unic-char-range | 0.9.0 | frontend(rust) |
| unic-char-range | 0.9.0 | setup(rust) |
| unic-common | 0.9.0 | frontend(rust) |
| unic-common | 0.9.0 | setup(rust) |
| unic-ucd-ident | 0.9.0 | frontend(rust) |
| unic-ucd-ident | 0.9.0 | setup(rust) |
| unic-ucd-version | 0.9.0 | frontend(rust) |
| unic-ucd-version | 0.9.0 | setup(rust) |
| unicode-ident | 1.0.24 | frontend(rust) |
| unicode-ident | 1.0.24 | setup(rust) |
| unicode-segmentation | 1.13.3 | frontend(rust) |
| unicode-segmentation | 1.13.3 | setup(rust) |
| url | 2.5.8 | frontend(rust) |
| url | 2.5.8 | setup(rust) |
| urlpattern | 0.3.0 | frontend(rust) |
| urlpattern | 0.3.0 | setup(rust) |
| utf8_iter | 1.0.4 | frontend(rust) |
| utf8_iter | 1.0.4 | setup(rust) |
| uuid | 1.26.1 | frontend(rust) |
| uuid | 1.26.1 | setup(rust) |
| version_check | 0.9.5 | frontend(rust) |
| version_check | 0.9.5 | setup(rust) |
| version-compare | 0.2.1 | frontend(rust) |
| version-compare | 0.2.1 | setup(rust) |
| vswhom | 0.1.0 | frontend(rust) |
| vswhom | 0.1.0 | setup(rust) |
| vswhom-sys | 0.1.3 | frontend(rust) |
| vswhom-sys | 0.1.3 | setup(rust) |
| walkdir | 2.5.0 | frontend(rust) |
| walkdir | 2.5.0 | setup(rust) |
| want | 0.3.1 | frontend(rust) |
| want | 0.3.1 | setup(rust) |
| wasi | 0.11.1+wasi-snapshot-preview1 | frontend(rust) |
| wasi | 0.11.1+wasi-snapshot-preview1 | setup(rust) |
| wasip2 | 1.0.4+wasi-0.2.12 | frontend(rust) |
| wasip2 | 1.0.4+wasi-0.2.12 | setup(rust) |
| wasm-bindgen | 0.2.128 | frontend(rust) |
| wasm-bindgen | 0.2.128 | setup(rust) |
| wasm-bindgen-futures | 0.4.78 | frontend(rust) |
| wasm-bindgen-futures | 0.4.78 | setup(rust) |
| wasm-bindgen-macro | 0.2.128 | frontend(rust) |
| wasm-bindgen-macro | 0.2.128 | setup(rust) |
| wasm-bindgen-macro-support | 0.2.128 | frontend(rust) |
| wasm-bindgen-macro-support | 0.2.128 | setup(rust) |
| wasm-bindgen-shared | 0.2.128 | frontend(rust) |
| wasm-bindgen-shared | 0.2.128 | setup(rust) |
| wasm-streams | 0.5.0 | frontend(rust) |
| wasm-streams | 0.5.0 | setup(rust) |
| web_atoms | 0.2.6 | frontend(rust) |
| web_atoms | 0.2.6 | setup(rust) |
| web-sys | 0.3.105 | frontend(rust) |
| web-sys | 0.3.105 | setup(rust) |
| webkit2gtk | 2.0.2 | frontend(rust) |
| webkit2gtk | 2.0.2 | setup(rust) |
| webkit2gtk-sys | 2.0.2 | frontend(rust) |
| webkit2gtk-sys | 2.0.2 | setup(rust) |
| webview2-com | 0.38.2 | frontend(rust) |
| webview2-com | 0.38.2 | setup(rust) |
| webview2-com-macros | 0.8.1 | frontend(rust) |
| webview2-com-macros | 0.8.1 | setup(rust) |
| webview2-com-sys | 0.38.2 | frontend(rust) |
| webview2-com-sys | 0.38.2 | setup(rust) |
| winapi | 0.3.9 | frontend(rust) |
| winapi | 0.3.9 | setup(rust) |
| winapi-i686-pc-windows-gnu | 0.4.0 | frontend(rust) |
| winapi-i686-pc-windows-gnu | 0.4.0 | setup(rust) |
| winapi-util | 0.1.11 | frontend(rust) |
| winapi-util | 0.1.11 | setup(rust) |
| winapi-x86_64-pc-windows-gnu | 0.4.0 | frontend(rust) |
| winapi-x86_64-pc-windows-gnu | 0.4.0 | setup(rust) |
| window-vibrancy | 0.6.0 | frontend(rust) |
| window-vibrancy | 0.6.0 | setup(rust) |
| windows | 0.61.3 | frontend(rust) |
| windows | 0.61.3 | setup(rust) |
| windows_aarch64_gnullvm | 0.42.2 | frontend(rust) |
| windows_aarch64_gnullvm | 0.52.6 | frontend(rust) |
| windows_aarch64_gnullvm | 0.53.1 | frontend(rust) |
| windows_aarch64_gnullvm | 0.42.2 | setup(rust) |
| windows_aarch64_gnullvm | 0.52.6 | setup(rust) |
| windows_aarch64_gnullvm | 0.53.1 | setup(rust) |
| windows_aarch64_msvc | 0.42.2 | frontend(rust) |
| windows_aarch64_msvc | 0.52.6 | frontend(rust) |
| windows_aarch64_msvc | 0.53.1 | frontend(rust) |
| windows_aarch64_msvc | 0.42.2 | setup(rust) |
| windows_aarch64_msvc | 0.52.6 | setup(rust) |
| windows_aarch64_msvc | 0.53.1 | setup(rust) |
| windows_i686_gnu | 0.42.2 | frontend(rust) |
| windows_i686_gnu | 0.52.6 | frontend(rust) |
| windows_i686_gnu | 0.53.1 | frontend(rust) |
| windows_i686_gnu | 0.42.2 | setup(rust) |
| windows_i686_gnu | 0.52.6 | setup(rust) |
| windows_i686_gnu | 0.53.1 | setup(rust) |
| windows_i686_gnullvm | 0.52.6 | frontend(rust) |
| windows_i686_gnullvm | 0.53.1 | frontend(rust) |
| windows_i686_gnullvm | 0.52.6 | setup(rust) |
| windows_i686_gnullvm | 0.53.1 | setup(rust) |
| windows_i686_msvc | 0.42.2 | frontend(rust) |
| windows_i686_msvc | 0.52.6 | frontend(rust) |
| windows_i686_msvc | 0.53.1 | frontend(rust) |
| windows_i686_msvc | 0.42.2 | setup(rust) |
| windows_i686_msvc | 0.52.6 | setup(rust) |
| windows_i686_msvc | 0.53.1 | setup(rust) |
| windows_x86_64_gnu | 0.42.2 | frontend(rust) |
| windows_x86_64_gnu | 0.52.6 | frontend(rust) |
| windows_x86_64_gnu | 0.53.1 | frontend(rust) |
| windows_x86_64_gnu | 0.42.2 | setup(rust) |
| windows_x86_64_gnu | 0.52.6 | setup(rust) |
| windows_x86_64_gnu | 0.53.1 | setup(rust) |
| windows_x86_64_gnullvm | 0.42.2 | frontend(rust) |
| windows_x86_64_gnullvm | 0.52.6 | frontend(rust) |
| windows_x86_64_gnullvm | 0.53.1 | frontend(rust) |
| windows_x86_64_gnullvm | 0.42.2 | setup(rust) |
| windows_x86_64_gnullvm | 0.52.6 | setup(rust) |
| windows_x86_64_gnullvm | 0.53.1 | setup(rust) |
| windows_x86_64_msvc | 0.42.2 | frontend(rust) |
| windows_x86_64_msvc | 0.52.6 | frontend(rust) |
| windows_x86_64_msvc | 0.53.1 | frontend(rust) |
| windows_x86_64_msvc | 0.42.2 | setup(rust) |
| windows_x86_64_msvc | 0.52.6 | setup(rust) |
| windows_x86_64_msvc | 0.53.1 | setup(rust) |
| windows-collections | 0.2.0 | frontend(rust) |
| windows-collections | 0.2.0 | setup(rust) |
| windows-core | 0.61.2 | frontend(rust) |
| windows-core | 0.62.2 | frontend(rust) |
| windows-core | 0.61.2 | setup(rust) |
| windows-core | 0.62.2 | setup(rust) |
| windows-future | 0.2.1 | frontend(rust) |
| windows-future | 0.2.1 | setup(rust) |
| windows-implement | 0.60.2 | frontend(rust) |
| windows-implement | 0.60.2 | setup(rust) |
| windows-interface | 0.59.3 | frontend(rust) |
| windows-interface | 0.59.3 | setup(rust) |
| windows-link | 0.1.3 | frontend(rust) |
| windows-link | 0.2.1 | frontend(rust) |
| windows-link | 0.1.3 | setup(rust) |
| windows-link | 0.2.1 | setup(rust) |
| windows-numerics | 0.2.0 | frontend(rust) |
| windows-numerics | 0.2.0 | setup(rust) |
| windows-result | 0.3.4 | frontend(rust) |
| windows-result | 0.4.1 | frontend(rust) |
| windows-result | 0.3.4 | setup(rust) |
| windows-result | 0.4.1 | setup(rust) |
| windows-strings | 0.4.2 | frontend(rust) |
| windows-strings | 0.5.1 | frontend(rust) |
| windows-strings | 0.4.2 | setup(rust) |
| windows-strings | 0.5.1 | setup(rust) |
| windows-sys | 0.45.0 | frontend(rust) |
| windows-sys | 0.59.0 | frontend(rust) |
| windows-sys | 0.60.2 | frontend(rust) |
| windows-sys | 0.61.2 | frontend(rust) |
| windows-sys | 0.45.0 | setup(rust) |
| windows-sys | 0.59.0 | setup(rust) |
| windows-sys | 0.60.2 | setup(rust) |
| windows-sys | 0.61.2 | setup(rust) |
| windows-targets | 0.42.2 | frontend(rust) |
| windows-targets | 0.52.6 | frontend(rust) |
| windows-targets | 0.53.5 | frontend(rust) |
| windows-targets | 0.42.2 | setup(rust) |
| windows-targets | 0.52.6 | setup(rust) |
| windows-targets | 0.53.5 | setup(rust) |
| windows-threading | 0.1.0 | frontend(rust) |
| windows-threading | 0.1.0 | setup(rust) |
| windows-version | 0.1.7 | frontend(rust) |
| windows-version | 0.1.7 | setup(rust) |
| winnow | 0.5.40 | frontend(rust) |
| winnow | 0.7.15 | frontend(rust) |
| winnow | 1.0.4 | frontend(rust) |
| winnow | 0.5.40 | setup(rust) |
| winnow | 0.7.15 | setup(rust) |
| winnow | 1.0.4 | setup(rust) |
| winreg | 0.55.0 | frontend(rust) |
| winreg | 0.55.0 | setup(rust) |
| wit-bindgen | 0.57.1 | frontend(rust) |
| wit-bindgen | 0.57.1 | setup(rust) |
| writeable | 0.6.4 | frontend(rust) |
| writeable | 0.6.4 | setup(rust) |
| wry | 0.55.1 | frontend(rust) |
| wry | 0.55.1 | setup(rust) |
| x11 | 2.21.0 | frontend(rust) |
| x11 | 2.21.0 | setup(rust) |
| x11-dl | 2.21.0 | frontend(rust) |
| x11-dl | 2.21.0 | setup(rust) |
| yoke | 0.8.3 | frontend(rust) |
| yoke | 0.8.3 | setup(rust) |
| yoke-derive | 0.8.2 | frontend(rust) |
| yoke-derive | 0.8.2 | setup(rust) |
| zbus | 5.19.0 | frontend(rust) |
| zbus_macros | 5.19.0 | frontend(rust) |
| zbus_names | 4.3.4 | frontend(rust) |
| zcheapstr | 1.1.0 | frontend(rust) |
| zerocopy | 0.8.57 | frontend(rust) |
| zerocopy-derive | 0.8.57 | frontend(rust) |
| zerofrom | 0.1.8 | frontend(rust) |
| zerofrom | 0.1.8 | setup(rust) |
| zerofrom-derive | 0.1.7 | frontend(rust) |
| zerofrom-derive | 0.1.7 | setup(rust) |
| zerotrie | 0.2.5 | frontend(rust) |
| zerotrie | 0.2.5 | setup(rust) |
| zerovec | 0.11.8 | frontend(rust) |
| zerovec | 0.11.8 | setup(rust) |
| zerovec-derive | 0.11.6 | frontend(rust) |
| zerovec-derive | 0.11.6 | setup(rust) |
| zlib-rs | 0.6.7 | frontend(rust) |
| zlib-rs | 0.6.7 | setup(rust) |
| zmij | 1.0.23 | frontend(rust) |
| zmij | 1.0.23 | setup(rust) |
| zvariant | 5.15.0 | frontend(rust) |
| zvariant_derive | 5.15.0 | frontend(rust) |
| zvariant_utils | 4.2.0 | frontend(rust) |

## 五、随包技能（含第三方素材）

| 技能 | 位置 | 文件数 | 许可证文件 |
| --- | --- | --- | --- |
| .nis-history | backend/skills | 1 | 无 |
| agent-reach | backend/skills | 20 | 无 |
| ponytail-skills | backend/skills | 6 | 无 |
| ui-skills | backend/skills | 190 | LICENSE |
| ui-ux-pro-max-skill | backend/skills | 363 | LICENSE |
| emil-design-eng | frontend/src-tauri/pack/seed-skills | 1 | 无 |
| emilkowalski-skills | frontend/src-tauri/pack/seed-skills | 4 | LICENSE |
| foo | frontend/src-tauri/pack/seed-skills | 1 | 无 |
| ui-skills | frontend/src-tauri/pack/seed-skills | 190 | LICENSE |
| ui-ux-pro-max-skill | frontend/src-tauri/pack/seed-skills | 665 | LICENSE |
