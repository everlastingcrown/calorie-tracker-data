# Repository Guidelines

## Project Structure & Module Organization

This repository builds food seed data artifacts from pinned public sources. TypeScript code lives under `scripts/`: top-level commands are `download-inputs.ts`, `build-food-seed.ts`, and `create-release-tag.ts`, while reusable food-seed logic is in `scripts/food-seed/`. Tests are colocated in `scripts/food-seed/__tests__/`. Source metadata is tracked in `inputs/manifest.json`; downloaded input files in `inputs/food-seed/` are ignored. Build outputs are written to `generated/food-seed/` and are also ignored. Maintainer process notes live in `docs/maintainer-workflow.md`.

## Build, Test, and Development Commands

- `npm install --include=dev`: install runtime and TypeScript tooling.
- `npm run test`: run Node's built-in test runner against `scripts/**/*.test.ts`.
- `npm run type-check`: run `tsc --noEmit` with strict TypeScript settings.
- `npm run download:inputs`: download enabled manifest sources, verify SHA256 hashes, and populate `inputs/food-seed/`.
- `npm run build:food-seed`: normalize downloaded USDA, AUSNUT, and AFCD inputs into `generated/food-seed/`.
- `npm run release:tag`: compute the release tag from the manifest.

## Coding Style & Naming Conventions

Use strict TypeScript ES modules with explicit `.ts` import extensions, matching the existing `NodeNext` configuration. Keep scripts focused and prefer small exported helpers for behavior that needs tests. Use two-space indentation, single quotes, and semicolons, as in the existing files. Name command scripts with kebab-case (`build-food-seed.ts`) and test files with `.test.ts`.

## Testing Guidelines

Tests use `node:test` and `node:assert/strict`; avoid adding a separate test framework unless the project needs it. Place new tests near the code they cover under `__tests__/`, and name each test for the behavior being validated. For data pipeline changes, run `npm run test`, `npm run type-check`, and, when inputs are available, `npm run build:food-seed`. Inspect `generated/food-seed/foods.qa.json` for rejected rows or duplicate spikes.

## Commit & Pull Request Guidelines

Git history currently uses Conventional Commit-style subjects, such as `feat: scaffold food seed data pipeline` and `chore: initial commit`. Keep subjects imperative and scoped to the change. Pull requests should describe the data or code change, list validation commands run, mention any manifest version or hash updates, and link related issues. Include screenshots only for workflow UI changes; for data changes, summarize generated artifact and QA impacts instead.

## Security & Configuration Tips

Do not commit downloaded source archives, generated outputs, `.cache/`, `node_modules/`, or logs. When changing `inputs/manifest.json`, update source URLs, versions, release tags, and SHA256 hashes together so releases remain traceable and reproducible.
