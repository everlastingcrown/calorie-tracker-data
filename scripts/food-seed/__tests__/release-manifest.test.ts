import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSeedRelease,
  setSeedReleaseVerification,
  updateSeedVersionIndex,
} from '../release-manifest.ts';
import type { FoodSeedValidationReport } from '../validation.ts';

function validation(
  generatedAt: string,
  status: FoodSeedValidationReport['status'] = 'pass'
): FoodSeedValidationReport {
  return {
    schemaVersion: 1,
    generatedAt,
    status,
    summary: {
      assetsChecked: 1,
      recordsChecked: 1,
      checksPassed: status === 'pass' ? 1 : 0,
      checksFailed: status === 'fail' ? 1 : 0,
      errorsByAsset: {
        'foods.seed.json': {
          total: 0,
          shown: 0,
          errorRate: 0,
          byField: {
            caloriesPer100g: 0,
            proteinPer100g: 0,
            carbsPer100g: 0,
            fatPer100g: 0,
            countryCode: 0,
            other: 0,
          },
        },
      },
    },
    dataQuality: {
      stagingRecords: 1,
      emittedFoods: 1,
      genericFoods: 1,
      brandedFoods: 0,
      rejectedRows: 0,
      duplicateGroups: 0,
      quality: { high: 1, medium: 0, low: 0, missing: 0 },
    },
    assets: [{ file: 'foods.seed.json', kind: 'generic', records: 1 }],
    checks: [],
  };
}

test('createSeedRelease combines semver and canonical run time into an immutable version', () => {
  const release = createSeedRelease({
    semver: '2.0.0',
    compatibility: 'non-backward-compatible',
    runAt: '2026-07-19T06:30:00.000Z',
    verified: true,
  });

  assert.equal(release.versionId, '2.0.0+20260719T063000Z');
  assert.equal(release.releaseTag, 'food-seed-v2.0.0-20260719T063000Z');
  assert.equal(release.compatibility, 'non-backward-compatible');
  assert.equal(release.verified, true);
  assert.deepEqual(release.compression, {
    codec: 'gzip',
    mediaType: 'application/gzip',
    fileExtension: '.gz',
  });
  assert.equal(release.assets.generic, 'foods.seed.json.gz');
  assert.equal(release.assets.brandedTemplate, 'foods-{country}.branded.json.gz');
});

test('createSeedRelease rejects malformed semantic versions and run timestamps', () => {
  assert.throws(
    () =>
      createSeedRelease({
        semver: '2.0',
        compatibility: 'compatible',
        runAt: '2026-07-19T06:30:00.000Z',
        verified: false,
      }),
    /MAJOR.MINOR.PATCH/
  );
  assert.throws(
    () =>
      createSeedRelease({
        semver: '2.0.0',
        compatibility: 'compatible',
        runAt: '2026-07-19',
        verified: false,
      }),
    /canonical ISO 8601 UTC/
  );
});

test('unverified releases never replace the latest verified default', () => {
  const verified = createSeedRelease({
    semver: '1.0.0',
    compatibility: 'compatible',
    runAt: '2026-07-18T06:30:00.000Z',
    verified: true,
  });
  const unverified = createSeedRelease({
    semver: '1.1.0',
    compatibility: 'compatible',
    runAt: '2026-07-19T06:30:00.000Z',
    verified: false,
  });
  const initial = updateSeedVersionIndex(null, verified, 'example/food-data');
  const updated = updateSeedVersionIndex(initial, unverified, 'example/food-data');

  assert.equal(updated.latestVerified, verified.versionId);
  assert.deepEqual(updated.versions.map((item) => item.versionId), [
    unverified.versionId,
    verified.versionId,
  ]);
  assert.match(updated.versions[0].assets.manifest, /food-seed-v1\.1\.0/);
  assert.match(updated.versions[0].assets.generic, /foods\.seed\.json\.gz$/);
  assert.match(updated.versions[0].assets.brandedTemplate, /foods-\{country\}\.branded\.json\.gz$/);
});

test('a verified promotion becomes the default and replaces a matching unverified entry', () => {
  const unverified = createSeedRelease({
    semver: '2.0.0',
    compatibility: 'non-backward-compatible',
    runAt: '2026-07-19T06:30:00.000Z',
    verified: false,
  });
  const promoted = { ...unverified, verified: true };
  const initial = updateSeedVersionIndex(null, unverified, 'example/food-data');
  const updated = updateSeedVersionIndex(initial, promoted, 'example/food-data');

  assert.equal(updated.versions.length, 1);
  assert.equal(updated.versions[0].verified, true);
  assert.equal(updated.latestVerified, promoted.versionId);
});

test('promotes a completed release with a passing validation report', () => {
  const release = createSeedRelease({
    semver: '2.0.0',
    compatibility: 'compatible',
    runAt: '2026-07-19T06:30:00.000Z',
    verified: false,
  });
  const initial = updateSeedVersionIndex(null, release, 'example/food-data');
  const updated = setSeedReleaseVerification(
    initial,
    release,
    validation(release.runAt),
    true,
    '2026-07-20T07:00:00.000Z'
  );

  assert.equal(updated.versions[0].verified, true);
  assert.equal(updated.latestVerified, release.versionId);
  assert.equal(updated.updatedAt, '2026-07-20T07:00:00.000Z');
});

test('rejects promotion when validation failed or belongs to another release', () => {
  const release = createSeedRelease({
    semver: '2.0.0',
    compatibility: 'compatible',
    runAt: '2026-07-19T06:30:00.000Z',
    verified: false,
  });
  const initial = updateSeedVersionIndex(null, release, 'example/food-data');
  const changedAt = '2026-07-20T07:00:00.000Z';

  assert.throws(
    () =>
      setSeedReleaseVerification(
        initial,
        release,
        validation(release.runAt, 'fail'),
        true,
        changedAt
      ),
    /cannot be verified/
  );
  assert.throws(
    () =>
      setSeedReleaseVerification(
        initial,
        release,
        validation('2026-07-19T06:31:00.000Z'),
        true,
        changedAt
      ),
    /does not belong/
  );
});

test('demotes a verified release and falls back to the next verified version', () => {
  const older = createSeedRelease({
    semver: '1.0.0',
    compatibility: 'compatible',
    runAt: '2026-07-18T06:30:00.000Z',
    verified: true,
  });
  const newer = createSeedRelease({
    semver: '1.1.0',
    compatibility: 'compatible',
    runAt: '2026-07-19T06:30:00.000Z',
    verified: true,
  });
  const initial = updateSeedVersionIndex(
    updateSeedVersionIndex(null, older, 'example/food-data'),
    newer,
    'example/food-data'
  );
  const updated = setSeedReleaseVerification(
    initial,
    newer,
    validation(newer.runAt),
    false,
    '2026-07-20T07:00:00.000Z'
  );

  assert.equal(updated.versions[0].verified, false);
  assert.equal(updated.latestVerified, older.versionId);
});
