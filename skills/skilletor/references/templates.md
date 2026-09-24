# Templates — `.njk` rendering, vars, switching items on and off

## Rendering

A source file ending in `.njk` is rendered with Nunjucks and installed with the `.njk`
stripped; every other file is copied byte for byte. Context:

| Variable | Value |
|---|---|
| `vars.*` | `source defaults < bundle < user < project < local` |
| `project.dir`, `.name`, `.git_remote` | project scope only |
| `scope` | `user` or `project` |
| `harness` | `claude` / `codex` — rendered once per target |
| `target.dir` | the install root |
| `host.name`, `host.os`, `user.name`, `user.home` | machine and user |
| `item.name`, `item.type`, `item.source` | the item being rendered |

Deliberately no `env.*`. Printing an undefined variable (`{{ vars.x }}`) is an error;
testing one (`{% if vars.x %}`) is just false. User-scope items see only user vars.

## Empty render = item off

If the main file (`SKILL.md.njk`, `<name>.md.njk`) renders to whitespace once a leading
frontmatter block is stripped, the item is skipped in that scope and target: nothing
written, an installed copy removed, no error. A main file without `.njk` is never skipped.
Report: `· rules/k8s skipped (renders empty)`. Pattern:

```njk
---
paths: ["**/*.yaml"]
---
{% if vars.kubernetes %}
Use kubectl --context {{ vars.k8s_context }}.
{% endif %}
```

Install the set with `"rules": ["*@shared"]`, switch each with `"vars": { "kubernetes": true }`;
a var printed inside the gate (`k8s_context`) needs a default in the source's `skilletor.json`.
`{% if harness == "claude" %}` gates to one harness.

## Tags inside frontmatter: `{%-`

Nunjucks runs without trimBlocks, so a tag on its own line leaves a blank line — and
briefing's parser stops at the first blank line in a `briefing:` block, silently dropping
every skill after it. Open each tag with `{%-` (left side only; `-%}` also eats the next
newline and merges the lines):

```njk
briefing:
  skills:
    - code-review
    {%- if vars.perl %}
    - perl-style
    {%- endif %}
```
