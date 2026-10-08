# Third-party UI source notices

The `@pluxel/browser-worker-agent-ui` presentation adopts official assistant-ui and shadcn/ui registry sources
retrieved on 2026-10-04, targeting `@assistant-ui/react` 0.15.23. These registries distribute styled source
for consumers to adapt; they are not a separate UI runtime. Native assistant-ui
primitives and the installed Radix components continue to own interactions.

Fingerprints below hash the retrieved registry's decoded `files[].content` as
UTF-8, before local adaptations. They are not hashes of registry JSON or this
package's edited files. Review the upstream sources and the adaptations together
when updating.

## assistant-ui registry

| Adopted source                                  | Registry                                                                           | SHA-256 of retrieved upstream source                               |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `src/elements/thread.tsx`                       | [Thread](https://r.assistant-ui.com/thread.json)                                   | `64cb85b4076644dd319325b319264ec8e998e619a97c19e0f001d3fa5a03a016` |
| `src/conversations.tsx`                         | [ThreadList](https://r.assistant-ui.com/thread-list.json)                          | `0d0bf30eef4d96e076df5c85915cd2ef92067178579a48be33b70ab904fab4cf` |
| `src/elements/tool-group.tsx`                   | [ToolGroup](https://r.assistant-ui.com/tool-group.json)                            | `6fa7eb02ceefeb956cac1e34ab12bf95919e52036f58083d4dbd1aa69fb310e8` |
| `src/elements/reasoning.aui.tsx`                | [Reasoning](https://r.assistant-ui.com/reasoning.json)                             | `af46e4d5c13cbb2cf584b9f7212d95b9cd97b6e08c741bc829227e40dff65b4e` |
| `src/elements/reasoning.tsx`                    | [Reasoning elements](https://r.assistant-ui.com/elements-reasoning.json)           | `e59cdb4c4ccd6da31fb170603fbec624e2b7988a7ef2711e5a24ee455615ea20` |
| `src/elements/model-selector.aui.tsx`           | [ModelSelector](https://r.assistant-ui.com/model-selector.json)                    | `fa58d6cb2392e7d57d58d7d560008953f95025b1bd0a58b7539a61f7283557c1` |
| `src/elements/model-selector.tsx`               | [ModelSelector elements](https://r.assistant-ui.com/elements-model-selector.json)  | `acf333d75c5719dad612f18fc9351d061a610320cc280533c66c652f7128dbd7` |
| `src/elements/composer-trigger-popover.aui.tsx` | [ComposerTriggerPopover](https://r.assistant-ui.com/composer-trigger-popover.json) | `592d5681d4fe197174d54a0fc7243ef64155f0d2c7bd878117a04f6d050fad81` |

Upstream project: [assistant-ui/assistant-ui](https://github.com/assistant-ui/assistant-ui).

## shadcn/ui registry

The controls use the official `new-york` registry, including its default
Button variants and Radix accessibility behavior. They are bundled as source
within this package, rather than supplied by the host's HeroUI theme.

| Adopted source                       | Registry                                                                  | SHA-256 of retrieved upstream source                               |
| ------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `src/components/ui/alert-dialog.tsx` | [alert-dialog](https://ui.shadcn.com/r/styles/new-york/alert-dialog.json) | `0845e13191dd82c1125eed4eb484dcc8afb1e276c3db60327095b9542b7e7eb6` |
| `src/components/ui/alert.tsx`        | [alert](https://ui.shadcn.com/r/styles/new-york/alert.json)               | `5950ac01377e7eedc94b00eb3fee678745e4cc1a72b5343867f0733d07db6660` |
| `src/components/ui/button.tsx`       | [button](https://ui.shadcn.com/r/styles/new-york/button.json)             | `c2b999a96781e6c932632bd089095368e973bf5602e1b1a62156b7d2b43f1e84` |
| `src/components/ui/command.tsx`      | [command](https://ui.shadcn.com/r/styles/new-york/command.json)           | `bafb47a1bf2378230b53d4105cd6d246ac3ddd812d11b032157a1f9ddb38bad7` |
| `src/components/ui/dialog.tsx`       | [dialog](https://ui.shadcn.com/r/styles/new-york/dialog.json)             | `fe70a91bb924ef3a40b7504e6847ef9a57aed3b503d2a7dbb7610e821ea40b6f` |
| `src/components/ui/input.tsx`        | [input](https://ui.shadcn.com/r/styles/new-york/input.json)               | `6299a6a387dc55e528aec4342deaea0b83f1ea3a365c135a31a18ee55334f441` |
| `src/components/ui/label.tsx`        | [label](https://ui.shadcn.com/r/styles/new-york/label.json)               | `2eac8fbb04002c42b0fbc4062d20d131e421796eaf65c37d2049e29e42ecbc5a` |
| `src/components/ui/popover.tsx`      | [popover](https://ui.shadcn.com/r/styles/new-york/popover.json)           | `69f74cdd76588a1249522ff8009e044eee6080ad8cf26cb08d7a5fc3281f0255` |
| `src/components/ui/progress.tsx`     | [progress](https://ui.shadcn.com/r/styles/new-york/progress.json)         | `6b3b4b69a1cb361076174892e9a96e1a09020307616965ef89f2f7e2495b57a9` |
| `src/components/ui/select.tsx`       | [select](https://ui.shadcn.com/r/styles/new-york/select.json)             | `3d93ae07a8f3fe121ba60f4439e26bd7859f247eb8bfcafcf4b4a8a069888eec` |
| `src/components/ui/separator.tsx`    | [separator](https://ui.shadcn.com/r/styles/new-york/separator.json)       | `995c54f1c5c688f712a675fe35d55bcada2b31dba561dcc71553a1ad601e59ec` |
| `src/components/ui/sheet.tsx`        | [sheet](https://ui.shadcn.com/r/styles/new-york/sheet.json)               | `363f8e06aa5b53c6475f445117f60fa9294be79e9e4f1f5bf70886800188124e` |
| `src/components/ui/tabs.tsx`         | [tabs](https://ui.shadcn.com/r/styles/new-york/tabs.json)                 | `d41aded0394298102614635e15d709369c6bdae8fe79b918b8341ef39407ee03` |

Upstream project: [shadcn-ui/ui](https://github.com/shadcn-ui/ui).

## Streamdown bundled packages

Markdown and code rendering use published package exports. The UI build bundles
the adapter, renderer and code/CJK plugins together; consumers do not need plugin
peer overrides or separate renderer versions. Registry-source fingerprints do
not apply to these package imports.

| Package                          | Installed version | License                                                               |
| -------------------------------- | ----------------- | --------------------------------------------------------------------- |
| `@assistant-ui/react-streamdown` | `0.3.18`          | [MIT](https://github.com/assistant-ui/assistant-ui/blob/main/LICENSE) |
| `streamdown`                     | `2.7.0`           | [Apache-2.0](https://github.com/vercel/streamdown/blob/main/LICENSE)  |
| `@streamdown/code`               | `2.0.0`           | [Apache-2.0](https://github.com/vercel/streamdown/blob/main/LICENSE)  |
| `@streamdown/cjk`                | `1.0.4`           | [Apache-2.0](https://github.com/vercel/streamdown/blob/main/LICENSE)  |

Upstream projects: [assistant-ui/assistant-ui](https://github.com/assistant-ui/assistant-ui)
and [vercel/streamdown](https://github.com/vercel/streamdown). Their package licenses
remain separate from the MIT registry-source notice below.
Streamdown's upstream notice retains `Copyright 2023 Vercel, Inc.` and refers to
the [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0).

## Supported adaptations

- Thread retains the official viewport, top turn anchor, sticky footer,
  text-only user row and composer shell. The session projection supplies welcome,
  controls and assistant messages. The host chooses content width, so the demo
  maximum is omitted. Unsupported attachment, voice, feedback, edit, reload and
  branch controls are not mounted. Native `MessagePrimitive.GroupedParts` renders
  the existing pi projection without changing execution state: intermediate text,
  reasoning and tools remain process content, while the final model step supplies
  the answer. Adjacent process parts share a disclosure; errors remain visible.
- ThreadList retains the official 32px title row, native trigger/title/more menu,
  shared keyboard focus and inline rename. New conversation is first, before
  search. Scoped local history adds archive tabs, hidden-preview search, 50-row
  batches, export and confirmed deletion. Storage errors preserve edits or the
  active transcript; these UI actions do not replay tools or acquire permissions.
- ModelSelector and ComposerTriggerPopover retain their native searchable
  selection, trigger and keyboard/IME structure. Connection state and reference
  data come from the existing session or host. Selecting a reference only inserts
  text; selecting a model preserves the draft. Context estimates, complete
  token values and progress stay in the header, beside its title on wide screens
  and on a second row on narrow screens, without a separate tokenizer or agent
  loop. The input area contains the editor and model/reference/send controls;
  routine notes and message spacing are compact.
- ToolGroup keeps Radix Collapsible, its state selectors, scroll lock and
  disclosure animations; labels can be localized. Reasoning keeps the registry's
  streaming preview, bottom-following scroll and first-manual-toggle priority,
  with Radix state selectors and an explicit localized trigger label. Deprecated
  ReasoningGroup and other legacy part-group wrappers are omitted. Optional
  shimmer styling and Next.js directives are omitted. Icons use Lucide;
  class composition uses `clsx`/`tailwind-merge` and variant composition uses
  `class-variance-authority`.
- Markdown uses `@assistant-ui/react-streamdown`, Streamdown's standard code
  blocks and copy controls, and its code/CJK plugins. Final-answer copy passes
  only the projected answer text to the public `CodeBlockCopyButton`; intermediate
  text is excluded without replacing clipboard state or timers. Clipboard failures
  remain visible. Displaying or copying code never dispatches tools.
- shadcn imports use relative package paths and the installed `radix-ui`
  aggregate exports. Labels and close controls can be localized. Native
  `disabled`/`onClick`, standard variants and focus behavior are used directly,
  without a HeroUI compatibility wrapper.
- Default shadcn semantic tokens and compiled registry utilities are scoped to
  `.aui-root` and published in `dist/ui.css`. Portaled dialogs, menus, popovers,
  references and Streamdown full-screen tables use a React-owned portal container
  within that scope, which retires with the UI owner. Scope wrappers keep utility classes on descendant
  elements, including portalled content. The view does not depend on the host's
  HeroUI tokens, consumer Tailwind source scanning or global preflight.
  Handwritten rules cover host sizing, overflow and narrow-screen layout; the
  host dashboard and business-receipt UI remain independently owned.

## MIT attribution and permission notice

The copyright statements are retained from the upstream license files, checked
on 2026-10-04:

- [assistant-ui MIT license](https://github.com/assistant-ui/assistant-ui/blob/main/LICENSE)
- [shadcn/ui MIT license](https://github.com/shadcn-ui/ui/blob/main/LICENSE.md)

Both source sets are provided under the following MIT terms.

MIT License

Copyright (c) 2026 AgentbaseAI Inc.
Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
