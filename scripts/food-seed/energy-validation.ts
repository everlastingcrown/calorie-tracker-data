import { roundNumber } from './shared.ts';
import type { EnergyDiscrepancy } from './types.ts';

const KJ_PER_KCAL = 4.184;
const ENERGY_PAIR_RELATIVE_TOLERANCE = 0.05;
const ENERGY_PAIR_ABSOLUTE_TOLERANCE_KJ = 20;
const MACRO_RELATIVE_TOLERANCE = 0.2;
const MACRO_ABSOLUTE_TOLERANCE_KJ = 80;

interface ValidateEnergyInput {
  provider: string;
  providerId: string;
  name: string;
  kcalPer100g: number | null;
  kjPer100g: number | null;
  proteinPer100g: number | null;
  carbsPer100g: number | null;
  fatPer100g: number | null;
}

export interface EnergyValidationResult {
  caloriesPer100g: number | null;
  discrepancy: EnergyDiscrepancy | null;
}

function withinTolerance(
  actual: number,
  expected: number,
  relativeTolerance: number,
  absoluteTolerance: number
): boolean {
  return Math.abs(actual - expected) <= Math.max(absoluteTolerance, expected * relativeTolerance);
}

function estimateKjFromMacros(input: ValidateEnergyInput): number | null {
  const macros = [input.proteinPer100g, input.carbsPer100g, input.fatPer100g];
  if (macros.some((value) => value == null || value < 0)) return null;

  const [protein, carbs, fat] = macros as number[];
  return roundNumber((protein * 4 + carbs * 4 + fat * 9) * KJ_PER_KCAL);
}

export function validateEnergyPair(input: ValidateEnergyInput): EnergyValidationResult {
  const { kcalPer100g, kjPer100g } = input;
  const fallbackCalories =
    kcalPer100g ?? (kjPer100g != null ? roundNumber(kjPer100g / KJ_PER_KCAL) : null);
  if (kcalPer100g == null || kjPer100g == null || kcalPer100g < 0 || kjPer100g < 0) {
    return { caloriesPer100g: fallbackCalories, discrepancy: null };
  }

  const kjFromKcal = roundNumber(kcalPer100g * KJ_PER_KCAL);
  if (
    withinTolerance(
      kjPer100g,
      kjFromKcal,
      ENERGY_PAIR_RELATIVE_TOLERANCE,
      ENERGY_PAIR_ABSOLUTE_TOLERANCE_KJ
    )
  ) {
    return { caloriesPer100g: kcalPer100g, discrepancy: null };
  }

  const estimatedKjFromMacros = estimateKjFromMacros(input);
  const kcalMatchesEstimate =
    estimatedKjFromMacros != null &&
    withinTolerance(
      kjFromKcal,
      estimatedKjFromMacros,
      MACRO_RELATIVE_TOLERANCE,
      MACRO_ABSOLUTE_TOLERANCE_KJ
    );
  const kjMatchesEstimate =
    estimatedKjFromMacros != null &&
    withinTolerance(
      kjPer100g,
      estimatedKjFromMacros,
      MACRO_RELATIVE_TOLERANCE,
      MACRO_ABSOLUTE_TOLERANCE_KJ
    );

  const resolution =
    kjMatchesEstimate && !kcalMatchesEstimate
      ? 'replaced_kcal_from_kj'
      : kcalMatchesEstimate && !kjMatchesEstimate
        ? 'kept_kcal'
        : 'unresolved';
  const cleanedCaloriesPer100g =
    resolution === 'replaced_kcal_from_kj'
      ? roundNumber(kjPer100g / KJ_PER_KCAL)
      : kcalPer100g;

  return {
    caloriesPer100g: cleanedCaloriesPer100g,
    discrepancy: {
      provider: input.provider,
      providerId: input.providerId,
      name: input.name,
      kcalPer100g,
      kjPer100g,
      kjFromKcalPer100g: kjFromKcal,
      estimatedKjFromMacrosPer100g: estimatedKjFromMacros,
      resolution,
      cleanedCaloriesPer100g,
    },
  };
}
