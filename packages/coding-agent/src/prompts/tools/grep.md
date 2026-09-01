Searches files/internal URLs: Rust regex, PCRE2 fallback.

<instruction>
- `path`: known files, directories, globs, internal URLs; roots `;`-separated.
- Broad searches may time out → narrow scope or use `glob` first.
- One-file line selector: `src/foo.ts:50-100`; never selects search root.
- Literal `\n` or `\\n` enables cross-line patterns.
- No matches is a successful search result reported as `No matches found`; tool success/error says whether the search ran, not whether it matched.
</instruction>

<critical>
- MUST use instead of shell `grep`/`rg`.
{{#if eagerDelegation}}- Open-ended multi-round search MUST use {{#if scoutAvailable}}Task + scout,{{else}}Task,{{/if}} not chained calls.{{/if}}
</critical>
