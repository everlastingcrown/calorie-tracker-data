# Food Seed Maintainer Workflow

## Updating Source Inputs

1. Change the relevant source `url`, `version`, and `releaseTag` in `inputs/manifest.json`.
2. Download the new file outside git.
3. Compute its SHA256:

```sh
sha256sum path/to/source-file
```

4. Replace the manifest file entry's `sha256`.
5. Run `npm run download:inputs` to verify the manifest hash and populate `inputs/food-seed/`.
6. Run `npm run build:food-seed` to generate artifacts.
7. Inspect `generated/food-seed/foods.qa.json` for rejected rows or duplicate spikes.
8. Commit the manifest update and trigger the `Build food seed` workflow from GitHub Actions.

## Release Tags

The workflow uses `manifest.releaseTag` as the GitHub Release tag. Change it whenever source data versions change so releases remain traceable to input versions.

## CI Limits

The GitHub Actions free runner has limited disk and memory. Keep the enabled manifest sources below the 14 GB storage limit and avoid enabling Open Food Facts until the branded-food pipeline filters or shards the export before artifact publication.
