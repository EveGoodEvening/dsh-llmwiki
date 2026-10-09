# Third-party notices

This file preserves the upstream notice for the workflow guidance identified below. The project's own material remains licensed under [LICENSE](LICENSE). Referenced projects and separately installed dependencies retain their own copyrights and licenses; inclusion here does not imply endorsement.

## Astro-Han / karpathy-llm-wiki — workflow guidance

- Upstream project: https://github.com/Astro-Han/karpathy-llm-wiki
- Audited source: [`SKILL.md` at `eafcc77001e496cc43499e4923b663aec722c813`](https://github.com/Astro-Han/karpathy-llm-wiki/blob/eafcc77001e496cc43499e4923b663aec722c813/SKILL.md), particularly **Ingest / Triage** and **Cascade Updates**.
- Upstream license: [`LICENSE` at the same revision](https://github.com/Astro-Han/karpathy-llm-wiki/blob/eafcc77001e496cc43499e4923b663aec722c813/LICENSE).
- Local scope: the source-disposition, affected-page maintenance, and conflict/supersession guidance in `LLMWIKI_SYSTEM_PROMPT` (`src/prompt.ts`) and `DEFAULT_SCHEMA` (`src/service.ts`), their compiled representations, and corresponding workflow descriptions in the examples, maintenance fixtures, and planning/handoff documents.

The relevant guidance combines new/update/disputed/no-material source triage, maintenance of materially affected pages, and preservation of conflicting or superseded claims. This project reorganizes the guidance around its own APIs, retains some similar terminology and phrasing, calls the disputed case `contradiction`, and adds authorization and concurrency rules. The textual and procedural correspondences suggest a probable adaptation of this workflow guidance, although the original development-time use of the upstream material has not been confirmed. The upstream copyright and license notice is retained conservatively on that basis. This attribution does not extend to the plugin's storage, parser, search, or DSH integration implementation, and makes no determination about the copyrightability of an abstract workflow.

The audited revision identifies the material compared during the provenance review, not a recorded exact checkout used during the original development. Karpathy's separate LLM Wiki idea file remains a conceptual reference: no MIT license is asserted for that gist, and this notice does not relicense it.

### Upstream license text

```text
MIT License

Copyright (c) 2026 Yuhan Lei

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
