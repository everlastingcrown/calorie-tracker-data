import type { FoodQuality, SeedStagingRecord } from './types.ts';

function hasCompleteCoreNutrition(record: SeedStagingRecord): boolean {
  return (
    record.caloriesPer100g != null &&
    record.proteinPer100g != null &&
    record.carbsPer100g != null &&
    record.fatPer100g != null
  );
}

/**
 * Assigns the app-facing quality level using only stable source fields.
 * The numeric quality score remains available for dedupe ranking, but is not
 * used here because its recency component changes as source records age.
 */
export function assignFoodQuality(record: SeedStagingRecord): FoodQuality {
  const hasCompleteNutrition = hasCompleteCoreNutrition(record);

  if (record.provider === 'usda_foundation' || record.provider === 'afcd') {
    return hasCompleteNutrition ? 'high' : 'medium';
  }

  if (record.provider === 'usda_sr_legacy') {
    return hasCompleteNutrition ? 'medium' : 'low';
  }

  const hasStableProductIdentity = record.brandName != null && record.barcode != null;
  return hasCompleteNutrition && hasStableProductIdentity ? 'medium' : 'low';
}
