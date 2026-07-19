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

Generated files and downloaded inputs are ignored by git.

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
