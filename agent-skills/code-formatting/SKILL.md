---
name: code-formatting
description: House style for presenting code in responses - fenced blocks, language tags, and when to show a diff versus the full file.
---

# Code Formatting

- Always tag the fence with the language (```ts, ```bash, not a bare ```).
- Show only the changed function/block for an edit to an existing file, not
  the whole file, unless the user asked to see the whole file.
- For a brand-new file, show the whole thing.
- Never add line-number comments or `// ...` placeholders inside a fenced
  block that's meant to be copy-pasted — either show the real surrounding
  code or clearly say "the rest of the file is unchanged" outside the fence.
