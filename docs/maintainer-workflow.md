# Food Seed Maintainer Workflow

## Updating Source Inputs

1. Change the relevant source `url`, `version`, and `license` metadata in `inputs/manifest.json`.
   Do not edit `seedVersion` manually. The checked-in value is build fixture data; semantic-release
   passes the released version and commit-derived release type to the build workflow.
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
9. Commit the manifest update with a Conventional Commit PR title and merge it. The semantic
   release automatically triggers `Build food seed`. Every completed build is initially unverified.

## Release Tags

Pull requests must use Conventional Commit titles because the merge commit drives the pipeline
version:

- `fix:` and `perf:` produce a patch release.
- `feat:` produces a minor release.
- A `BREAKING CHANGE:` footer or `type!:`/`type(scope)!:` produces a major release.
- Other types such as `docs:`, `test:`, `refactor:`, and `chore:` do not release by default.

After a release-triggering commit reaches `main`, the **Release food seed version** workflow runs
tests and semantic-release. It creates a `food-seed-semver-vMAJOR.MINOR.PATCH` bookkeeping tag on
the reviewed merge commit and starts the build workflow with the computed semantic version and
release type. The build updates `inputs/manifest.json` only in its runner working copy before
creating artifacts; it does not push a release commit to `main`. Patch and minor releases are
marked `compatible`; major releases are marked `non-backward-compatible`.

For a local preview, create or fetch the current `food-seed-semver-vMAJOR.MINOR.PATCH` baseline tag
and run `npm run release:dry-run`. The dry run analyzes commits without changing the manifest,
creating a commit, or pushing a tag.

The build workflow requires a semantic version and release type when manually dispatched. It
creates an immutable artifact tag from that version and the UTC run timestamp, and writes the same
version to `foods.manifest.json` and
`foods.versions.json`, initially with `verified: false`.
To promote it, open the **Set food seed verification** workflow, enter the existing release tag,
follow the release link to review `foods.validation.md`, and select `verified`. The workflow also
shows the validation report in its run summary and refuses promotion unless that report passed and
belongs to the selected release.

To demote a release, run the same workflow with `unverified`. Promotion and demotion update
`foods.versions.json` on the stable `food-seed-index` release. Apps use each entry's `verified`
field and the recomputed `latestVerified` pointer; unverified releases remain discoverable for
traceability but are not eligible for the version picker.

## Branded Food Count Contract

For new `schemaVersion: 1` releases, `foods.manifest.json` exposes both the global branded record
count in `totals.brandedSeedCount` and a per-shard map in
`totals.brandedSeedCountsByCountry`. Map keys are the lowercase country codes substituted into
`foods-{country}.branded.json.gz` (including `unknown`), and values are non-negative integers. For
example, `brandedSeedCountsByCountry.au` is the exact record count for
`foods-au.branded.json.gz`. The build derives each value from the already-grouped, deduplicated
records used to write that shard, without materializing another copy of the dataset. Release
validation streams every artifact and rejects missing or extra keys, malformed counts, per-shard
count mismatches, and disagreement with the global count.

Consumers first select an entry from `foods.versions.json`, then fetch that entry's
`assets.manifest` URL and read `totals.brandedSeedCountsByCountry[countryCode]` before ingesting the
selected branded shard. This is an additive `schemaVersion: 1` field: manifests published before
the per-country contract may omit it even if they contain the older global count. Consumers must
treat an absent, non-integer, or negative country value as unknown and continue installation
without determinate progress; they must not substitute `totals.brandedSeedCount`, because it spans
all shards. [FIT-1107](/FIT/issues/FIT-1107) implements that app-side behavior.

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
