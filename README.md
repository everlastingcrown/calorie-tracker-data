# Calorie Tracker Data

This repository builds food seed artifacts for Calorie Tracker from pinned public source datasets.

The app repository stays small. This data repository downloads official source files from `inputs/manifest.json`, verifies SHA256 hashes, builds normalized seed JSON, and publishes the generated outputs as GitHub Release assets.

## Maintainer Workflow

1. Update `inputs/manifest.json` when a source URL or version changes.
2. Download the changed source locally and replace its `sha256` with the actual hash.
3. Run `npm install --include=dev` after dependency changes.
4. Run:

```sh
npm run test
npm run download:inputs
npm run build:food-seed
npm run type-check
```

5. Commit the manifest/code changes.
6. Trigger **Build food seed** from GitHub Actions.
7. Confirm the workflow publishes `foods.seed.json`, `foods.manifest.json`, and `foods.qa.json` to the release tag from `manifest.releaseTag`.

## Inputs

`npm run download:inputs` downloads enabled sources into ignored `inputs/food-seed/` directories and caches verified downloads in `.cache/food-seed-inputs/`.

Enabled sources:

- USDA FoodData Central Foundation Foods CSV
- AUSNUT 2023 workbooks
- Australian Food Composition Database Release 3 workbooks

Open Food Facts is present in the manifest but disabled. The current published JSONL export is too large for this generic food seed workflow and should be enabled only after the branded-food shard pipeline exists.

## Outputs

`npm run build:food-seed` writes:

- `generated/food-seed/foods.seed.json`
- `generated/food-seed/foods.manifest.json`
- `generated/food-seed/foods.qa.json`

Generated files and downloaded inputs are ignored by git.
