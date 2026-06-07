import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { testExports } from '../pipeline.ts';

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

test('buildSeedFood uses stable off-prefixed IDs for Open Food Facts', () => {
  const food = testExports.buildSeedFood(
    testExports.createStagingRecord({
      provider: 'openfoodfacts',
      providerId: '1234567890123',
      name: 'Peanut Butter',
      brandName: 'Example Brand',
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
      sourceUpdatedAt: null,
      warnings: [],
    }),
    '2026-06-07T00:00:00.000Z'
  );

  assert.equal(food.id, 'off-1234567890123');
  assert.equal(food.source, 'openfoodfacts');
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
