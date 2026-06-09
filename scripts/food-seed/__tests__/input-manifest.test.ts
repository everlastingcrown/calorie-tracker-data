import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { downloadManifestInputs, parseDownloadArgs } from '../../download-inputs.ts';
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

test('downloadManifestInputs writes verified manifest files to source output directories', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'food-seed-download-'));
  const cacheDir = path.join(dir, 'cache');
  const outputDir = path.join(dir, 'inputs');
  const contents = 'seed input fixture\n';
  const sha256 = createHash('sha256').update(contents).digest('hex');

  await downloadManifestInputs(
    {
      schemaVersion: 1,
      releaseTag: 'food-seed-test',
      sources: [
        {
          id: 'fixture-source',
          provider: 'usda',
          title: 'Fixture source',
          version: 'test',
          enabled: true,
          outputDir: 'fixture',
          files: [
            {
              id: 'fixture-file',
              url: `data:text/plain,${encodeURIComponent(contents)}`,
              sha256,
              fileName: 'fixture.txt',
            },
          ],
        },
      ],
    },
    {
      manifestPath: path.join(dir, 'manifest.json'),
      cacheDir,
      outputDir,
      includeDisabled: false,
    }
  );

  const downloaded = await readFile(path.join(outputDir, 'fixture', 'fixture.txt'), 'utf8');
  assert.equal(downloaded, contents);

  await rm(dir, { recursive: true, force: true });
});
