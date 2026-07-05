# Git setup (run once)

Single-branch, no CI/CD. Quality gates are LOCAL git hooks (Husky).

## 1. Init + dev branch
```bash
git init -b dev
```

## 2. Set the production commit identity (REQUIRED — do this before any commit)
Replace with your real name/email, then commit hygiene stays consistent:
```bash
git config user.name  "<<<SET YOUR NAME>>>"
git config user.email "<<<SET YOUR EMAIL>>>"
```
This is repo-local (no `--global`), so it can't be overridden by machine defaults.

## 3. Install hook tooling
```bash
npm i -D husky @commitlint/cli @commitlint/config-conventional lint-staged prettier eslint
npx husky init          # wires the .husky/ dir into git core.hooksPath
```
The hook scripts are already in `.husky/` — `husky init` just activates them.

## 4. Verify
```bash
git add -A
git commit -m "chore(config): scaffold project tooling and rules"   # passes commitlint
git commit -m "bad message"                                          # should be REJECTED
```

## Workflow from here
- Commit straight to `dev`. One logical change per commit. Conventional Commits only.
- `pre-commit` -> lint-staged + `tsc --noEmit`. `commit-msg` -> commitlint. `pre-push` -> tests.
- Migrations ship in the same commit as the code that needs them.
