import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseDownloadArgs } from '../../download-inputs.ts';
import { readFoodSeedInputManifest } from '../input-manifest.ts';

test('readFoodSeedInputManifest validates schema and hashes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'food-seed-manifest-'));
  const manifestPath = path.join(dir, 'manifest.json');

  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      releaseTag: 'food-seed-2026-04-30',
      sources: [
        {
          id: 'usda-foundation',
          provider: 'usda',
          title: 'USDA FoodData Central Foundation Foods',
          version: '2026-04-30',
          enabled: true,
          outputDir: 'usda',
          files: [
            {
              id: 'archive',
              url: 'https://example.com/usda.zip',
              sha256: 'a'.repeat(64),
              fileName: 'usda.zip',
              extract: 'zip',
            },
          ],
        },
      ],
    })
  );

  const manifest = await readFoodSeedInputManifest(manifestPath);
  assert.equal(manifest.releaseTag, 'food-seed-2026-04-30');
  assert.equal(manifest.sources[0].files[0].extract, 'zip');

  await rm(dir, { recursive: true, force: true });
});

test('parseDownloadArgs supports manifest, cache, output, and disabled source flags', () => {
  const args = parseDownloadArgs([
    '--manifest',
    '/tmp/manifest.json',
    '--cache-dir',
    '/tmp/cache',
    '--output-dir',
    '/tmp/out',
    '--include-disabled',
  ]);

  assert.equal(args.manifestPath, '/tmp/manifest.json');
  assert.equal(args.cacheDir, '/tmp/cache');
  assert.equal(args.outputDir, '/tmp/out');
  assert.equal(args.includeDisabled, true);
});
