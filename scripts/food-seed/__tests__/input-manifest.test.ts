import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { downloadManifestInputs, parseDownloadArgs } from '../../download-inputs.ts';
import { readFoodSeedInputManifest } from '../input-manifest.ts';
import { buildFoodSeedReleaseNotes } from '../release-notes.ts';

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
          license: {
            name: 'CC0 1.0 Universal',
            url: 'https://creativecommons.org/publicdomain/zero/1.0/',
            attribution: 'Fixture attribution.',
          },
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
  assert.equal(manifest.sources[0].license.name, 'CC0 1.0 Universal');
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
          license: {
            name: 'Fixture License',
            url: 'https://example.com/license',
            attribution: 'Fixture source.',
          },
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

test('readFoodSeedInputManifest requires source license details', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'food-seed-manifest-license-'));
  const manifestPath = path.join(dir, 'manifest.json');

  await writeFile(
    manifestPath,
    JSON.stringify({
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
              url: 'https://example.com/source.zip',
              sha256: 'a'.repeat(64),
              fileName: 'source.zip',
            },
          ],
        },
      ],
    })
  );

  await assert.rejects(
    readFoodSeedInputManifest(manifestPath),
    /Manifest source fixture-source must include license name, url, and attribution/
  );

  await rm(dir, { recursive: true, force: true });
});

test('buildFoodSeedReleaseNotes includes enabled source licenses and skips disabled sources', () => {
  const notes = buildFoodSeedReleaseNotes({
    schemaVersion: 1,
    releaseTag: 'food-seed-test',
    sources: [
      {
        id: 'enabled-source',
        provider: 'usda',
        title: 'Enabled source',
        version: '2026-04-30',
        enabled: true,
        outputDir: 'enabled',
        license: {
          name: 'CC0 1.0 Universal',
          url: 'https://creativecommons.org/publicdomain/zero/1.0/',
          attribution: 'Enabled attribution.',
          notes: 'Use source attribution.',
        },
        files: [],
      },
      {
        id: 'disabled-source',
        provider: 'afcd',
        title: 'Disabled source',
        version: 'test',
        enabled: false,
        outputDir: 'disabled',
        license: {
          name: 'Fixture License',
          url: 'https://example.com/license',
          attribution: 'Disabled attribution.',
        },
        files: [],
      },
    ],
  });

  assert.match(notes, /## Included sources/);
  assert.match(notes, /Enabled source/);
  assert.match(notes, /CC0 1\.0 Universal/);
  assert.match(notes, /Enabled attribution\./);
  assert.match(notes, /Use source attribution\./);
  assert.doesNotMatch(notes, /Disabled source/);
});
