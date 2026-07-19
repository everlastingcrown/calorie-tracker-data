import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSeedRelease,
  updateSeedVersionIndex,
} from '../release-manifest.ts';

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
