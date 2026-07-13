# Food Seed Maintainer Workflow

## Updating Source Inputs

1. Change the relevant source `url`, `version`, `releaseTag`, and `license` metadata in `inputs/manifest.json`.
2. Download the new file outside git.
3. Compute its SHA256:

```sh
sha256sum path/to/source-file
```

4. Replace the manifest file entry's `sha256`. Omit `sha256` only for rolling sources that cannot provide durable immutable URLs; those files are downloaded fresh and their hashes are recorded in the generated artifact manifest.
5. Run `npm run download:inputs` to verify pinned manifest hashes and populate `inputs/food-seed/`.
6. Run `npm run build:food-seed` to generate artifacts.
7. Inspect `generated/food-seed/foods.qa.json` for rejected rows or duplicate spikes, and
   `generated/food-seed/foods.energy-discrepancies.json` for conflicting kJ/kcal values and any
   macro-based corrections.
8. Commit the manifest update and trigger the `Build food seed` workflow from GitHub Actions.

## Release Tags

The workflow uses `manifest.releaseTag` as the GitHub Release tag and title. Keep the tag concise, for example `food-seed-2026-04-30`, and change it whenever source data versions change so releases remain traceable to input versions.

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
