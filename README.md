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
npm run validate:food-seed
npm run type-check
```

5. Commit the manifest/code changes.
6. Trigger **Build food seed** from GitHub Actions.
7. Choose whether to explicitly promote the run as verified, then confirm the workflow publishes the immutable versioned release and updates `foods.versions.json` on the `food-seed-index` release.

## Inputs

`npm run download:inputs` downloads enabled sources into ignored `inputs/food-seed/` directories and caches verified downloads in `.cache/food-seed-inputs/`.

Enabled sources:

- USDA FoodData Central Foundation Foods CSV
- Australian Food Composition Database Release 3 workbooks
- Open Food Facts JSONL export

## Source Licenses

Generated artifacts include normalized data derived from the enabled public sources in `inputs/manifest.json`. The manifest records the license, source URL, and attribution text for each source so GitHub release notes can be generated consistently.

- USDA FoodData Central Foundation Foods CSV: CC0 1.0 Universal / public domain. Attribution requested: U.S. Department of Agriculture, Agricultural Research Service, Beltsville Human Nutrition Research Center. FoodData Central. Available from https://fdc.nal.usda.gov/.
- Australian Food Composition Database Release 3: Creative Commons Attribution 4.0 Australia (CC BY 4.0), unless FSANZ notes otherwise for logos or third-party material. Attribution: Food Standards Australia New Zealand.
- Open Food Facts JSONL export: Open Database License (ODbL) 1.0 for the database and Database Contents License (DbCL) 1.0 for individual contents. Attribution: Contains information from Open Food Facts, made available under the Open Database License. Product images are licensed separately and are not redistributed by this pipeline.

## Outputs

`npm run build:food-seed` writes:

- `generated/food-seed/foods.seed.json`
- `generated/food-seed/foods.seed.json.gz`
- `generated/food-seed/foods-{country}.branded.json`
- `generated/food-seed/foods-{country}.branded.json.gz`
- `generated/food-seed/foods.manifest.json`
- `generated/food-seed/foods.versions.json` (release workflow only)
- `generated/food-seed/foods.qa.json`
- `generated/food-seed/foods.validation.json`
- `generated/food-seed/foods.validation.md`

Generated files and downloaded inputs are ignored by git.

The validation command checks every generic and country-branded record for readable JSON/gzip,
the seed schema, field semantics, and agreement with manifest and QA counts. It exits non-zero when
any check fails, so the release workflow cannot publish an invalid build. The Markdown report is the
maintainer summary; the JSON report provides the same deterministic pass/fail signal to automation.
Both reports are uploaded as the `food-seed-validation-report` workflow artifact even on failure and
are included in successful GitHub releases.

The plain JSON files remain local build intermediates for QA. GitHub releases publish the gzip
(`application/gzip`) seed files, using the `.json.gz` names recorded in the manifest and version
index. Gzip is supported by the app runtime and substantially reduces these highly repetitive JSON
payloads without changing the database schema after decompression.

Each build manifest records semantic version, compatibility, UTC run time, immutable release tag,
asset names, and explicit verification status. Apps should fetch `foods.versions.json` from the
stable `food-seed-index` release and use `latestVerified`; an unverified run is listed for
traceability but never changes that default pointer.

Apps should cache a seed by `versionId`, download the asset URL from that version's `assets` object,
and decompress according to its `compression` metadata before running the existing import. This
keeps old cached uncompressed versions valid while ensuring a newly selected compressed version is
stored separately; no migration of the on-device food database is required.

## Food Quality

Every emitted food has an app-facing `quality` value of `high`, `medium`, or `low`. Assignment is
deterministic and uses source provenance plus core nutrition completeness (calories, protein,
carbohydrate, and fat):

- USDA Foundation and AFCD generic foods are `high` when all four values are present, otherwise
  `medium`.
- USDA SR Legacy generic foods are `medium` when all four values are present, otherwise `low`.
- Open Food Facts branded/community-contributed foods are `medium` when all four values plus both a
  brand and barcode are present, otherwise `low`.

The pipeline does not generate local user-created or quick-add foods; those remain app-owned and
must not be assigned a guessed quality by seed consumers. The numeric `qualityScore` remains in the
seed for backward compatibility and dedupe ranking, but it is not the app-facing quality contract.
`foods.qa.json` reports counts for every quality level and a `missing` count, which is always zero
for successfully emitted rows.
