import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import * as XLSXModule from 'xlsx';
import { testExports } from '../pipeline.ts';
import { createSeedRelease } from '../release-manifest.ts';
import { validateFoodSeedArtifacts } from '../validation.ts';

type XlsxModule = typeof import('xlsx');
const XLSX = ((XLSXModule as XlsxModule & { default?: XlsxModule }).default ??
  XLSXModule) as XlsxModule;

const testRelease = createSeedRelease({
  semver: '1.0.0',
  compatibility: 'compatible',
  runAt: '2026-07-19T06:00:00.000Z',
  verified: false,
});

function createDedupeRecord(input: {
  providerId: string;
  name: string;
  brandName?: string | null;
  countryCode?: string | null;
  barcode?: string | null;
  servingSizeG?: number | null;
  imageUrl?: string | null;
}) {
  return testExports.createStagingRecord({
    provider: 'openfoodfacts',
    providerId: input.providerId,
    name: input.name,
    brandName: input.brandName ?? null,
    countryCode: input.countryCode ?? null,
    region: 'global',
    caloriesPer100g: 588,
    proteinPer100g: 25,
    carbsPer100g: 20,
    fatPer100g: 50,
    servingSizeG: input.servingSizeG ?? null,
    servingQuantity: null,
    servingUnit: null,
    servingDescription: null,
    servingWeightsG: {},
    barcode: input.barcode ?? null,
    imageUrl: input.imageUrl ?? null,
    license: 'ODbL',
    sourceUpdatedAt: null,
    warnings: [],
  });
}

test('parseUsdaDirectory extracts household serving weights from portions', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'food-seed-usda-'));

  await writeFile(
    path.join(dir, 'food.csv'),
    [
      'fdc_id,data_type,description,publication_date',
      '1000,Foundation,"Tomatoes, raw",2026-04-30',
    ].join('\n')
  );
  await writeFile(
    path.join(dir, 'food_nutrient.csv'),
    [
      'fdc_id,nutrient_id,amount',
      '1000,1008,18',
      '1000,1003,0.9',
      '1000,1005,3.9',
      '1000,1004,0.2',
    ].join('\n')
  );
  await writeFile(
    path.join(dir, 'measure_unit.csv'),
    ['id,name', '1,cup', '2,tbsp'].join('\n')
  );
  await writeFile(
    path.join(dir, 'food_portion.csv'),
    [
      'fdc_id,amount,measure_unit_id,portion_description,modifier,gram_weight',
      '1000,1,1,"chopped",,240',
      '1000,2,2,"minced",,30',
    ].join('\n')
  );

  const [foundation] = await testExports.parseUsdaDirectory(dir);
  const record = foundation.stagingRecords[0];

  assert.equal(record.servingSizeG, 30);
  assert.equal(record.servingQuantity, 2);
  assert.equal(record.servingUnit, 'tbsp');
  assert.deepEqual(record.servingWeightsG, { cup: 240, tbsp: 15 });
  assert.deepEqual(record.servingSizes, [
    {
      grams: 30,
      quantity: 2,
      unit: 'tbsp',
      description: '2 tbsp minced',
      source: 'usda_portion',
      quality: 'high',
      confidence: 0.95,
    },
    {
      grams: 240,
      quantity: 1,
      unit: 'cup',
      description: '1 cup chopped',
      source: 'usda_portion',
      quality: 'high',
      confidence: 0.95,
    },
  ]);

  await rm(dir, { recursive: true, force: true });
});

test('parseOpenFoodFactsDirectory extracts serving weight from serving text', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'food-seed-off-'));
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'products.jsonl'),
    `${JSON.stringify({
      code: '1234567890123',
      product_name: 'Peanut Butter',
      brands: 'Example Brand',
      serving_quantity: '30',
      serving_size: '2 tbsp (30 g)',
      nutriments: {
        'energy-kcal_100g': 588,
        proteins_100g: 25,
        carbohydrates_100g: 20,
        fat_100g: 50,
      },
    })}\n`
  );

  const [source] = await testExports.parseOpenFoodFactsDirectory(dir);
  const record = source.stagingRecords[0];

  assert.equal(record.provider, 'openfoodfacts');
  assert.equal(record.servingSizeG, 30);
  assert.equal(record.servingQuantity, 2);
  assert.equal(record.servingUnit, 'tbsp');
  assert.equal(record.servingDescription, '2 tbsp (30 g)');
  assert.deepEqual(record.servingWeightsG, { tbsp: 15 });
  assert.deepEqual(record.servingSizes, [
    {
      grams: 30,
      quantity: 2,
      unit: 'tbsp',
      description: '2 tbsp (30 g)',
      source: 'off_label',
      quality: 'medium',
      confidence: 0.75,
    },
  ]);

  await rm(dir, { recursive: true, force: true });
});

test('normalizeOpenFoodFactsCountryCode maps Korean country tags to ISO KR', () => {
  assert.equal(testExports.normalizeOpenFoodFactsCountryCode(['en:south-korea']), 'kr');
  assert.equal(testExports.normalizeOpenFoodFactsCountryCode(['en:korea']), 'kr');
  assert.equal(testExports.normalizeOpenFoodFactsCountryCode(['en:korea-republic-of']), 'kr');
  assert.equal(testExports.normalizeOpenFoodFactsCountryCode(['en:republic-of-korea']), 'kr');
});

test('parseOpenFoodFactsDirectory treats a labelled portion as one discrete serving', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'food-seed-off-'));
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'products.jsonl'),
    `${JSON.stringify({
      code: '4061459224641',
      product_name: 'Lactose Free Light Long Life Milk 99.9% Fat Free',
      brands: 'Farmdale',
      countries_tags: ['en:australia'],
      serving_quantity: 250,
      serving_size: '1 portion (250 ml)',
      nutriments: {
        'energy-kcal_100g': 34.8,
        proteins_100g: 3.2,
        carbohydrates_100g: 4.8,
        fat_100g: 0.12,
      },
    })}\n`
  );

  const [source] = await testExports.parseOpenFoodFactsDirectory(dir);
  const record = source.stagingRecords[0];

  assert.equal(record.providerId, '4061459224641');
  assert.equal(record.countryCode, 'au');
  assert.equal(record.servingSizeG, 250);
  assert.equal(record.servingQuantity, 1);
  assert.equal(record.servingUnit, 'serving');
  assert.equal(record.servingDescription, '1 portion (250 ml)');
  assert.deepEqual(record.servingWeightsG, { serving: 250 });
  assert.deepEqual(record.servingSizes, [
    {
      grams: 250,
      quantity: 1,
      unit: 'serving',
      description: '1 portion (250 ml)',
      source: 'off_label',
      quality: 'medium',
      confidence: 0.75,
    },
  ]);

  assert.ok(record.caloriesPer100g != null);
  assert.ok(record.proteinPer100g != null);
  assert.ok(record.carbsPer100g != null);
  assert.ok(record.fatPer100g != null);
  const portionMultiplier = record.servingSizeG / 100;
  assert.equal(record.caloriesPer100g * portionMultiplier, 87);
  assert.equal(record.proteinPer100g * portionMultiplier, 8);
  assert.equal(record.carbsPer100g * portionMultiplier, 12);
  assert.equal(record.fatPer100g * portionMultiplier, 0.3);

  await rm(dir, { recursive: true, force: true });
});

test('parseOpenFoodFactsDirectory prefers structured packaging serving grams', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'food-seed-off-'));
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'products.jsonl'),
    `${JSON.stringify({
      code: '9310432001423',
      product_name: 'Udon noodles',
      brands: 'Obento',
      serving_size: 'serving',
      nutrition: {
        input_sets: [
          {
            per: 'serving',
            per_quantity: 200,
            per_unit: 'g',
            source: 'packaging',
          },
        ],
      },
      nutriments: {
        'energy-kcal_100g': 138.62,
        proteins_100g: 3.1,
        carbohydrates_100g: 28.8,
        fat_100g: 0.4,
      },
    })}\n`
  );

  const [source] = await testExports.parseOpenFoodFactsDirectory(dir);
  const record = source.stagingRecords[0];

  assert.equal(record.servingSizeG, 200);
  assert.equal(record.servingQuantity, 1);
  assert.equal(record.servingUnit, 'serving');
  assert.equal(record.servingDescription, 'serving');
  assert.deepEqual(record.servingWeightsG, { serving: 200 });
  assert.deepEqual(record.servingSizes, [
    {
      grams: 200,
      quantity: 1,
      unit: 'serving',
      description: 'serving',
      source: 'off_structured',
      quality: 'high',
      confidence: 0.95,
    },
  ]);

  await rm(dir, { recursive: true, force: true });
});

test('parseOpenFoodFactsServing skips structured serving milliliters', () => {
  const serving = testExports.parseOpenFoodFactsServing({
    serving_size: '2 tbsp (30 g)',
    nutrition: {
      input_sets: [
        {
          per: 'serving',
          per_quantity: 250,
          per_unit: 'ml',
          source: 'packaging',
        },
      ],
    },
  });

  assert.equal(serving?.grams, 30);
  assert.equal(serving?.quantity, 2);
  assert.equal(serving?.unit, 'tbsp');
  assert.deepEqual(serving?.weightsG, { tbsp: 15 });
});

test('parseOpenFoodFactsDirectory accepts Obento udon Open Food Facts energy fields', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'food-seed-off-'));
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'products.jsonl'),
    `${JSON.stringify({
      code: '9310432001423',
      product_name: 'Udon noodles',
      brands: 'Obento',
      countries_tags: ['en:australia', 'en:united-states'],
      serving_quantity: 200,
      serving_size: '1 serving (200 g)',
      last_modified_t: 1780786880,
      nutriments: {
        'energy-kcal': 138.623326959847,
        'energy-kcal_100g': 138.623326959847,
        'energy-kj': 557.1,
        'energy-kj_100g': 557.1,
        energy_100g: 557.1,
        proteins_100g: 3.1,
        carbohydrates_100g: 28.8,
        fat_100g: 0.4,
      },
    })}\n`
  );

  const [source] = await testExports.parseOpenFoodFactsDirectory(dir);
  const record = source.stagingRecords[0];

  assert.equal(source.rejectedRows.length, 0);
  assert.equal(record.providerId, '9310432001423');
  assert.equal(record.name, 'Udon noodles');
  assert.equal(record.brandName, 'Obento');
  assert.equal(record.countryCode, 'au');
  assert.equal(record.caloriesPer100g, 138.623326959847);
  assert.equal(record.proteinPer100g, 3.1);
  assert.equal(record.carbsPer100g, 28.8);
  assert.equal(record.fatPer100g, 0.4);
  assert.equal(record.servingSizeG, 200);
  assert.equal(record.servingQuantity, 1);
  assert.equal(record.servingUnit, 'serving');

  await rm(dir, { recursive: true, force: true });
});

test('parseOpenFoodFactsDirectory uses aggregated nutrients when nutriments is null', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'food-seed-off-'));
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'products.jsonl'),
    `${JSON.stringify({
      code: '9310432001423',
      product_name: 'Udon noodles',
      brands: 'Obento',
      countries_tags: ['en:australia', 'en:united-states'],
      serving_quantity: 200,
      serving_size: '1 serving (200 g)',
      nutriments: null,
      nutrition: {
        aggregated_set: {
          nutrients: {
            'energy-kcal': { value: '138.62', unit: 'kcal', source: 'label', source_per: '100g' },
            proteins: { value: '3.1', unit: 'g', source: 'label', source_per: '100g' },
            carbohydrates: { value: 28.8, unit: 'g', source: 'label', source_per: '100g' },
            fat: { value: 0.4, unit: 'g', source: 'label', source_per: '100g' },
          },
        },
      },
    })}\n`
  );

  const [source] = await testExports.parseOpenFoodFactsDirectory(dir);
  const record = source.stagingRecords[0];

  assert.equal(source.rejectedRows.length, 0);
  assert.equal(record.providerId, '9310432001423');
  assert.equal(record.caloriesPer100g, 138.62);
  assert.equal(record.proteinPer100g, 3.1);
  assert.equal(record.carbsPer100g, 28.8);
  assert.equal(record.fatPer100g, 0.4);

  await rm(dir, { recursive: true, force: true });
});

test('parseOpenFoodFactsDirectory normalizes OFF nutrient units and serving values per 100g', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'food-seed-off-'));
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'products.jsonl'),
    `${JSON.stringify({
      code: '9000000000001',
      product_name: 'Unit-labelled protein drink',
      brands: 'Example Brand',
      serving_quantity: 20,
      serving_size: '1 serving (20 g)',
      nutriments: null,
      nutrition: {
        aggregated_set: {
          per: 'serving',
          nutrients: {
            'energy-kcal': { value: 40, unit: 'kcal', source_per: 'serving' },
            proteins: { value: 603, unit: 'mg', source_per: 'serving' },
            carbohydrates: { value: 2, unit: 'g', source_per: 'serving' },
            fat: { value: 247, unit: 'mg', source_per: 'serving' },
          },
        },
      },
    })}\n`
  );

  const [source] = await testExports.parseOpenFoodFactsDirectory(dir);
  const record = source.stagingRecords[0];

  assert.equal(source.rejectedRows.length, 0);
  assert.equal(source.nutrientCorrectionCount, 4);
  assert.equal(record.caloriesPer100g, 200);
  assert.equal(record.proteinPer100g, 3.01);
  assert.equal(record.carbsPer100g, 10);
  assert.equal(record.fatPer100g, 1.23);
  assert.equal(record.warnings.length, 4);
  assert.ok(record.warnings.every((warning) => warning.startsWith('normalized ')));

  await rm(dir, { recursive: true, force: true });
});

test('parseOpenFoodFactsDirectory drops implausible OFF nutrients and marks the record low quality', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'food-seed-off-'));
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'products.jsonl'),
    `${JSON.stringify({
      code: '9000000000002',
      product_name: 'Invalid nutrition label',
      brands: 'Example Brand',
      nutriments: {
        'energy-kcal_100g': 250,
        proteins_100g: -4.76,
        carbohydrates_100g: 30,
        fat_100g: 104,
      },
    })}\n`
  );

  const [source] = await testExports.parseOpenFoodFactsDirectory(dir);
  const record = source.stagingRecords[0];
  const food = testExports.buildSeedFood(record, '2026-07-23T00:00:00.000Z');

  assert.equal(source.rejectedRows.length, 0);
  assert.equal(source.nutrientCorrectionCount, 2);
  assert.equal(record.proteinPer100g, null);
  assert.equal(record.carbsPer100g, 30);
  assert.equal(record.fatPer100g, null);
  assert.match(record.warnings[0], /outside 0\.\.100/);
  assert.match(record.warnings[1], /outside 0\.\.100/);
  assert.equal(food.proteinPer100g, 0);
  assert.equal(food.fatPer100g, 0);
  assert.equal(food.quality, 'low');

  await rm(dir, { recursive: true, force: true });
});

test('parseQuantityAndUnit recognizes additional discrete serving descriptors', () => {
  assert.deepEqual(testExports.parseQuantityAndUnit('1 slice (28 g)'), {
    quantity: 1,
    unit: 'slice',
  });
  assert.deepEqual(testExports.parseQuantityAndUnit('2 pieces'), { quantity: 2, unit: 'piece' });
  assert.deepEqual(testExports.parseQuantityAndUnit('1 bar'), { quantity: 1, unit: 'bar' });
  assert.deepEqual(testExports.parseQuantityAndUnit('3 cookies'), { quantity: 3, unit: 'cookie' });
  assert.deepEqual(testExports.parseQuantityAndUnit('1 can drained'), { quantity: 1, unit: 'can' });
  assert.deepEqual(testExports.parseQuantityAndUnit('1 bottle'), { quantity: 1, unit: 'bottle' });
  assert.deepEqual(testExports.parseQuantityAndUnit('1 packet'), { quantity: 1, unit: 'packet' });
  assert.deepEqual(testExports.parseQuantityAndUnit('1 portion (250 ml)'), {
    quantity: 1,
    unit: 'serving',
  });
  assert.deepEqual(testExports.parseQuantityAndUnit('2 servings'), { quantity: 2, unit: 'serving' });
});

test('parseQuantityAndUnit recognizes metric volume descriptors', () => {
  assert.deepEqual(testExports.parseQuantityAndUnit('250 ml'), { quantity: 250, unit: 'ml' });
  assert.deepEqual(testExports.parseQuantityAndUnit('100 mL'), { quantity: 100, unit: 'ml' });
  assert.deepEqual(testExports.parseQuantityAndUnit('1 L'), { quantity: 1, unit: 'l' });
  assert.deepEqual(testExports.parseQuantityAndUnit('0.5 litres'), { quantity: 0.5, unit: 'l' });
});

test('parseQuantityAndUnit keeps weight ounces distinct from fluid ounces', () => {
  assert.deepEqual(testExports.parseQuantityAndUnit('1 oz'), { quantity: 1, unit: 'oz' });
  assert.deepEqual(testExports.parseQuantityAndUnit('2 ounces'), { quantity: 2, unit: 'oz' });
  assert.deepEqual(testExports.parseQuantityAndUnit('8 fl oz'), { quantity: 8, unit: 'fl_oz' });
});

test('parseQuantityAndUnit recognizes size descriptors', () => {
  assert.deepEqual(testExports.parseQuantityAndUnit('1 small apple'), {
    quantity: 1,
    unit: 'small',
  });
  assert.deepEqual(testExports.parseQuantityAndUnit('1 medium banana'), {
    quantity: 1,
    unit: 'medium',
  });
  assert.deepEqual(testExports.parseQuantityAndUnit('2 large eggs'), {
    quantity: 2,
    unit: 'large',
  });
});

test('parseAfcdDirectory extracts serving measures from food details', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'food-seed-afcd-'));

  const detailsWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    detailsWorkbook,
    XLSX.utils.aoa_to_sheet([
      ['AFCD Release 3'],
      ['Food details'],
      ['Survey ID', 'Food', 'Gram amount', 'Measure'],
      ['AUS001', 'Chicken soup', 40, '2 tbsp cooked'],
      ['AUS002', 'Plain tea', '', '1 cup prepared'],
    ]),
    'Food Details'
  );
  XLSX.writeFile(detailsWorkbook, path.join(dir, 'AFCD Release 3 - Food Details.xlsx'));

  const nutrientWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    nutrientWorkbook,
    XLSX.utils.aoa_to_sheet([
      ['AFCD Release 3'],
      ['Nutrient profiles'],
      [
        'Survey ID',
        'Energy with dietary fibre, equated (kJ)',
        'Protein',
        'Carbohydrate',
        'Total fat',
      ],
      ['AUS001', 400, 10, 12, 4],
      ['AUS002', 10, 0, 0, 0],
    ]),
    'Nutrient Profiles'
  );
  XLSX.writeFile(nutrientWorkbook, path.join(dir, 'AFCD Release 3 - Nutrient profiles.xlsx'));

  const [source] = await testExports.parseAfcdDirectory(dir);
  const [withServing, withoutServing] = source.stagingRecords;

  assert.equal(withServing.provider, 'afcd');
  assert.equal(withServing.servingSizeG, 40);
  assert.equal(withServing.servingQuantity, 2);
  assert.equal(withServing.servingUnit, 'tbsp');
  assert.equal(withServing.servingDescription, '2 tbsp cooked');
  assert.deepEqual(withServing.servingWeightsG, { tbsp: 20 });

  assert.equal(withoutServing.servingSizeG, null);
  assert.equal(withoutServing.servingQuantity, null);
  assert.equal(withoutServing.servingUnit, null);
  assert.equal(withoutServing.servingDescription, null);
  assert.deepEqual(withoutServing.servingWeightsG, {});

  await rm(dir, { recursive: true, force: true });
});

test('parseAfcdDirectory selects nutrient profile sheet by expected columns', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'food-seed-afcd-'));

  const detailsSheet = XLSX.utils.aoa_to_sheet([
    ['AFCD Release 3'],
    ['Food details'],
    ['Public Food Key', 'Food Name', 'Food Description', 'Gram amount', 'Measure'],
    ['AUS001', 'Chicken soup', 'Soup with chicken', 40, '2 tbsp cooked'],
  ]);

  const detailsWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(detailsWorkbook, detailsSheet, 'Food Details');
  XLSX.writeFile(detailsWorkbook, path.join(dir, 'AFCD Release 3 - Food Details.xlsx'));

  const nutrientWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(nutrientWorkbook, detailsSheet, 'Food Details');
  XLSX.utils.book_append_sheet(
    nutrientWorkbook,
    XLSX.utils.aoa_to_sheet([
      ['AFCD Release 3'],
      ['Nutrient profiles'],
      [
        'Public Food Key',
        'Energy with dietary fibre, equated (kJ)',
        'Protein',
        'Carbohydrate',
        'Total fat',
      ],
      ['AUS001', 400, 10, 12, 4],
    ]),
    'Nutrient Profiles'
  );
  XLSX.writeFile(nutrientWorkbook, path.join(dir, 'AFCD Release 3 - Nutrient profiles.xlsx'));

  const [source] = await testExports.parseAfcdDirectory(dir);
  const [record] = source.stagingRecords;

  assert.equal(record.providerId, 'AUS001');
  assert.equal(record.caloriesPer100g, 95.6);
  assert.equal(record.proteinPer100g, 10);
  assert.equal(record.carbsPer100g, 12);
  assert.equal(record.fatPer100g, 4);

  await rm(dir, { recursive: true, force: true });
});

test('parseAfcdDirectory allows missing optional serving columns in AFCD details', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'food-seed-afcd-'));

  const detailsWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    detailsWorkbook,
    XLSX.utils.aoa_to_sheet([
      ['AFCD Release 3'],
      ['Food details'],
      [
        'Public Food Key',
        'Classification',
        'Derivation',
        'Food Name',
        'Food Description',
        'Sampling Details',
        'Nitrogen Factor',
        'Fat Factor',
        'Specific Gravity',
        'Analysed Portion',
        'Unanalysed Portion',
      ],
      ['AUS001', '', '', 'Chicken soup', 'Soup with chicken', '', '', '', '', '100%', '0%'],
    ]),
    'Food details'
  );
  XLSX.writeFile(detailsWorkbook, path.join(dir, 'AFCD Release 3 - Food Details.xlsx'));

  const nutrientWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    nutrientWorkbook,
    XLSX.utils.aoa_to_sheet([
      ['AFCD Release 3'],
      ['Nutrient profiles'],
      [
        'Public Food Key',
        'Energy with dietary fibre, equated (kJ)',
        'Protein',
        'Carbohydrate',
        'Total fat',
      ],
      ['AUS001', 400, 10, 12, 4],
    ]),
    'All solids & liquids per 100 g'
  );
  XLSX.writeFile(nutrientWorkbook, path.join(dir, 'AFCD Release 3 - Nutrient profiles.xlsx'));

  const [source] = await testExports.parseAfcdDirectory(dir);
  const [record] = source.stagingRecords;

  assert.equal(record.providerId, 'AUS001');
  assert.equal(record.servingSizeG, null);
  assert.equal(record.servingQuantity, null);
  assert.equal(record.servingUnit, null);
  assert.equal(record.servingDescription, null);
  assert.deepEqual(record.servingWeightsG, {});

  await rm(dir, { recursive: true, force: true });
});

test('parseAfcdDirectory joins AUSNUT food measures and skips density rows', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'food-seed-afcd-'));

  const detailsWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    detailsWorkbook,
    XLSX.utils.aoa_to_sheet([
      ['AFCD Release 3'],
      ['Food details'],
      ['Public Food Key', 'Food Name'],
      ['F000996', 'Beer, high alcohol'],
    ]),
    'Food details'
  );
  XLSX.writeFile(detailsWorkbook, path.join(dir, 'AFCD Release 3 - Food Details.xlsx'));

  const nutrientWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    nutrientWorkbook,
    XLSX.utils.aoa_to_sheet([
      ['AFCD Release 3'],
      ['Nutrient profiles'],
      [
        'Public Food Key',
        'Energy with dietary fibre, equated (kJ)',
        'Protein',
        'Carbohydrate',
        'Total fat',
      ],
      ['F000996', 400, 10, 12, 4],
    ]),
    'All solids & liquids per 100 g'
  );
  XLSX.writeFile(nutrientWorkbook, path.join(dir, 'AFCD Release 3 - Nutrient profiles.xlsx'));

  const measuresWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    measuresWorkbook,
    XLSX.utils.aoa_to_sheet([
      ['AUSNUT 2023 - Food measures'],
      [],
      [
        'Survey ID',
        'Public food key',
        'Food name',
        'Measure ID',
        'Quantity',
        'Descriptor 1',
        'Descriptor 2',
        'Descriptor 3',
        'Descriptor 4',
        'Gram amount',
        'Volume',
      ],
      [29101001, 'F000996', 'Beer, high alcohol', 40297, 1, 'density', '', '', '', 1.009, 1],
      [29101001, 'F000996', 'Beer, high alcohol', 40298, 1, 'can', '', '', '', 332.97, 330],
      [29101001, 'F000996', 'Beer, high alcohol', 40299, 1, 'bottle', '', '', '', 378.38, 375],
    ]),
    'AUSNUT 2023'
  );
  XLSX.writeFile(measuresWorkbook, path.join(dir, 'AUSNUT 2023 - Food measures.xlsx'));

  const [source] = await testExports.parseAfcdDirectory(dir);
  const [record] = source.stagingRecords;

  assert.deepEqual(source.inputFiles.map((file) => path.basename(file)), [
    'AFCD Release 3 - Food Details.xlsx',
    'AFCD Release 3 - Nutrient profiles.xlsx',
    'AUSNUT 2023 - Food measures.xlsx',
  ]);
  assert.equal(record.providerId, 'F000996');
  assert.equal(record.servingSizeG, 332.97);
  assert.equal(record.servingQuantity, 1);
  assert.equal(record.servingUnit, 'can');
  assert.equal(record.servingDescription, '1 can');
  assert.deepEqual(record.servingWeightsG, { can: 332.97, bottle: 378.38 });
  assert.deepEqual(record.servingSizes, [
    {
      grams: 332.97,
      quantity: 1,
      unit: 'can',
      description: '1 can',
      source: 'afcd_measure',
      quality: 'high',
      confidence: 0.95,
    },
    {
      grams: 378.38,
      quantity: 1,
      unit: 'bottle',
      description: '1 bottle',
      source: 'afcd_measure',
      quality: 'high',
      confidence: 0.95,
    },
  ]);

  await rm(dir, { recursive: true, force: true });
});

test('parseAfcdDirectory does not record ambiguous sachet measures as cup weights', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'food-seed-afcd-'));

  const detailsWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    detailsWorkbook,
    XLSX.utils.aoa_to_sheet([
      ['AFCD Release 3'],
      ['Food details'],
      ['Public Food Key', 'Food Name'],
      ['F006143', 'Oats, rolled, uncooked'],
    ]),
    'Food details'
  );
  XLSX.writeFile(detailsWorkbook, path.join(dir, 'AFCD Release 3 - Food Details.xlsx'));

  const nutrientWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    nutrientWorkbook,
    XLSX.utils.aoa_to_sheet([
      ['AFCD Release 3'],
      ['Nutrient profiles'],
      [
        'Public Food Key',
        'Energy with dietary fibre, equated (kJ)',
        'Protein',
        'Carbohydrate',
        'Total fat',
      ],
      ['F006143', 1564, 13.5, 68.7, 5.9],
    ]),
    'All solids & liquids per 100 g'
  );
  XLSX.writeFile(nutrientWorkbook, path.join(dir, 'AFCD Release 3 - Nutrient profiles.xlsx'));

  const measuresWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    measuresWorkbook,
    XLSX.utils.aoa_to_sheet([
      ['AUSNUT 2023 - Food measures'],
      [],
      [
        'Survey ID',
        'Public food key',
        'Food name',
        'Measure ID',
        'Quantity',
        'Descriptor 1',
        'Descriptor 2',
        'Descriptor 3',
        'Descriptor 4',
        'Gram amount',
        'Volume',
      ],
      [12101016, 'F006143', 'Oats, rolled, uncooked', 41256, 1, 'density', 'dry/uncooked', '', '', 0.33, 0],
      [12101016, 'F006143', 'Oats, rolled, uncooked', 41257, 1, 'tablespoon', '', '', '', 6.6, 20],
      [12101016, 'F006143', 'Oats, rolled, uncooked', 41258, 1, 'cup', '', '', '', 82.5, 250],
      [12101016, 'F006143', 'Oats, rolled, uncooked', 41259, 1, 'cup or sachet', 'single serve', '', '', 40, 0],
    ]),
    'AUSNUT 2023'
  );
  XLSX.writeFile(measuresWorkbook, path.join(dir, 'AUSNUT 2023 - Food measures.xlsx'));

  const [source] = await testExports.parseAfcdDirectory(dir);
  const [record] = source.stagingRecords;

  assert.equal(record.providerId, 'F006143');
  assert.equal(record.caloriesPer100g, 373.8);
  assert.equal(record.servingSizeG, 82.5);
  assert.equal(record.servingQuantity, 1);
  assert.equal(record.servingUnit, 'cup');
  assert.equal(record.servingDescription, '1 cup');
  assert.deepEqual(record.servingWeightsG, { tbsp: 6.6, cup: 82.5 });
  assert.equal(record.servingSizes.find((serving) => serving.grams === 40)?.unit, null);

  await rm(dir, { recursive: true, force: true });
});

test('parseOpenFoodFactsDirectory converts kJ-only energy fields', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'food-seed-off-'));
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'products.jsonl'),
    `${JSON.stringify({
      code: '2345678901234',
      product_name: 'Plain Crackers',
      serving_size: '25 g',
      nutriments: {
        'energy-kj_100g': 2000,
        proteins: '8',
        carbs_100g: '70',
        fat: '12',
      },
    })}\n`
  );

  const [source] = await testExports.parseOpenFoodFactsDirectory(dir);
  const record = source.stagingRecords[0];

  assert.equal(record.caloriesPer100g, 478.01);
  assert.equal(record.proteinPer100g, 8);
  assert.equal(record.carbsPer100g, 70);
  assert.equal(record.fatPer100g, 12);
  assert.equal(record.servingSizeG, 25);

  await rm(dir, { recursive: true, force: true });
});

test('parseOpenFoodFactsDirectory filters implausible serving grams', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'food-seed-off-'));
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'products.jsonl'),
    `${JSON.stringify({
      code: '2345678901235',
      product_name: 'Family Cereal',
      serving_quantity: '9999',
      serving_size: '1 bowl (9999 g)',
      nutriments: {
        'energy-kcal_100g': 380,
        proteins_100g: 8,
        carbohydrates_100g: 75,
        fat_100g: 4,
      },
    })}\n`
  );

  const [source] = await testExports.parseOpenFoodFactsDirectory(dir);
  const record = source.stagingRecords[0];

  assert.equal(record.servingSizeG, null);
  assert.deepEqual(record.servingSizes, []);
  assert.deepEqual(record.servingWeightsG, {});

  await rm(dir, { recursive: true, force: true });
});

test('parseOpenFoodFactsDirectory accepts additional Open Food Facts energy fallbacks', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'food-seed-off-'));
  await mkdir(dir, { recursive: true });
  const products = [
    {
      code: '3000000000001',
      product_name: 'Kcal Value Product',
      nutriments: { 'energy-kcal_value': 321 },
      expectedCalories: 321,
    },
    {
      code: '3000000000002',
      product_name: 'Kilojoule Product',
      nutriments: { 'energy-kj': 1000 },
      expectedCalories: 239.01,
    },
    {
      code: '3000000000003',
      product_name: 'Plain Energy Product',
      nutriments: { energy: 1000 },
      expectedCalories: 239.01,
    },
    {
      code: '3000000000004',
      product_name: 'Energy Value Product',
      nutriments: { energy_value: 1000 },
      expectedCalories: 239.01,
    },
    {
      code: '3000000000005',
      product_name: 'Kilojoule Value Product',
      nutriments: { 'energy-kj_value': 1000 },
      expectedCalories: 239.01,
    },
    {
      code: '3000000000006',
      product_name: 'Preferred Normalized Kcal Product',
      nutriments: { 'energy-kcal_100g': 111, 'energy-kcal_value': 999 },
      expectedCalories: 111,
    },
  ];
  await writeFile(
    path.join(dir, 'products.jsonl'),
    products
      .map(({ code, product_name, nutriments }) =>
        JSON.stringify({
          code,
          product_name,
          nutriments: {
            ...nutriments,
            proteins_100g: 5,
            carbohydrates_100g: 10,
            fat_100g: 2,
          },
        })
      )
      .join('\n') + '\n'
  );

  const [source] = await testExports.parseOpenFoodFactsDirectory(dir);
  const caloriesByCode = new Map(
    source.stagingRecords.map((record) => [record.providerId, record.caloriesPer100g])
  );

  assert.equal(source.rejectedRows.length, 0);
  for (const product of products) {
    assert.equal(caloriesByCode.get(product.code), product.expectedCalories);
  }

  await rm(dir, { recursive: true, force: true });
});

test('parseOpenFoodFactsDirectory caps retained rejected row samples', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'food-seed-off-'));
  await mkdir(dir, { recursive: true });
  const products = Array.from({ length: 1005 }, (_, index) =>
    JSON.stringify({
      code: `400000000${String(index).padStart(4, '0')}`,
      product_name: `Rejected Product ${index}`,
      nutriments: {},
    })
  );
  await writeFile(path.join(dir, 'products.jsonl'), `${products.join('\n')}\n`);

  const [source] = await testExports.parseOpenFoodFactsDirectory(dir);

  assert.equal(source.rejectedRowCount, 1005);
  assert.equal(source.rejectedRows.length, 1000);

  await rm(dir, { recursive: true, force: true });
});

test('buildSeedFood uses stable off-prefixed IDs for Open Food Facts', () => {
  const food = testExports.buildSeedFood(
    testExports.createStagingRecord({
      provider: 'openfoodfacts',
      providerId: '1234567890123',
      name: 'Peanut Butter',
      brandName: 'Example Brand',
      countryCode: 'us',
      region: 'global',
      caloriesPer100g: 588,
      proteinPer100g: 25,
      carbsPer100g: 20,
      fatPer100g: 50,
      servingSizeG: null,
      servingQuantity: null,
      servingUnit: null,
      servingDescription: null,
      servingWeightsG: {},
      barcode: '1234567890123',
      imageUrl: 'https://static.openfoodfacts.org/images/products/123/front_en.1.400.jpg',
      license: 'ODbL',
      sourceUpdatedAt: null,
      warnings: [],
    }),
    '2026-06-07T00:00:00.000Z'
  );

  assert.equal(food.id, 'off-1234567890123');
  assert.equal(food.source, 'openfoodfacts');
  assert.equal(food.brandName, 'Example Brand');
  assert.equal(food.countryCode, 'us');
  assert.deepEqual(food.barcodes, ['1234567890123']);
  assert.equal(food.license, 'ODbL');
  assert.equal(food.quality, 'medium');
  assert.equal(food.qualityScore, 64);
});

test('dedupeSeedRecords matches fuzzy name variants and keeps the highest quality record', () => {
  const records = [
    testExports.createStagingRecord({
      provider: 'usda_sr_legacy',
      providerId: 'legacy-1',
      name: 'Peanuts, roasted salted, 16 oz bag',
      brandName: null,
      countryCode: null,
      region: 'us',
      caloriesPer100g: 585,
      proteinPer100g: 24,
      carbsPer100g: 21,
      fatPer100g: 49,
      servingSizeG: null,
      servingQuantity: null,
      servingUnit: null,
      servingDescription: null,
      servingWeightsG: {},
      barcode: null,
      imageUrl: null,
      license: 'public-domain',
      sourceUpdatedAt: null,
      warnings: [],
    }),
    testExports.createStagingRecord({
      provider: 'usda_foundation',
      providerId: 'foundation-1',
      name: 'Salted roasted peanut 16 ounce',
      brandName: null,
      countryCode: null,
      region: 'us',
      caloriesPer100g: 586,
      proteinPer100g: 25,
      carbsPer100g: 20,
      fatPer100g: 50,
      servingSizeG: 28,
      servingQuantity: null,
      servingUnit: null,
      servingDescription: '1 oz',
      servingWeightsG: {},
      barcode: null,
      imageUrl: null,
      license: 'public-domain',
      sourceUpdatedAt: null,
      warnings: [],
    }),
  ];

  const { records: deduped, duplicateGroups } = testExports.dedupeSeedRecords(records);

  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].providerId, 'foundation-1');
  assert.deepEqual(duplicateGroups, [
    {
      normalizedName: 'salted roasted peanut',
      keptId: 'foundation-1',
      droppedIds: ['legacy-1'],
    },
  ]);
});

test('dedupeSeedRecords includes brand and country in fuzzy dedupe criteria', () => {
  const records = [
    createDedupeRecord({
      providerId: 'alpha-us',
      name: 'Crunchy Peanut Butter',
      brandName: 'Example Brand',
      countryCode: 'us',
    }),
    createDedupeRecord({
      providerId: 'other-us',
      name: 'Peanut Butter, Crunchy',
      brandName: 'Other Brand',
      countryCode: 'us',
    }),
    createDedupeRecord({
      providerId: 'alpha-ca',
      name: 'Peanut Butter, Crunchy',
      brandName: 'Example Brand',
      countryCode: 'ca',
    }),
  ];

  const { records: deduped, duplicateGroups } = testExports.dedupeSeedRecords(records);

  assert.equal(deduped.length, 3);
  assert.deepEqual(
    deduped.map((record) => record.providerId).sort(),
    ['alpha-ca', 'alpha-us', 'other-us']
  );
  assert.deepEqual(duplicateGroups, []);
});

test('dedupeSeedRecords keeps same-brand products with different package weights distinct', () => {
  const records = [
    createDedupeRecord({
      providerId: 'jar-16',
      name: 'Peanut Butter 16 oz jar',
      brandName: 'Example Brand',
      countryCode: 'us',
    }),
    createDedupeRecord({
      providerId: 'jar-32',
      name: 'Peanut Butter 32 oz jar',
      brandName: 'Example Brand',
      countryCode: 'us',
    }),
  ];

  const { records: deduped, duplicateGroups } = testExports.dedupeSeedRecords(records);

  assert.equal(deduped.length, 2);
  assert.deepEqual(
    deduped.map((record) => record.providerId).sort(),
    ['jar-16', 'jar-32']
  );
  assert.deepEqual(duplicateGroups, []);
});

test('dedupeSeedRecords uses barcode as a dedupe key', () => {
  const records = [
    createDedupeRecord({
      providerId: 'barcode-low',
      name: 'Crunchy Peanut Butter',
      brandName: 'Example Brand',
      countryCode: 'us',
      barcode: '1234567890123',
    }),
    createDedupeRecord({
      providerId: 'barcode-high',
      name: 'Peanut Butter Crunchy Spread',
      brandName: 'Example Brand Foods',
      countryCode: 'ca',
      barcode: '1234567890123',
      servingSizeG: 30,
      imageUrl: 'https://static.openfoodfacts.org/images/products/123/front_en.1.400.jpg',
    }),
  ];

  const { records: deduped, duplicateGroups } = testExports.dedupeSeedRecords(records);

  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].providerId, 'barcode-high');
  assert.equal(deduped[0].barcode, '1234567890123');
  assert.deepEqual(deduped[0].barcodes, ['1234567890123']);
  assert.deepEqual(duplicateGroups, [
    {
      normalizedName: 'peanut butter crunchy spread',
      keptId: 'barcode-high',
      droppedIds: ['barcode-low'],
    },
  ]);
});

test('parseOpenFoodFactsDirectory tags country brand license and image quality', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'food-seed-off-'));
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'products.jsonl'),
    `${JSON.stringify({
      code: '3456789012345',
      product_name: 'Muesli',
      brands: 'Breakfast Co',
      countries_tags: ['en:united-states', 'en:canada'],
      image_front_url: 'https://static.openfoodfacts.org/images/products/345/front_en.1.400.jpg',
      last_modified_t: '1780876800',
      nutriments: {
        'energy-kcal_100g': 350,
        proteins_100g: 10,
        carbohydrates_100g: 60,
        fat_100g: 8,
      },
    })}\n`
  );

  const [source] = await testExports.parseOpenFoodFactsDirectory(dir);
  const record = source.stagingRecords[0];

  assert.equal(record.brandName, 'Breakfast Co');
  assert.equal(record.countryCode, 'us');
  assert.equal(record.imageUrl, 'https://static.openfoodfacts.org/images/products/345/front_en.1.400.jpg');
  assert.equal(record.license, 'ODbL');
  assert.equal(record.sourceUpdatedAt, '1780876800');
  assert.equal(record.qualityScore, 74);

  await rm(dir, { recursive: true, force: true });
});

test('createStagingRecord computes bounded 0-100 quality scores from completeness and source trust', () => {
  const richRecord = testExports.createStagingRecord({
    provider: 'usda_foundation',
    providerId: 'rich',
    name: 'Tomatoes, raw',
    brandName: 'Example Brand',
    countryCode: 'us',
    region: 'us',
    caloriesPer100g: 18,
    proteinPer100g: 0.9,
    carbsPer100g: 3.9,
    fatPer100g: 0.2,
    servingSizeG: 120,
    servingQuantity: 1,
    servingUnit: 'cup',
    servingDescription: '1 cup',
    servingWeightsG: { cup: 120 },
    barcode: '1234567890123',
    imageUrl: 'https://example.com/tomato.jpg',
    license: 'public-domain',
    sourceUpdatedAt: '4102444800',
    warnings: [],
  });
  const sparseRecord = testExports.createStagingRecord({
    provider: 'openfoodfacts',
    providerId: 'sparse',
    name: 'Tomatoes',
    brandName: null,
    countryCode: 'us',
    region: 'global',
    caloriesPer100g: 18,
    proteinPer100g: null,
    carbsPer100g: null,
    fatPer100g: null,
    servingSizeG: null,
    servingQuantity: null,
    servingUnit: null,
    servingDescription: null,
    servingWeightsG: {},
    barcode: null,
    imageUrl: null,
    license: 'ODbL',
    sourceUpdatedAt: null,
    warnings: [],
  });

  assert.equal(richRecord.qualityScore, 100);
  assert.equal(sparseRecord.qualityScore, 26);
});

test('createStagingRecord clamps out-of-range per-100g nutrients with a diagnostic', () => {
  const record = testExports.createStagingRecord({
    provider: 'usda_foundation',
    providerId: 'invalid-nutrients',
    name: 'Invalid nutrients',
    brandName: null,
    countryCode: null,
    region: 'us',
    caloriesPer100g: 200,
    proteinPer100g: 5,
    carbsPer100g: 7000,
    fatPer100g: 10,
    servingSizeG: null,
    servingQuantity: null,
    servingUnit: null,
    servingDescription: null,
    servingWeightsG: {},
    barcode: null,
    imageUrl: null,
    license: 'public-domain',
    sourceUpdatedAt: null,
    warnings: [],
  });

  assert.equal(record.carbsPer100g, 100);
  assert.deepEqual(record.warnings, ['clamped carbsPer100g: 7000 is outside 0..100']);
});

test('createStagingRecord leaves valid per-100g nutrients unchanged', () => {
  const record = testExports.createStagingRecord({
    provider: 'usda_foundation',
    providerId: 'valid-nutrients',
    name: 'Valid nutrients',
    brandName: null,
    countryCode: null,
    region: 'us',
    caloriesPer100g: 200,
    proteinPer100g: 5,
    carbsPer100g: 30,
    fatPer100g: 10,
    servingSizeG: null,
    servingQuantity: null,
    servingUnit: null,
    servingDescription: null,
    servingWeightsG: {},
    barcode: null,
    imageUrl: null,
    license: 'public-domain',
    sourceUpdatedAt: null,
    warnings: ['source diagnostic'],
  });

  assert.equal(record.caloriesPer100g, 200);
  assert.equal(record.proteinPer100g, 5);
  assert.equal(record.carbsPer100g, 30);
  assert.equal(record.fatPer100g, 10);
  assert.deepEqual(record.warnings, ['source diagnostic']);
});

test('parseOpenFoodFactsDirectory streams accepted records without retaining staging rows', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'food-seed-off-'));
  const streamedRecords: ReturnType<typeof createDedupeRecord>[] = [];
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'products.jsonl'),
    `${JSON.stringify({
      code: '4567890123456',
      product_name: 'Peanut Butter',
      brands: 'Example Brand',
      nutriments: {
        'energy-kcal_100g': 588,
        proteins_100g: 25,
        carbohydrates_100g: 20,
        fat_100g: 50,
      },
    })}\n`
  );

  const [source] = await testExports.parseOpenFoodFactsDirectory(dir, {
    onStagingRecord: (record) => streamedRecords.push(record),
  });

  assert.equal(streamedRecords.length, 1);
  assert.equal(source.stagingRecordCount, 1);
  assert.equal(source.stagingRecords.length, 0);

  await rm(dir, { recursive: true, force: true });
});

test('finalizeDedupeAccumulator releases accumulator groups after finalization', () => {
  const accumulator = testExports.createDedupeAccumulator();
  testExports.addDedupeRecord(
    accumulator,
    createDedupeRecord({
      providerId: 'low',
      name: 'Peanut Butter',
      brandName: 'Example Brand',
      countryCode: 'us',
    })
  );
  testExports.addDedupeRecord(
    accumulator,
    createDedupeRecord({
      providerId: 'high',
      name: 'Peanut Butter',
      brandName: 'Example Brand',
      countryCode: 'us',
      imageUrl: 'https://static.openfoodfacts.org/images/products/high/front_en.1.400.jpg',
    })
  );

  const { records, duplicateGroups } = testExports.finalizeDedupeAccumulator(accumulator);

  assert.equal(records.length, 1);
  assert.equal(records[0].providerId, 'high');
  assert.equal(duplicateGroups.length, 1);
  assert.equal(testExports.dedupeAccumulatorGroupCount(accumulator), 0);
  assert.equal(accumulator.groupsByKey.size, 0);
});

test('addDedupeRecord indexes growing duplicate groups without rebuilding record keys', () => {
  const accumulator = testExports.createDedupeAccumulator();
  const recordCount = 500;

  for (let index = 0; index < recordCount; index += 1) {
    testExports.addDedupeRecord(
      accumulator,
      createDedupeRecord({
        providerId: `duplicate-${index}`,
        name: 'Peanut Butter 16 oz',
        brandName: 'Example Brand',
        countryCode: 'us',
        barcode: `duplicate-${index}`,
      })
    );
  }

  assert.equal(testExports.dedupeAccumulatorGroupCount(accumulator), 1);
  assert.equal(accumulator.groupsByKey.size, recordCount + 1);

  const { records, duplicateGroups } = testExports.finalizeDedupeAccumulator(accumulator);

  assert.equal(records.length, 1);
  assert.equal(duplicateGroups.length, 1);
  assert.equal(duplicateGroups[0].droppedIds.length, recordCount - 1);
});

test('build manifest records empty and large branded counts from existing pipeline totals', async () => {
  const empty = await testExports.buildManifest(
    [],
    { generic: 0, branded: 0 },
    new Map(),
    [],
    testRelease.runAt,
    testRelease
  );
  const representativeLargeCount = 1_000_000;
  const large = await testExports.buildManifest(
    [],
    { generic: 0, branded: representativeLargeCount },
    new Map([['us', { length: representativeLargeCount }]]),
    [],
    testRelease.runAt,
    testRelease
  );

  assert.equal(empty.totals.brandedSeedCount, 0);
  assert.deepEqual(empty.totals.brandedSeedCountsByCountry, {});
  assert.equal(empty.totals.seedCount, 0);
  assert.equal(large.totals.brandedSeedCount, representativeLargeCount);
  assert.deepEqual(large.totals.brandedSeedCountsByCountry, {
    us: representativeLargeCount,
  });
  assert.equal(large.totals.seedCount, representativeLargeCount);
});

test('buildFoodSeedArtifacts splits generic and branded outputs by country', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'food-seed-build-'));
  const usdaDir = path.join(rootDir, 'usda');
  const offDir = path.join(rootDir, 'off');
  const outputDir = path.join(rootDir, 'out');
  await mkdir(usdaDir, { recursive: true });
  await mkdir(offDir, { recursive: true });

  await writeFile(
    path.join(usdaDir, 'food.csv'),
    [
      'fdc_id,data_type,description,publication_date',
      '1000,Foundation,"Tomatoes, raw",2026-04-30',
    ].join('\n')
  );
  await writeFile(
    path.join(usdaDir, 'food_nutrient.csv'),
    [
      'fdc_id,nutrient_id,amount',
      '1000,1008,18',
      '1000,1003,0.9',
      '1000,1005,7000',
      '1000,1004,0.2',
    ].join('\n')
  );
  await writeFile(path.join(usdaDir, 'food_portion.csv'), 'fdc_id,gram_weight\n');
  await writeFile(path.join(usdaDir, 'measure_unit.csv'), 'id,name\n');
  await writeFile(
    path.join(offDir, 'products.jsonl'),
    [
      JSON.stringify({
        code: '4567890123456',
        product_name: 'Peanut Butter',
        brands: 'Example Brand',
        countries_tags: ['en:united-states'],
        serving_quantity: '30',
        serving_size: '2 tbsp (30 g)',
        nutriments: {
          'energy-kcal_100g': 588,
          proteins_100g: 25,
          carbohydrates_100g: 20,
          fat_100g: 50,
        },
      }),
      JSON.stringify({
        code: '5678901234567',
        product_name: 'Mystery Granola',
        brands: 'Unknown Origin Foods',
        nutriments: {
          'energy-kcal_100g': 450,
          proteins_100g: 10,
          carbohydrates_100g: 65,
          fat_100g: 18,
        },
      }),
      JSON.stringify({
        code: '8801115111054',
        product_name: '나 100% 1급A우유 2.3L',
        brands: 'Seoul Milk',
        countries_tags: ['en:south-korea'],
        nutriments: {
          'energy-kcal_100g': 70,
          proteins_100g: 3,
          carbohydrates_100g: 5,
          fat_100g: 4,
        },
      }),
    ].join('\n') + '\n'
  );

  const summary = await testExports.buildFoodSeedArtifacts({
    usdaDir,
    openFoodFactsDir: offDir,
    outputDir,
    release: testRelease,
  });
  const genericFoods = JSON.parse(await readFile(path.join(outputDir, 'foods.seed.json'), 'utf8'));
  const brandedFoods = JSON.parse(
    await readFile(path.join(outputDir, 'foods-us.branded.json'), 'utf8')
  );
  const unknownBrandedFoods = JSON.parse(
    await readFile(path.join(outputDir, 'foods-unknown.branded.json'), 'utf8')
  );
  const koreanBrandedFoods = JSON.parse(
    await readFile(path.join(outputDir, 'foods-kr.branded.json'), 'utf8')
  );
  const manifest = JSON.parse(await readFile(path.join(outputDir, 'foods.manifest.json'), 'utf8'));
  const compressedGeneric = await readFile(path.join(outputDir, 'foods.seed.json.gz'));
  const compressedBranded = await readFile(path.join(outputDir, 'foods-us.branded.json.gz'));
  const compressedKoreanBranded = await readFile(
    path.join(outputDir, 'foods-kr.branded.json.gz')
  );
  const validation = await validateFoodSeedArtifacts(outputDir);

  assert.equal(summary.genericSeedCount, 1);
  assert.equal(summary.brandedSeedCount, 3);
  assert.equal(genericFoods.length, 1);
  assert.equal(genericFoods[0].source, 'usda');
  assert.equal(genericFoods[0].countryCode, null);
  assert.equal(genericFoods[0].license, 'public-domain');
  assert.equal(genericFoods[0].carbsPer100g, 100);
  assert.equal(brandedFoods.length, 1);
  assert.equal(brandedFoods[0].source, 'openfoodfacts');
  assert.equal(brandedFoods[0].brandName, 'Example Brand');
  assert.equal(brandedFoods[0].countryCode, 'us');
  assert.equal(brandedFoods[0].quality, 'medium');
  assert.equal(brandedFoods[0].qualityScore, 80);
  assert.equal(unknownBrandedFoods.length, 1);
  assert.equal(unknownBrandedFoods[0].countryCode, 'unknown');
  assert.equal(koreanBrandedFoods.length, 1);
  assert.equal(koreanBrandedFoods[0].brandName, 'Seoul Milk');
  assert.equal(koreanBrandedFoods[0].countryCode, 'kr');
  assert.equal(
    validation.checks.find(
      (check) => check.asset === 'foods.seed.json' && check.category === 'content'
    )?.status,
    'pass'
  );
  assert.equal(
    validation.checks.find(
      (check) =>
        check.asset === 'foods-unknown.branded.json' && check.category === 'content'
    )?.status,
    'pass'
  );
  assert.equal(
    validation.checks.find(
      (check) => check.asset === 'foods-kr.branded.json' && check.category === 'content'
    )?.status,
    'pass'
  );
  assert.deepEqual(brandedFoods[0].servingSizes, [
    {
      grams: 30,
      quantity: 2,
      unit: 'tbsp',
      description: '2 tbsp (30 g)',
      source: 'off_label',
      quality: 'medium',
      confidence: 0.75,
    },
  ]);
  assert.equal(manifest.stagingSchemaVersion, 2);
  assert.equal(manifest.release.versionId, '1.0.0+20260719T060000Z');
  assert.equal(manifest.release.verified, false);
  assert.equal(manifest.release.compression.codec, 'gzip');
  assert.deepEqual(JSON.parse(gunzipSync(compressedGeneric).toString('utf8')), genericFoods);
  assert.deepEqual(JSON.parse(gunzipSync(compressedBranded).toString('utf8')), brandedFoods);
  assert.deepEqual(
    JSON.parse(gunzipSync(compressedKoreanBranded).toString('utf8')),
    koreanBrandedFoods
  );
  assert.ok(compressedGeneric.byteLength < Buffer.byteLength(JSON.stringify(genericFoods)));
  assert.ok(compressedBranded.byteLength < Buffer.byteLength(JSON.stringify(brandedFoods)));
  assert.equal(manifest.totals.genericSeedCount, 1);
  assert.equal(manifest.totals.brandedSeedCount, 3);
  assert.deepEqual(manifest.totals.brandedSeedCountsByCountry, {
    kr: 1,
    unknown: 1,
    us: 1,
  });

  const emittedFoods = [
    ...genericFoods,
    ...brandedFoods,
    ...koreanBrandedFoods,
    ...unknownBrandedFoods,
  ];
  assert.ok(emittedFoods.every((food) => ['high', 'medium', 'low'].includes(food.quality)));

  const qa = JSON.parse(await readFile(path.join(outputDir, 'foods.qa.json'), 'utf8'));
  assert.deepEqual(qa.counts.quality, { high: 1, medium: 3, low: 0, missing: 0 });

  await rm(rootDir, { recursive: true, force: true });
});

test('buildFoodSeedArtifacts dedupes Open Food Facts rows while streaming', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'food-seed-build-'));
  const usdaDir = path.join(rootDir, 'usda');
  const offDir = path.join(rootDir, 'off');
  const outputDir = path.join(rootDir, 'out');
  await mkdir(usdaDir, { recursive: true });
  await mkdir(offDir, { recursive: true });

  await writeFile(
    path.join(usdaDir, 'food.csv'),
    [
      'fdc_id,data_type,description,publication_date',
      '1000,Foundation,"Tomatoes, raw",2026-04-30',
    ].join('\n')
  );
  await writeFile(
    path.join(usdaDir, 'food_nutrient.csv'),
    [
      'fdc_id,nutrient_id,amount',
      '1000,1008,18',
      '1000,1003,0.9',
      '1000,1005,3.9',
      '1000,1004,0.2',
    ].join('\n')
  );
  await writeFile(path.join(usdaDir, 'food_portion.csv'), 'fdc_id,gram_weight\n');
  await writeFile(path.join(usdaDir, 'measure_unit.csv'), 'id,name\n');
  await writeFile(
    path.join(offDir, 'products.jsonl'),
    [
      JSON.stringify({
        code: '1111111111111',
        product_name: 'Peanut Butter',
        brands: 'Better Brand',
        countries_tags: ['en:united-states'],
        nutriments: {
          'energy-kcal_100g': 588,
          proteins_100g: 25,
          carbohydrates_100g: 20,
          fat_100g: 50,
        },
      }),
      JSON.stringify({
        code: '2222222222222',
        product_name: 'Peanut Butter',
        brands: 'Better Brand',
        countries_tags: ['en:united-states'],
        serving_quantity: '30',
        serving_size: '2 tbsp (30 g)',
        image_front_url: 'https://static.openfoodfacts.org/images/products/222/front_en.1.400.jpg',
        nutriments: {
          'energy-kcal_100g': 100,
          'energy-kj_100g': 2707,
          proteins_100g: 26,
          carbohydrates_100g: 21,
          fat_100g: 51,
        },
      }),
    ].join('\n')
  );

  const summary = await testExports.buildFoodSeedArtifacts({
    usdaDir,
    openFoodFactsDir: offDir,
    outputDir,
    release: testRelease,
  });
  const brandedFoods = JSON.parse(
    await readFile(path.join(outputDir, 'foods-us.branded.json'), 'utf8')
  );
  const qaReport = JSON.parse(await readFile(path.join(outputDir, 'foods.qa.json'), 'utf8'));
  const energyReport = JSON.parse(
    await readFile(path.join(outputDir, 'foods.energy-discrepancies.json'), 'utf8')
  );

  assert.equal(summary.brandedSeedCount, 1);
  assert.equal(summary.duplicateCount, 1);
  assert.equal(brandedFoods.length, 1);
  assert.equal(brandedFoods[0].id, 'off-2222222222222');
  assert.equal(brandedFoods[0].barcode, '2222222222222');
  assert.equal(brandedFoods[0].caloriesPer100g, 646.99);
  assert.deepEqual(brandedFoods[0].barcodes, ['2222222222222', '1111111111111']);
  assert.equal(qaReport.counts.stagingRecords, 3);
  assert.deepEqual(qaReport.duplicateGroups, [
    {
      normalizedName: 'peanut butter',
      keptId: '2222222222222',
      droppedIds: ['1111111111111'],
    },
  ]);
  assert.equal(energyReport.count, 1);
  assert.equal(energyReport.correctedCount, 1);
  assert.equal(energyReport.discrepancies[0].providerId, '2222222222222');
  assert.equal(energyReport.discrepancies[0].resolution, 'replaced_kcal_from_kj');

  await rm(rootDir, { recursive: true, force: true });
});

test('buildFoodSeedArtifacts fuzzy dedupes Open Food Facts rows while streaming', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'food-seed-build-'));
  const usdaDir = path.join(rootDir, 'usda');
  const offDir = path.join(rootDir, 'off');
  const outputDir = path.join(rootDir, 'out');
  await mkdir(usdaDir, { recursive: true });
  await mkdir(offDir, { recursive: true });

  await writeFile(
    path.join(usdaDir, 'food.csv'),
    [
      'fdc_id,data_type,description,publication_date',
      '1000,Foundation,"Tomatoes, raw",2026-04-30',
    ].join('\n')
  );
  await writeFile(
    path.join(usdaDir, 'food_nutrient.csv'),
    [
      'fdc_id,nutrient_id,amount',
      '1000,1008,18',
      '1000,1003,0.9',
      '1000,1005,3.9',
      '1000,1004,0.2',
    ].join('\n')
  );
  await writeFile(path.join(usdaDir, 'food_portion.csv'), 'fdc_id,gram_weight\n');
  await writeFile(path.join(usdaDir, 'measure_unit.csv'), 'id,name\n');
  await writeFile(
    path.join(offDir, 'products.jsonl'),
    [
      JSON.stringify({
        code: '3333333333333',
        product_name: 'Crunchy Peanut Butter - 16 oz jar',
        brands: 'Example Brand',
        countries_tags: ['en:united-states'],
        nutriments: {
          'energy-kcal_100g': 588,
          proteins_100g: 25,
          carbohydrates_100g: 20,
          fat_100g: 50,
        },
      }),
      JSON.stringify({
        code: '4444444444444',
        product_name: 'Peanut Butter, Crunchy, 16 ounce',
        brands: 'Example Brand',
        countries_tags: ['en:united-states'],
        serving_quantity: '30',
        serving_size: '2 tbsp (30 g)',
        image_front_url: 'https://static.openfoodfacts.org/images/products/444/front_en.1.400.jpg',
        nutriments: {
          'energy-kcal_100g': 590,
          proteins_100g: 26,
          carbohydrates_100g: 21,
          fat_100g: 51,
        },
      }),
    ].join('\n')
  );

  const summary = await testExports.buildFoodSeedArtifacts({
    usdaDir,
    openFoodFactsDir: offDir,
    outputDir,
    release: testRelease,
  });
  const brandedFoods = JSON.parse(
    await readFile(path.join(outputDir, 'foods-us.branded.json'), 'utf8')
  );
  const qaReport = JSON.parse(await readFile(path.join(outputDir, 'foods.qa.json'), 'utf8'));

  assert.equal(summary.brandedSeedCount, 1);
  assert.equal(summary.duplicateCount, 1);
  assert.equal(brandedFoods.length, 1);
  assert.equal(brandedFoods[0].id, 'off-4444444444444');
  assert.equal(brandedFoods[0].barcode, '4444444444444');
  assert.deepEqual(brandedFoods[0].barcodes, ['4444444444444', '3333333333333']);
  assert.deepEqual(qaReport.duplicateGroups, [
    {
      normalizedName: 'peanut butter crunchy',
      keptId: '4444444444444',
      droppedIds: ['3333333333333'],
    },
  ]);

  await rm(rootDir, { recursive: true, force: true });
});

test('parseBuildArgs requires Open Food Facts directory instead of AUSNUT', () => {
  const args = testExports.parseBuildArgs([
    '--usda-dir',
    '/tmp/usda',
    '--afcd-dir',
    '/tmp/afcd',
    '--openfoodfacts-dir',
    '/tmp/off',
    '--output-dir',
    '/tmp/out',
  ]);

  assert.equal(args.openFoodFactsDir, '/tmp/off');
});

test('parseBuildArgs rejects missing Open Food Facts directory', () => {
  assert.throws(
    () =>
      testExports.parseBuildArgs([
        '--usda-dir',
        '/tmp/usda',
        '--afcd-dir',
        '/tmp/afcd',
        '--output-dir',
        '/tmp/out',
      ]),
    /--openfoodfacts-dir/
  );
});
