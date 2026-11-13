# Third-Party Notices

Temper is licensed under the Apache License 2.0 (see `LICENSE`). Temper is built from scratch, but small, attributed snippets and design patterns are adopted from the open-source projects below. Each adopted file carries a header comment naming its origin, repository, tag or commit, and licence. Files that are modified from an Apache-2.0 original also carry a notice describing the change.

The listing of a project here does not imply endorsement of Temper by that project or its authors.

## anomalyco/opencode

- Repository: https://github.com/anomalyco/opencode
- Licence: MIT
- Reference points: `v1.0.0` (tool descriptions and edit replacer chain), `main` at commit `f2156d79c9b3c313f999246562ecfba1513880bf`

### Files derived

| Temper file                                                     | Upstream file                                                         | Upstream ref | Changes                                                                                            |
| --------------------------------------------------------------- | --------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------- |
| `extension/src/changeset/replacers.ts` (used by `fuzzyEdit.ts`) | `packages/opencode/src/tool/edit.ts` (replacer chain, lines ~142-640) | `v1.0.0`     | Tool glue removed; `replace()` returns a result object; strategy names added; `ts-nocheck` header. |

### Upstream credits of the replacer code

The opencode replacer chain credits the following Apache-2.0 sources in its own header comment. Their notices are preserved here (full Apache-2.0 text in `LICENSE`):

- google-gemini/gemini-cli, `packages/core/src/utils/editCorrector.ts` (Apache-2.0, Copyright Google LLC).
- Cline, `evals/diff-edits/diff-apply/diff-06-23-25.ts` and `diff-06-26-25.ts` (Apache-2.0, Copyright Cline Bot Inc.).

### Licence text

```text
MIT License

Copyright (c) 2025 opencode

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
```

## cline/cline

- Repository: https://github.com/cline/cline
- Licence: Apache-2.0 (full text in `LICENSE`)
- Copyright: Cline Bot Inc.
- Reference points: `v3.20.0` (diff and checkpoint concepts), `main` at commit `72b3d7140553a733242126e51a7c2e87efe75c64`
- Upstream NOTICE file: none at the referenced commit.

### Files derived

| Temper file                                                                                   | Upstream file                                          | Upstream ref                               | Changes                                                                                                                                                               |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extension/src/review/proposedContentProvider.ts`, `extension/src/review/reviewController.ts` | `VscodeDiffContentProvider.ts`, `openMultiFileDiff.ts` | `72b3d7140553a733242126e51a7c2e87efe75c64` | Re-implemented from the pattern: keyed store instead of base64 query; `vscode.changes` with sequential `vscode.diff` fallback; plain arguments instead of gRPC types. |

## continuedev/continue

- Repository: https://github.com/continuedev/continue
- Licence: Apache-2.0 (full text in `LICENSE`)
- Copyright: Continue Dev, Inc.
- Reference point: `main` at commit `5522c6f44ca0ac3528b37244818fbfa39b5af470`
- Upstream NOTICE file: none at the referenced commit.

### Files derived

| Temper file              | Upstream file                                                                      | Upstream ref                               | Changes                                                                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extension/src/inline/*` | `diff/vertical/handler.ts`, `decorations.ts`, `VerticalPerLineCodeLensProvider.ts` | `5522c6f44ca0ac3528b37244818fbfa39b5af470` | Design only; written from scratch (proposed lines are shown in the editor buffer without saving and removed before apply). No upstream source text copied verbatim. |

## Bundled dependencies

- `@vscode/codicons` (Microsoft): icon font bundled into the webview. Icon font and images under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/), source code under MIT. Used unmodified.
- React and React DOM (Meta, MIT): bundled into the webview. Used unmodified.

## Acknowledgements

- opencode (MIT): the `missHint` and CRLF handling in its newer edit tool inspired Temper's equivalent behaviour. Re-implemented, no code copied.
- Cline (Apache-2.0): the diff and checkpoint concepts informed the changeset and checkpoint design. Code is adopted only where listed above.
