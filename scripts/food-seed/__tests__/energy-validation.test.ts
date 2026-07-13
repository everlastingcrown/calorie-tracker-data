import assert from 'node:assert/strict';
import test from 'node:test';
import { validateEnergyPair } from '../energy-validation.ts';

const baseInput = {
  provider: 'openfoodfacts',
  providerId: '123',
  name: 'Test food',
  proteinPer100g: 10,
  carbsPer100g: 20,
  fatPer100g: 10,
};

test('validateEnergyPair accepts equivalent kJ and kcal values', () => {
  const result = validateEnergyPair({
    ...baseInput,
    kcalPer100g: 210,
    kjPer100g: 879,
  });

  assert.equal(result.caloriesPer100g, 210);
  assert.equal(result.discrepancy, null);
});

test('validateEnergyPair replaces kcal when kJ alone agrees with the macro estimate', () => {
  const result = validateEnergyPair({
    ...baseInput,
    kcalPer100g: 50,
    kjPer100g: 879,
  });

  assert.equal(result.caloriesPer100g, 210.09);
  assert.equal(result.discrepancy?.resolution, 'replaced_kcal_from_kj');
  assert.equal(result.discrepancy?.estimatedKjFromMacrosPer100g, 878.64);
});

test('validateEnergyPair keeps kcal when kcal alone agrees with the macro estimate', () => {
  const result = validateEnergyPair({
    ...baseInput,
    kcalPer100g: 210,
    kjPer100g: 200,
  });

  assert.equal(result.caloriesPer100g, 210);
  assert.equal(result.discrepancy?.resolution, 'kept_kcal');
});

test('validateEnergyPair reports but does not clean an ambiguous discrepancy', () => {
  const result = validateEnergyPair({
    ...baseInput,
    kcalPer100g: 100,
    kjPer100g: 2000,
  });

  assert.equal(result.caloriesPer100g, 100);
  assert.equal(result.discrepancy?.resolution, 'unresolved');
});
