import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as XLSXModule from 'xlsx';
import { testExports } from '../pipeline.ts';

type XlsxModule = typeof import('xlsx');
const XLSX = ((XLSXModule as XlsxModule & { default?: XlsxModule }).default ??
  XLSXModule) as XlsxModule;

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
  assert.equal(record.qualityScore, 9);

  await rm(dir, { recursive: true, force: true });
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
      '1000,1005,3.9',
      '1000,1004,0.2',
    ].join('\n')
  );
  await writeFile(path.join(usdaDir, 'food_portion.csv'), 'fdc_id,gram_weight\n');
  await writeFile(path.join(usdaDir, 'measure_unit.csv'), 'id,name\n');
  await writeFile(
    path.join(offDir, 'products.jsonl'),
    `${JSON.stringify({
      code: '4567890123456',
      product_name: 'Peanut Butter',
      brands: 'Example Brand',
      countries_tags: ['en:united-states'],
      nutriments: {
        'energy-kcal_100g': 588,
        proteins_100g: 25,
        carbohydrates_100g: 20,
        fat_100g: 50,
      },
    })}\n`
  );

  const summary = await testExports.buildFoodSeedArtifacts({
    usdaDir,
    openFoodFactsDir: offDir,
    outputDir,
  });
  const genericFoods = JSON.parse(await readFile(path.join(outputDir, 'foods.seed.json'), 'utf8'));
  const brandedFoods = JSON.parse(
    await readFile(path.join(outputDir, 'foods-us.branded.json'), 'utf8')
  );
  const manifest = JSON.parse(await readFile(path.join(outputDir, 'foods.manifest.json'), 'utf8'));

  assert.equal(summary.genericSeedCount, 1);
  assert.equal(summary.brandedSeedCount, 1);
  assert.equal(genericFoods.length, 1);
  assert.equal(genericFoods[0].source, 'usda');
  assert.equal(genericFoods[0].countryCode, null);
  assert.equal(genericFoods[0].license, 'public-domain');
  assert.equal(brandedFoods.length, 1);
  assert.equal(brandedFoods[0].source, 'openfoodfacts');
  assert.equal(brandedFoods[0].brandName, 'Example Brand');
  assert.equal(brandedFoods[0].countryCode, 'us');
  assert.equal(manifest.stagingSchemaVersion, 2);
  assert.equal(manifest.totals.genericSeedCount, 1);
  assert.equal(manifest.totals.brandedSeedCount, 1);

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
  });
  const brandedFoods = JSON.parse(
    await readFile(path.join(outputDir, 'foods-us.branded.json'), 'utf8')
  );
  const qaReport = JSON.parse(await readFile(path.join(outputDir, 'foods.qa.json'), 'utf8'));

  assert.equal(summary.brandedSeedCount, 1);
  assert.equal(summary.duplicateCount, 1);
  assert.equal(brandedFoods.length, 1);
  assert.equal(brandedFoods[0].id, 'off-2222222222222');
  assert.equal(brandedFoods[0].barcode, '2222222222222');
  assert.deepEqual(brandedFoods[0].barcodes, ['2222222222222', '1111111111111']);
  assert.equal(qaReport.counts.stagingRecords, 3);
  assert.deepEqual(qaReport.duplicateGroups, [
    {
      normalizedName: 'peanut butter',
      keptId: '2222222222222',
      droppedIds: ['1111111111111'],
    },
  ]);

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
