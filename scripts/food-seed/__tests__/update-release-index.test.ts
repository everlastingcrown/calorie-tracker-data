import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { createSeedRelease, parseSeedVersionIndex } from '../release-manifest.ts';

const execFileAsync = promisify(execFile);

test('release index hashes the exact compressed generic seed bytes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'food-seed-index-'));
  const manifestPath = path.join(dir, 'foods.manifest.json');
  const genericAssetPath = path.join(dir, 'foods.seed.json.gz');
  const missingIndexPath = path.join(dir, 'missing-versions.json');
  const outputPath = path.join(dir, 'foods.versions.json');
  const compressedBytes = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xde, 0xad, 0xbe, 0xef]);
  const expectedSha256 = createHash('sha256').update(compressedBytes).digest('hex');
  const release = createSeedRelease({
    semver: '2.0.0',
    compatibility: 'compatible',
    runAt: '2026-07-27T10:00:00.000Z',
    verified: false,
  });

  try {
    await Promise.all([
      fs.writeFile(manifestPath, JSON.stringify({ release })),
      fs.writeFile(genericAssetPath, compressedBytes),
    ]);
    await execFileAsync(process.execPath, [
      '--experimental-strip-types',
      path.resolve('scripts/update-release-index.ts'),
      manifestPath,
      genericAssetPath,
      missingIndexPath,
      outputPath,
      'example/food-data',
    ]);

    const index = parseSeedVersionIndex(JSON.parse(await fs.readFile(outputPath, 'utf8')));
    assert.equal(index.versions[0].assets.sha256, expectedSha256);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
