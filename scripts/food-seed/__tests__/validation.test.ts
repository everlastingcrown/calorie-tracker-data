import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import type { SeedFood, SeedManifest, SeedQAReport } from '../types.ts';
import { validateFoodSeedArtifacts } from '../validation.ts';

const generatedAt = '2026-07-23T01:00:00.000Z';

function food(overrides: Partial<SeedFood> = {}): SeedFood {
  return {
    id: 'food-1',
    name: 'Rolled oats',
    brandName: null,
    countryCode: null,
    caloriesPer100g: 379,
    proteinPer100g: 13.2,
    carbsPer100g: 67.7,
    fatPer100g: 6.5,
    servingSizeG: 40,
    servingQuantity: 0.5,
    servingUnit: 'cup',
    servingDescription: '1/2 cup',
    servingWeightsG: { cup: 80 },
    servingSizes: [
      {
        grams: 40,
        quantity: 0.5,
        unit: 'cup',
        description: '1/2 cup',
        source: 'usda_portion',
        quality: 'high',
        confidence: 0.95,
      },
    ],
    barcode: null,
    barcodes: [],
    source: 'usda',
    license: 'CC0',
    sourceUpdatedAt: '2026-01-01',
    quality: 'high',
    qualityScore: 100,
    createdAt: generatedAt,
    ...overrides,
  };
}

async function writeSeedAsset(dir: string, file: string, records: SeedFood[]): Promise<void> {
  const json = `${JSON.stringify(records, null, 2)}\n`;
  await Promise.all([
    writeFile(path.join(dir, file), json),
    writeFile(path.join(dir, `${file}.gz`), gzipSync(json)),
  ]);
}

async function createArtifacts(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'food-seed-validation-'));
  const generic = food();
  const branded = food({
    id: 'food-2',
    name: 'Crunchy oats',
    brandName: 'Example Foods',
    countryCode: 'au',
    barcode: '9300000000001',
    barcodes: ['9300000000001'],
    source: 'openfoodfacts',
    license: 'ODbL',
    quality: 'medium',
  });
  await Promise.all([
    writeSeedAsset(dir, 'foods.seed.json', [generic]),
    writeSeedAsset(dir, 'foods-au.branded.json', [branded]),
  ]);

  const manifest = {
    schemaVersion: 1,
    generatedAt,
    release: {},
    stagingSchemaVersion: 2,
    sources: [],
    totals: {
      stagingRecordCount: 2,
      seedCount: 2,
      genericSeedCount: 1,
      brandedSeedCount: 1,
      rejectedRowCount: 0,
      duplicateGroupCount: 0,
    },
  } as unknown as SeedManifest;
  const qa = {
    generatedAt,
    counts: {
      stagingRecords: 2,
      emittedFoods: 2,
      genericFoods: 1,
      brandedFoods: 1,
      rejectedRows: 0,
      duplicateGroups: 0,
      quality: { high: 1, medium: 1, low: 0, missing: 0 },
    },
    rejectedRows: [],
    rejectedRowsTruncated: false,
    duplicateGroups: [],
  } satisfies SeedQAReport;
  await Promise.all([
    writeFile(path.join(dir, 'foods.manifest.json'), `${JSON.stringify(manifest)}\n`),
    writeFile(path.join(dir, 'foods.qa.json'), `${JSON.stringify(qa)}\n`),
  ]);
  return dir;
}

test('validates every seed artifact and writes deterministic reports', async () => {
  const dir = await createArtifacts();
  try {
    const first = await validateFoodSeedArtifacts(dir);
    const firstJson = await readFile(path.join(dir, 'foods.validation.json'), 'utf8');
    const firstMarkdown = await readFile(path.join(dir, 'foods.validation.md'), 'utf8');
    const second = await validateFoodSeedArtifacts(dir);

    assert.equal(first.status, 'pass');
    assert.equal(first.summary.assetsChecked, 2);
    assert.equal(first.summary.recordsChecked, 2);
    assert.equal(first.summary.checksPassed, 7);
    assert.deepEqual(second, first);
    assert.equal(await readFile(path.join(dir, 'foods.validation.json'), 'utf8'), firstJson);
    assert.equal(await readFile(path.join(dir, 'foods.validation.md'), 'utf8'), firstMarkdown);
    assert.match(firstMarkdown, /\*\*Overall: PASS\*\*/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reports schema, content, integrity, and count failures', async () => {
  const dir = await createArtifacts();
  try {
    const invalid = food({ brandName: 'Not generic', caloriesPer100g: -1 });
    await writeFile(
      path.join(dir, 'foods.seed.json'),
      `${JSON.stringify([invalid, { ...food({ id: 'food-3' }), name: 42 }])}\n`
    );
    await writeFile(path.join(dir, 'foods.seed.json.gz'), 'not gzip');

    const report = await validateFoodSeedArtifacts(dir);

    assert.equal(report.status, 'fail');
    assert.ok(report.summary.checksFailed >= 2);
    assert.equal(
      report.checks.find((item) => item.asset === 'foods.seed.json' && item.category === 'integrity')?.status,
      'fail'
    );
    assert.equal(
      report.checks.find((item) => item.asset === 'foods.seed.json' && item.category === 'schema')?.status,
      'fail'
    );
    assert.equal(
      report.checks.find((item) => item.asset === 'foods.seed.json' && item.category === 'content')?.status,
      'fail'
    );
    assert.match(await readFile(path.join(dir, 'foods.validation.md'), 'utf8'), /\*\*Overall: FAIL\*\*/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
