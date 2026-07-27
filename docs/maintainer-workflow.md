# Food Seed Maintainer Workflow

## Updating Source Inputs

1. Change the relevant source `url`, `version`, and `license` metadata in `inputs/manifest.json`. Update `seedVersion.semver` and its explicit compatibility indicator when the output contract changes.
2. Download the new file outside git.
3. Compute its SHA256:

```sh
sha256sum path/to/source-file
```

4. Replace the manifest file entry's `sha256`. Omit `sha256` only for rolling sources that cannot provide durable immutable URLs; those files are downloaded fresh and their hashes are recorded in the generated artifact manifest.
5. Run `npm run download:inputs` to verify pinned manifest hashes and populate `inputs/food-seed/`.
6. Run `npm run build:food-seed` to generate artifacts.
7. Run `npm run validate:food-seed`. Review `generated/food-seed/foods.validation.md`; every check
   must pass before promotion. The equivalent machine-readable report is
   `generated/food-seed/foods.validation.json`.
8. Inspect `generated/food-seed/foods.qa.json` for rejected rows or duplicate spikes, and
   `generated/food-seed/foods.energy-discrepancies.json` for conflicting kJ/kcal values and any
   macro-based corrections.
9. Commit the manifest update and trigger the `Build food seed` workflow from GitHub Actions.
   Every completed build is initially unverified.

## Release Tags

The build workflow creates an immutable tag from `seedVersion.semver` and the UTC run timestamp.
To promote it, open the **Set food seed verification** workflow, enter the existing release tag,
follow the release link to review `foods.validation.md`, and select `verified`. The workflow also
shows the validation report in its run summary and refuses promotion unless that report passed and
belongs to the selected release.

To demote a release, run the same workflow with `unverified`. Promotion and demotion update
`foods.versions.json` on the stable `food-seed-index` release. Apps use each entry's `verified`
field and the recomputed `latestVerified` pointer; unverified releases remain discoverable for
traceability but are not eligible for the version picker.

## Seed Asset Compression

The build creates gzip-compressed generic and country-branded seed assets at compression level 9.
Plain JSON remains in the ignored build directory for QA and round-trip checks, but the release
workflow publishes only `foods.seed.json.gz` and `foods-{country}.branded.json.gz`. The release
manifest and stable version index identify the codec as `gzip`, the media type as
`application/gzip`, and point their asset fields at the compressed files. Each stable index entry
also records the SHA-256 of the exact published `foods.seed.json.gz` bytes in `assets.sha256`.
When the first digest-aware release updates a legacy index, the publisher downloads retained
generic assets and backfills their matching digests before replacing the stable index.

Compression is a packaging boundary: consumers decompress the selected asset and pass the original
JSON bytes to their existing importer. Cache entries should be keyed by the immutable `versionId`.
That allows an old uncompressed cached seed and a new compressed seed to coexist, and avoids any
schema or on-device database migration.

## Source Licenses

Before enabling or updating a source, verify the source license and attribution requirements from the publisher, then update the source `license` block in `inputs/manifest.json`. The workflow runs `npm run release:notes` and uses the generated body for the GitHub Release description, so license notes in the manifest are published with the artifacts.

For the currently enabled sources, the verified license pages are:

- USDA FoodData Central: https://fdc.nal.usda.gov/
- Food Standards Australia New Zealand copyright: https://www.foodstandards.gov.au/legal-policies/copyright
- Open Food Facts data exports: https://world.openfoodfacts.org/data
- Open Food Facts API documentation: https://openfoodfacts.github.io/openfoodfacts-server/api/

Open Food Facts uses the official `https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz` export. It redirects to S3, but S3 object versions may expire under the publisher's lifecycle policy. Keep this source on the stable static URL without `sha256`; each generated `foods.manifest.json` records the actual downloaded file hash.

## CI Limits

The GitHub Actions free runner has limited disk and memory. Keep enabled manifest sources below the 14 GB storage limit, and inspect `foods.qa.json` after source changes for rejected-row or duplicate spikes.
