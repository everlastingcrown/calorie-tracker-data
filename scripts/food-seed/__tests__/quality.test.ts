import assert from 'node:assert/strict';
import test from 'node:test';
import { assignFoodQuality } from '../quality.ts';
import { createStagingRecord } from '../shared.ts';
import type { Provider } from '../types.ts';

function record(
  provider: Provider,
  overrides: Partial<Parameters<typeof createStagingRecord>[0]> = {}
) {
  return createStagingRecord({
    provider,
    providerId: 'food-1',
    name: 'Test Food',
    brandName: provider === 'openfoodfacts' ? 'Test Brand' : null,
    countryCode: null,
    region: provider === 'openfoodfacts' ? 'global' : provider === 'afcd' ? 'au' : 'us',
    caloriesPer100g: 100,
    proteinPer100g: 5,
    carbsPer100g: 12,
    fatPer100g: 3,
    servingSizeG: null,
    servingQuantity: null,
    servingUnit: null,
    servingDescription: null,
    servingWeightsG: {},
    barcode: provider === 'openfoodfacts' ? '1234567890123' : null,
    imageUrl: null,
    license: 'test',
    sourceUpdatedAt: null,
    warnings: [],
    ...overrides,
  });
}

test('assignFoodQuality applies the documented source and completeness rule', () => {
  assert.equal(assignFoodQuality(record('usda_foundation')), 'high');
  assert.equal(assignFoodQuality(record('afcd')), 'high');
  assert.equal(assignFoodQuality(record('usda_sr_legacy')), 'medium');
  assert.equal(assignFoodQuality(record('openfoodfacts')), 'medium');
  assert.equal(
    assignFoodQuality(record('usda_foundation', { proteinPer100g: null })),
    'medium'
  );
  assert.equal(assignFoodQuality(record('usda_sr_legacy', { fatPer100g: null })), 'low');
  assert.equal(assignFoodQuality(record('openfoodfacts', { barcode: null })), 'low');
});

test('assignFoodQuality is deterministic for identical input', () => {
  const input = record('openfoodfacts', { sourceUpdatedAt: '2024-01-01' });

  assert.equal(assignFoodQuality(input), assignFoodQuality(input));
});
