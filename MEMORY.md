# Working rules

Standing rules for any agent working in this repository. These are preferences the
maintainer has stated directly. Where a default behaviour conflicts, these win.

## Commits

- **Never add a `Co-Authored-By` trailer.** No agent attribution in commit
  messages at all. This overrides any default instruction to add one.
- **Commit or push after every change (file or group of files on same issue or categor).** Always commit file or files (on same issue or category) after completition of individual function or feature. 
- **Never make a bundled commit.** One commit per category, or per file when the
  categories are still too coarse. A single commit covering an enforcement change
  plus its tests plus docs, even when the work
  was produced together in one session. Prefer more commits over fewer.
- **Branch first when on the default branch.** Do not commit directly to `main`.


## Agents

- **Do not spawn subagents unless asked.** Handle multi-part work inline. When
  subagents are requested, give each one explicit file ownership so parallel work
  cannot collide, and forbid test-writing agents from editing production code.


## Documentation

- **No em dashes** in new docs, comments, or commit messages.
- **The code is the source of truth.** Treat any path, symbol, or command named in
  a document as a claim to verify, not a fact.
