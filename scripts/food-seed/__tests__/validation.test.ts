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
    sourceUpdatedAt: null,
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
      brandedSeedCountsByCountry: { au: 1 },
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
    assert.equal(first.summary.checksPassed, 8);
    assert.deepEqual(first.summary.errorsByAsset['foods.seed.json'], {
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
    });
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

test('rejects missing, non-integer, negative, and inconsistent branded food counts', async (t) => {
  const cases: {
    name: string;
    value: number | undefined;
    expectedCategory: 'schema' | 'integrity';
    expectedError: RegExp;
  }[] = [
    {
      name: 'missing',
      value: undefined,
      expectedCategory: 'schema',
      expectedError: /must be a non-negative integer/,
    },
    {
      name: 'non-integer',
      value: 1.5,
      expectedCategory: 'schema',
      expectedError: /must be a non-negative integer/,
    },
    {
      name: 'negative',
      value: -1,
      expectedCategory: 'schema',
      expectedError: /must be a non-negative integer/,
    },
    {
      name: 'inconsistent',
      value: 2,
      expectedCategory: 'integrity',
      expectedError: /branded count 1 does not match manifest 2/,
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const dir = await createArtifacts();
      try {
        const manifestPath = path.join(dir, 'foods.manifest.json');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
          totals: { brandedSeedCount?: number };
        };
        if (testCase.value === undefined) {
          delete manifest.totals.brandedSeedCount;
        } else {
          manifest.totals.brandedSeedCount = testCase.value;
        }
        await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

        const report = await validateFoodSeedArtifacts(dir);
        const manifestCheck = report.checks.find(
          (item) =>
            item.asset.includes('foods.manifest.json') &&
            item.category === testCase.expectedCategory
        );

        assert.equal(report.status, 'fail');
        assert.ok(manifestCheck?.errors.some((error) => testCase.expectedError.test(error)));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});

test('validates different per-country counts and an empty published shard', async () => {
  const dir = await createArtifacts();
  try {
    const usFoods = [
      food({
        id: 'food-us-1',
        brandName: 'US Foods',
        countryCode: 'us',
        source: 'openfoodfacts',
      }),
      food({
        id: 'food-us-2',
        brandName: 'US Foods',
        countryCode: 'us',
        source: 'openfoodfacts',
      }),
    ];
    await Promise.all([
      writeSeedAsset(dir, 'foods-us.branded.json', usFoods),
      writeSeedAsset(dir, 'foods-ca.branded.json', []),
    ]);

    const manifestPath = path.join(dir, 'foods.manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as SeedManifest;
    manifest.totals.seedCount = 4;
    manifest.totals.brandedSeedCount = 3;
    manifest.totals.brandedSeedCountsByCountry = { au: 1, ca: 0, us: 2 };
    const qaPath = path.join(dir, 'foods.qa.json');
    const qa = JSON.parse(await readFile(qaPath, 'utf8')) as SeedQAReport;
    qa.counts.emittedFoods = 4;
    qa.counts.brandedFoods = 3;
    await Promise.all([
      writeFile(manifestPath, `${JSON.stringify(manifest)}\n`),
      writeFile(qaPath, `${JSON.stringify(qa)}\n`),
    ]);

    const report = await validateFoodSeedArtifacts(dir);

    assert.equal(report.status, 'pass');
    assert.deepEqual(
      report.assets
        .filter((asset) => asset.kind === 'branded')
        .map(({ file, records }) => ({ file, records })),
      [
        { file: 'foods-au.branded.json', records: 1 },
        { file: 'foods-ca.branded.json', records: 0 },
        { file: 'foods-us.branded.json', records: 2 },
      ]
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects malformed and artifact-inconsistent per-country branded counts', async (t) => {
  const cases: {
    name: string;
    update: (totals: Record<string, unknown>) => void;
    expectedCategory: 'schema' | 'integrity';
    expectedError: RegExp;
  }[] = [
    {
      name: 'missing map',
      update: (totals) => delete totals.brandedSeedCountsByCountry,
      expectedCategory: 'schema',
      expectedError: /must be an object keyed by country code/,
    },
    {
      name: 'non-object map',
      update: (totals) => {
        totals.brandedSeedCountsByCountry = [];
      },
      expectedCategory: 'schema',
      expectedError: /must be an object keyed by country code/,
    },
    {
      name: 'fractional count',
      update: (totals) => {
        totals.brandedSeedCountsByCountry = { au: 1.5 };
      },
      expectedCategory: 'schema',
      expectedError: /brandedSeedCountsByCountry\.au: must be a non-negative integer/,
    },
    {
      name: 'negative count',
      update: (totals) => {
        totals.brandedSeedCountsByCountry = { au: -1 };
      },
      expectedCategory: 'schema',
      expectedError: /brandedSeedCountsByCountry\.au: must be a non-negative integer/,
    },
    {
      name: 'count mismatch',
      update: (totals) => {
        totals.brandedSeedCount = 2;
        totals.seedCount = 3;
        totals.brandedSeedCountsByCountry = { au: 2 };
      },
      expectedCategory: 'integrity',
      expectedError: /country au count 1 does not match manifest 2/,
    },
    {
      name: 'missing country key',
      update: (totals) => {
        totals.brandedSeedCount = 0;
        totals.seedCount = 1;
        totals.brandedSeedCountsByCountry = {};
      },
      expectedCategory: 'integrity',
      expectedError: /country au branded count is missing/,
    },
    {
      name: 'country key without an artifact',
      update: (totals) => {
        totals.brandedSeedCount = 2;
        totals.seedCount = 3;
        totals.brandedSeedCountsByCountry = { au: 1, us: 1 };
      },
      expectedCategory: 'integrity',
      expectedError: /country us count 1 has no published branded asset/,
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const dir = await createArtifacts();
      try {
        const manifestPath = path.join(dir, 'foods.manifest.json');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
          totals: Record<string, unknown>;
        };
        testCase.update(manifest.totals);
        await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

        const report = await validateFoodSeedArtifacts(dir);
        const manifestCheck = report.checks.find(
          (item) =>
            item.asset.includes('foods.manifest.json') &&
            item.category === testCase.expectedCategory
        );

        assert.equal(report.status, 'fail');
        assert.ok(manifestCheck?.errors.some((error) => testCase.expectedError.test(error)));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});

test('rejects a non-null sourceUpdatedAt that is not a valid ISO date', async () => {
  const dir = await createArtifacts();
  try {
    await writeSeedAsset(dir, 'foods.seed.json', [food({ sourceUpdatedAt: '2026-02-29' })]);

    const report = await validateFoodSeedArtifacts(dir);
    const contentCheck = report.checks.find(
      (item) => item.asset === 'foods.seed.json' && item.category === 'content'
    );

    assert.equal(contentCheck?.status, 'fail');
    assert.deepEqual(contentCheck?.errors, [
      'record 1.sourceUpdatedAt: must be a valid ISO date string',
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects a non-null barcode that does not match barcodes[0]', async (t) => {
  const cases = [
    { name: 'different first barcode', barcodes: ['9300000000002'] },
    { name: 'empty barcode list', barcodes: [] },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const dir = await createArtifacts();
      try {
        await writeSeedAsset(dir, 'foods.seed.json', [
          food({ barcode: '9300000000001', barcodes: testCase.barcodes }),
        ]);

        const report = await validateFoodSeedArtifacts(dir);
        const contentCheck = report.checks.find(
          (item) => item.asset === 'foods.seed.json' && item.category === 'content'
        );

        assert.equal(contentCheck?.status, 'fail');
        assert.deepEqual(contentCheck?.errors, [
          'record 1.barcode: must match barcodes[0]',
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});

test('counts all asset errors while keeping the reported error arrays capped', async () => {
  const dir = await createArtifacts();
  try {
    const invalidRecords = Array.from({ length: 25 }, (_, index) =>
      food({
        id: `invalid-${index}`,
        brandName: 'Example Foods',
        caloriesPer100g: -1,
        proteinPer100g: 101,
        countryCode: 'us',
        source: 'openfoodfacts',
      })
    );
    await writeSeedAsset(dir, 'foods-au.branded.json', invalidRecords);

    const report = await validateFoodSeedArtifacts(dir);
    const errors = report.summary.errorsByAsset['foods-au.branded.json'];
    const contentCheck = report.checks.find(
      (item) => item.asset === 'foods-au.branded.json' && item.category === 'content'
    );

    assert.deepEqual(errors, {
      total: 75,
      shown: 20,
      errorRate: 3,
      byField: {
        caloriesPer100g: 25,
        proteinPer100g: 25,
        carbsPer100g: 0,
        fatPer100g: 0,
        countryCode: 25,
        other: 0,
      },
    });
    assert.equal(contentCheck?.summary, '75 error(s)');
    assert.equal(contentCheck?.errors.length, 20);
    assert.match(
      await readFile(path.join(dir, 'foods.validation.md'), 'utf8'),
      /\| `foods-au\.branded\.json` \| 75 \| 20 \| 300\.00% \| 25 \| 25 \| 0 \| 0 \| 25 \| 0 \|/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
