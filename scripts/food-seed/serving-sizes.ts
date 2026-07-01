import type { ServingMeasure, ServingSize } from './types.ts';
import { combineServingMeasures, mergeServingWeights, roundNumber } from './shared.ts';

const MIN_PLAUSIBLE_SERVING_G = 1;
const MAX_PLAUSIBLE_SERVING_G = 2000;

function servingQuality(serving: ServingMeasure, source: ServingSize['source']): ServingSize['quality'] {
  if (serving.quality) return serving.quality;
  if (source === 'off_structured' || source === 'usda_portion' || source === 'afcd_measure') {
    return serving.quantity != null && serving.unit ? 'high' : 'medium';
  }
  return serving.quantity != null && serving.unit ? 'medium' : 'low';
}

function confidenceForQuality(quality: ServingSize['quality']): number {
  if (quality === 'high') return 0.95;
  if (quality === 'medium') return 0.75;
  return 0.5;
}

export function isPlausibleServingGrams(grams: number): boolean {
  return grams >= MIN_PLAUSIBLE_SERVING_G && grams <= MAX_PLAUSIBLE_SERVING_G;
}

export function toServingSize(
  serving: ServingMeasure,
  fallbackSource: ServingSize['source']
): ServingSize | null {
  if (!isPlausibleServingGrams(serving.grams)) return null;

  const source = serving.source ?? fallbackSource;
  const quality = servingQuality(serving, source);
  return {
    grams: roundNumber(serving.grams),
    quantity: serving.quantity != null ? roundNumber(serving.quantity) : null,
    unit: serving.unit,
    description: serving.description,
    source,
    quality,
    confidence: confidenceForQuality(quality),
  };
}

export function servingSizeKey(serving: ServingSize): string {
  return [
    serving.grams,
    serving.quantity ?? '',
    serving.unit ?? '',
    serving.description?.toLowerCase() ?? '',
    serving.source,
  ].join('|');
}

export function buildServingSizes(
  servings: ServingMeasure[],
  fallbackSource: ServingSize['source']
): ServingSize[] {
  const seen = new Set<string>();
  const servingSizes: ServingSize[] = [];
  for (const serving of servings) {
    const servingSize = toServingSize(serving, fallbackSource);
    if (!servingSize) continue;
    const key = servingSizeKey(servingSize);
    if (seen.has(key)) continue;
    seen.add(key);
    servingSizes.push(servingSize);
  }

  return servingSizes.sort((left, right) => {
    if (left.quality !== right.quality) {
      const qualityOrder = { high: 0, medium: 1, low: 2 };
      return qualityOrder[left.quality] - qualityOrder[right.quality];
    }
    return left.grams - right.grams;
  });
}

export function preferredServingMeasure(servings: ServingMeasure[]): ServingMeasure | null {
  return combineServingMeasures(
    servings.filter((serving) => isPlausibleServingGrams(serving.grams))
  );
}

export function servingWeightsFromSizes(servingSizes: ServingSize[]): Record<string, number> {
  return servingSizes.reduce<Record<string, number>>((weights, serving) => {
    if (serving.quantity == null || serving.quantity <= 0 || !serving.unit) return weights;
    return mergeServingWeights(weights, { [serving.unit]: serving.grams / serving.quantity });
  }, {});
}
