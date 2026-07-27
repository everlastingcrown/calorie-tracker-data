import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { createGunzip } from 'node:zlib';
import * as XLSXModule from 'xlsx';
import { streamCsv } from './csv.ts';
import type {
  OpenFoodFactsParseOptions,
  ParsedSource,
  Provider,
  SeedStagingRecord,
  ServingMeasure,
} from './types.ts';
import {
  createServingMeasure,
  createStagingRecord,
  normalizeDisplayName,
  normalizeServingUnit,
  parseMixedNumber,
  parseNumber,
  parseQuantityAndUnit,
  roundNumber,
} from './shared.ts';
import {
  buildServingSizes,
  preferredServingMeasure,
  servingWeightsFromSizes,
} from './serving-sizes.ts';
import { validateEnergyPair } from './energy-validation.ts';

const USDA_NUTRIENTS = {
  calories: 1008,
  protein: 1003,
  carbs: 1005,
  fat: 1004,
} as const;

const FSANZ_HEADER_MATCHERS = {
  foodId: [
    /^survey[_\s-]*id$/i,
    /^food[_\s-]*id$/i,
    /^food[_\s-]*code$/i,
    /^survey[_\s-]*food[_\s-]*id$/i,
    /^public[_\s-]*food[_\s-]*key$/i,
  ],
  publicFoodKey: [/^public[_\s-]*food[_\s-]*key$/i],
  foodName: [/^food$/i, /^food[_\s-]*name$/i, /^food[_\s-]*description$/i],
  energyKj: [/^energy.*dietary fibre.*kj/i, /^energy.*kj/i, /^kj$/i],
  protein: [/^protein/i],
  carbs: [/^carbohydrate/i, /^available carbohydrate/i],
  fat: [/^fat[, ]*total/i, /^total fat/i],
  gramWeight: [/^gram[_\s-]*amount$/i, /^gram[_\s-]*weight$/i, /^weight.*g/i],
  measureDescription: [/^measure/i, /^portion/i, /^descriptor/i, /^quantity$/i, /^description$/i],
  quantity: [/^quantity$/i],
  descriptor1: [/^descriptor\s*1$/i],
  descriptor2: [/^descriptor\s*2$/i],
  descriptor3: [/^descriptor\s*3$/i],
  descriptor4: [/^descriptor\s*4$/i],
} as const;

const OFF_COUNTRY_CODES_BY_TAG: Record<string, string> = {
  australia: 'au',
  austria: 'at',
  belgium: 'be',
  brazil: 'br',
  canada: 'ca',
  denmark: 'dk',
  france: 'fr',
  germany: 'de',
  hongkong: 'hk',
  'hong-kong': 'hk',
  india: 'in',
  ireland: 'ie',
  italy: 'it',
  japan: 'jp',
  mexico: 'mx',
  netherlands: 'nl',
  'new-zealand': 'nz',
  spain: 'es',
  sweden: 'se',
  switzerland: 'ch',
  'united-kingdom': 'gb',
  'united-states': 'us',
  'united-states-of-america': 'us',
};

const MAX_OPENFOODFACTS_QA_REJECTED_ROWS = 1000;

type XlsxModule = typeof import('xlsx');
const XLSX = ((XLSXModule as XlsxModule & { default?: XlsxModule }).default ??
  XLSXModule) as XlsxModule;

export function findHeaderKey(row: Record<string, unknown>, matchers: readonly RegExp[]): string {
  const keys = Object.keys(row);
  const matched = keys.find((key) => {
    const normalized = key.trim().toLowerCase().replace(/\s+/g, ' ');
    return matchers.some((matcher) => matcher.test(normalized));
  });
  if (!matched) {
    throw new Error(`Could not find expected column. Available columns: ${keys.join(', ')}`);
  }
  return matched;
}

export function chooseBestServing(servings: ServingMeasure[]): ServingMeasure | null {
  return preferredServingMeasure(servings);
}

export function shouldRejectRecord(record: SeedStagingRecord): string | null {
  if (record.caloriesPer100g == null) {
    return 'missing calories';
  }
  if (record.proteinPer100g == null && record.carbsPer100g == null && record.fatPer100g == null) {
    return 'missing all macros';
  }
  return null;
}

export function normalizeUsdaProvider(dataType: string): Provider | null {
  const value = dataType.trim().toLowerCase().replace(/\s+/g, ' ');
  if (value === 'foundation' || value === 'foundation_food') return 'usda_foundation';
  if (value === 'sr legacy' || value === 'sr_legacy') return 'usda_sr_legacy';
  return null;
}

export async function parseUsdaDirectory(usdaDir: string): Promise<ParsedSource[]> {
  const foodPath = path.join(usdaDir, 'food.csv');
  const nutrientPath = path.join(usdaDir, 'food_nutrient.csv');
  const portionPath = path.join(usdaDir, 'food_portion.csv');
  const measureUnitPath = path.join(usdaDir, 'measure_unit.csv');

  const nutrientsByFood = new Map<
    string,
    {
      calories: number | null;
      protein: number | null;
      carbs: number | null;
      fat: number | null;
    }
  >();

  for await (const row of streamCsv(nutrientPath)) {
    const fdcId = row.fdc_id;
    const nutrientId = parseNumber(row.nutrient_id);
    const amount = parseNumber(row.amount);
    if (!fdcId || nutrientId == null || amount == null) continue;

    const existing = nutrientsByFood.get(fdcId) ?? {
      calories: null,
      protein: null,
      carbs: null,
      fat: null,
    };
    if (nutrientId === USDA_NUTRIENTS.calories) existing.calories = amount;
    if (nutrientId === USDA_NUTRIENTS.protein) existing.protein = amount;
    if (nutrientId === USDA_NUTRIENTS.carbs) existing.carbs = amount;
    if (nutrientId === USDA_NUTRIENTS.fat) existing.fat = amount;
    nutrientsByFood.set(fdcId, existing);
  }

  const measureUnitById = new Map<string, string>();
  let hasMeasureUnitFile = true;
  try {
    for await (const row of streamCsv(measureUnitPath)) {
      if (row.id && row.name) measureUnitById.set(row.id, row.name);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    hasMeasureUnitFile = false;
  }
  const usdaInputFiles = hasMeasureUnitFile
    ? [foodPath, nutrientPath, portionPath, measureUnitPath]
    : [foodPath, nutrientPath, portionPath];

  const servingsByFood = new Map<string, ServingMeasure[]>();
  for await (const row of streamCsv(portionPath)) {
    const fdcId = row.fdc_id;
    const grams = parseNumber(row.gram_weight);
    if (!fdcId || grams == null || grams <= 0) continue;

    const amount = parseMixedNumber(row.amount);
    const measureUnitName = row.measure_unit_id ? measureUnitById.get(row.measure_unit_id) : null;
    const description = [row.amount, measureUnitName, row.portion_description || row.modifier]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    const parsedMeasure =
      (amount != null && normalizeServingUnit(measureUnitName)
        ? { quantity: amount, unit: normalizeServingUnit(measureUnitName) as string }
        : null) ??
      parseQuantityAndUnit(row.portion_description) ??
      parseQuantityAndUnit(row.modifier) ??
      parseQuantityAndUnit(description);

    const serving = createServingMeasure({
      grams,
      quantity: parsedMeasure?.quantity ?? null,
      unit: parsedMeasure?.unit ?? null,
      description: description || null,
      source: 'usda_portion',
    });
    if (!serving) continue;

    const list = servingsByFood.get(fdcId) ?? [];
    list.push(serving);
    servingsByFood.set(fdcId, list);
  }

  const foundation: ParsedSource = {
    sourceId: 'usda-foundation',
    provider: 'usda',
    releaseDate: null,
    license: 'public-domain',
    inputFiles: usdaInputFiles,
    stagingRecords: [],
    rejectedRows: [],
  };
  const legacy: ParsedSource = {
    sourceId: 'usda-sr-legacy',
    provider: 'usda',
    releaseDate: null,
    license: 'public-domain',
    inputFiles: usdaInputFiles,
    stagingRecords: [],
    rejectedRows: [],
  };

  for await (const row of streamCsv(foodPath)) {
    const provider = normalizeUsdaProvider(row.data_type);
    if (!provider) continue;

    const providerId = row.fdc_id;
    if (!providerId) continue;

    const nutrients = nutrientsByFood.get(providerId) ?? {
      calories: null,
      protein: null,
      carbs: null,
      fat: null,
    };
    const servingMeasures = servingsByFood.get(providerId) ?? [];
    const serving = chooseBestServing(servingMeasures);
    const servingSizes = buildServingSizes(servingMeasures, 'usda_portion');

    const record = createStagingRecord({
      provider,
      providerId,
      name: normalizeDisplayName(row.description ?? ''),
      brandName: null,
      countryCode: null,
      region: 'us',
      caloriesPer100g: nutrients.calories != null ? roundNumber(nutrients.calories) : null,
      proteinPer100g: nutrients.protein != null ? roundNumber(nutrients.protein) : null,
      carbsPer100g: nutrients.carbs != null ? roundNumber(nutrients.carbs) : null,
      fatPer100g: nutrients.fat != null ? roundNumber(nutrients.fat) : null,
      servingSizeG: serving?.grams ?? null,
      servingQuantity: serving?.quantity ?? null,
      servingUnit: serving?.unit ?? null,
      servingDescription: serving?.description ?? null,
      servingWeightsG: servingWeightsFromSizes(servingSizes),
      servingSizes,
      barcode: null,
      imageUrl: null,
      license: 'public-domain',
      sourceUpdatedAt: row.publication_date || null,
      warnings: [],
    });

    const rejectionReason = shouldRejectRecord(record);
    if (rejectionReason) {
      const rejected = {
        provider,
        providerId,
        reason: rejectionReason,
        name: record.name,
      };
      if (provider === 'usda_foundation') {
        foundation.rejectedRows.push(rejected);
      } else {
        legacy.rejectedRows.push(rejected);
      }
      continue;
    }

    if (provider === 'usda_foundation') {
      foundation.stagingRecords.push(record);
      foundation.releaseDate = foundation.releaseDate ?? row.publication_date ?? null;
    } else {
      legacy.stagingRecords.push(record);
      legacy.releaseDate = legacy.releaseDate ?? row.publication_date ?? null;
    }
  }

  return [foundation, legacy];
}

export function valueForHeader<T extends Record<string, unknown>>(
  row: T,
  matchers: readonly RegExp[]
): string | number | undefined {
  const key = findHeaderKey(row, matchers);
  const value = row[key];
  if (typeof value === 'number' || typeof value === 'string') return value;
  return undefined;
}

export function optionalValueForHeader<T extends Record<string, unknown>>(
  row: T,
  matchers: readonly RegExp[]
): string | number | undefined {
  const keys = Object.keys(row);
  const key = keys.find((candidate) => {
    const normalized = candidate.trim().toLowerCase().replace(/\s+/g, ' ');
    return matchers.some((matcher) => matcher.test(normalized));
  });
  if (!key) return undefined;
  const value = row[key];
  if (typeof value === 'number' || typeof value === 'string') return value;
  return undefined;
}

export function listWorkbookFiles(dirPath: string): Promise<string[]> {
  return fs.readdir(dirPath).then((entries) =>
    entries
      .filter((entry) => /\.(xlsx|xls)$/i.test(entry))
      .map((entry) => path.join(dirPath, entry))
      .sort()
  );
}

export function findWorkbook(files: string[], matchers: readonly RegExp[], description: string): string {
  const matched = files.find((filePath) =>
    matchers.some((matcher) => matcher.test(path.basename(filePath).toLowerCase()))
  );
  if (!matched) {
    throw new Error(`Could not find ${description} workbook in ${files.join(', ')}`);
  }
  return matched;
}

export function findOptionalWorkbook(files: string[], matchers: readonly RegExp[]): string | null {
  return (
    files.find((filePath) =>
      matchers.some((matcher) => matcher.test(path.basename(filePath).toLowerCase()))
    ) ?? null
  );
}

interface WorkbookRowsOptions {
  sheetNameMatchers?: readonly RegExp[];
  requiredHeaders?: readonly (readonly RegExp[])[];
  description?: string;
}

export function rowHasHeader(row: Record<string, unknown>, matchers: readonly RegExp[]): boolean {
  return Object.keys(row).some((key) => {
    const normalized = key.trim().toLowerCase().replace(/\s+/g, ' ');
    return matchers.some((matcher) => matcher.test(normalized));
  });
}

export function rowHasRequiredHeaders(
  row: Record<string, unknown>,
  requiredHeaders: readonly (readonly RegExp[])[]
): boolean {
  return requiredHeaders.every((matchers) => rowHasHeader(row, matchers));
}

export function readWorkbookRows(
  workbookPath: string,
  options: WorkbookRowsOptions = {}
): Record<string, unknown>[] {
  const workbook = XLSX.readFile(workbookPath, { cellDates: false });
  const nonContentsSheetNames = workbook.SheetNames.filter((name) => !/contents/i.test(name));
  const sheetNames = nonContentsSheetNames.length > 0 ? nonContentsSheetNames : workbook.SheetNames;
  const preferredSheetNames = options.sheetNameMatchers
    ? [
        ...sheetNames.filter((name) =>
          options.sheetNameMatchers?.some((matcher) => matcher.test(name.toLowerCase()))
        ),
        ...sheetNames.filter(
          (name) =>
            !options.sheetNameMatchers?.some((matcher) => matcher.test(name.toLowerCase()))
        ),
      ]
    : sheetNames;

  for (const sheetName of preferredSheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      range: 2,
      defval: '',
      raw: true,
    });
    if (
      !options.requiredHeaders ||
      rows.some((row) => rowHasRequiredHeaders(row, options.requiredHeaders ?? []))
    ) {
      return rows;
    }
  }

  const description = options.description ?? 'workbook';
  throw new Error(
    `Could not find ${description} sheet with expected columns in ${path.basename(
      workbookPath
    )}. Available sheets: ${workbook.SheetNames.join(', ')}`
  );
}

export function parseAfcdServingFromRow(row: Record<string, unknown>): ServingMeasure | null {
  const gramWeight = parseNumber(optionalValueForHeader(row, FSANZ_HEADER_MATCHERS.gramWeight));
  const quantity = parseMixedNumber(
    String(optionalValueForHeader(row, FSANZ_HEADER_MATCHERS.quantity) ?? '')
  );
  const primaryDescriptor =
    optionalValueForHeader(row, FSANZ_HEADER_MATCHERS.descriptor1) ??
    optionalValueForHeader(row, FSANZ_HEADER_MATCHERS.measureDescription);
  const descriptors = [
    primaryDescriptor,
    optionalValueForHeader(row, FSANZ_HEADER_MATCHERS.descriptor2),
    optionalValueForHeader(row, FSANZ_HEADER_MATCHERS.descriptor3),
    optionalValueForHeader(row, FSANZ_HEADER_MATCHERS.descriptor4),
  ]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
  const description = [quantity, ...descriptors]
    .filter((value) => value != null && String(value).trim() !== '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (descriptors.some((descriptor) => /^density$/i.test(descriptor))) return null;

  const hasAmbiguousUnit = descriptors.some((descriptor) => /\bor\b/i.test(descriptor));
  const parsedMeasure = hasAmbiguousUnit ? null : parseQuantityAndUnit(description);
  return createServingMeasure({
    grams: gramWeight,
    quantity: parsedMeasure?.quantity ?? quantity,
    unit: hasAmbiguousUnit ? null : parsedMeasure?.unit ?? normalizeServingUnit(description),
    description: description || null,
    source: 'afcd_measure',
  });
}

export function parseAfcdServingsByFood(measureRows: Record<string, unknown>[]): Map<string, ServingMeasure[]> {
  const servingsByFood = new Map<string, ServingMeasure[]>();

  for (const row of measureRows) {
    const providerId = String(
      optionalValueForHeader(row, FSANZ_HEADER_MATCHERS.publicFoodKey) ??
        valueForHeader(row, FSANZ_HEADER_MATCHERS.foodId) ??
        ''
    ).trim();
    if (!providerId) continue;

    const serving = parseAfcdServingFromRow(row);
    if (!serving) continue;

    const servings = servingsByFood.get(providerId) ?? [];
    servings.push(serving);
    servingsByFood.set(providerId, servings);
  }

  return servingsByFood;
}

export async function parseAfcdDirectory(afcdDir: string): Promise<ParsedSource[]> {
  const files = await listWorkbookFiles(afcdDir);
  const detailsPath = findWorkbook(files, [/food details/i], 'AFCD food details');
  const nutrientsPath = findWorkbook(
    files,
    [/nutrient profiles/i, /nutrient file/i],
    'AFCD nutrient profiles'
  );
  const measuresPath = findOptionalWorkbook(files, [/food measures/i]);

  const detailsRows = readWorkbookRows(detailsPath, {
    sheetNameMatchers: [/food details/i],
    requiredHeaders: [FSANZ_HEADER_MATCHERS.foodId, FSANZ_HEADER_MATCHERS.foodName],
    description: 'AFCD food details',
  });
  const nutrientRows = readWorkbookRows(nutrientsPath, {
    sheetNameMatchers: [/nutrient profiles/i, /nutrient file/i],
    requiredHeaders: [
      FSANZ_HEADER_MATCHERS.foodId,
      FSANZ_HEADER_MATCHERS.energyKj,
      FSANZ_HEADER_MATCHERS.protein,
      FSANZ_HEADER_MATCHERS.carbs,
      FSANZ_HEADER_MATCHERS.fat,
    ],
    description: 'AFCD nutrient profiles',
  });
  const measureRows = measuresPath
    ? readWorkbookRows(measuresPath, {
        sheetNameMatchers: [/ausnut/i, /food measures/i],
        requiredHeaders: [
          FSANZ_HEADER_MATCHERS.foodId,
          FSANZ_HEADER_MATCHERS.gramWeight,
          FSANZ_HEADER_MATCHERS.measureDescription,
        ],
        description: 'AUSNUT food measures',
      })
    : [];
  const servingsByFood = parseAfcdServingsByFood(measureRows);

  const nutrientsByFood = new Map<
    string,
    { calories: number | null; protein: number | null; carbs: number | null; fat: number | null }
  >();
  for (const row of nutrientRows) {
    const providerId = String(valueForHeader(row, FSANZ_HEADER_MATCHERS.foodId) ?? '').trim();
    if (!providerId) continue;
    const caloriesKj = parseNumber(valueForHeader(row, FSANZ_HEADER_MATCHERS.energyKj));
    const protein = parseNumber(valueForHeader(row, FSANZ_HEADER_MATCHERS.protein));
    const carbs = parseNumber(valueForHeader(row, FSANZ_HEADER_MATCHERS.carbs));
    const fat = parseNumber(valueForHeader(row, FSANZ_HEADER_MATCHERS.fat));

    nutrientsByFood.set(providerId, {
      calories: caloriesKj != null ? roundNumber(caloriesKj * 0.239005736) : null,
      protein,
      carbs,
      fat,
    });
  }

  const parsed: ParsedSource = {
    sourceId: 'afcd-release-3',
    provider: 'afcd',
    releaseDate: '2025-12-23',
    license: 'CC BY 4.0',
    inputFiles: measuresPath ? [detailsPath, nutrientsPath, measuresPath] : [detailsPath, nutrientsPath],
    stagingRecords: [],
    rejectedRows: [],
  };

  for (const row of detailsRows) {
    const providerId = String(valueForHeader(row, FSANZ_HEADER_MATCHERS.foodId) ?? '').trim();
    const rawName = String(valueForHeader(row, FSANZ_HEADER_MATCHERS.foodName) ?? '').trim();
    if (!providerId || !rawName) continue;

    const nutrients = nutrientsByFood.get(providerId) ?? {
      calories: null,
      protein: null,
      carbs: null,
      fat: null,
    };
    const servingMeasures = [
      parseAfcdServingFromRow(row),
      ...(servingsByFood.get(providerId) ?? []),
    ].filter((value): value is ServingMeasure => value != null);
    const serving = chooseBestServing(servingMeasures);
    const servingSizes = buildServingSizes(servingMeasures, 'afcd_measure');

    const record = createStagingRecord({
      provider: 'afcd',
      providerId,
      name: normalizeDisplayName(rawName),
      brandName: null,
      countryCode: null,
      region: 'au',
      caloriesPer100g: nutrients.calories,
      proteinPer100g: nutrients.protein,
      carbsPer100g: nutrients.carbs,
      fatPer100g: nutrients.fat,
      servingSizeG: serving?.grams ?? null,
      servingQuantity: serving?.quantity ?? null,
      servingUnit: serving?.unit ?? null,
      servingDescription: serving?.description ?? null,
      servingWeightsG: servingWeightsFromSizes(servingSizes),
      servingSizes,
      barcode: null,
      imageUrl: null,
      license: 'CC BY 4.0',
      sourceUpdatedAt: parsed.releaseDate,
      warnings: [],
    });

    const rejectionReason = shouldRejectRecord(record);
    if (rejectionReason) {
      parsed.rejectedRows.push({
        provider: 'afcd',
        providerId,
        reason: rejectionReason,
        name: record.name,
      });
      continue;
    }

    parsed.stagingRecords.push(record);
  }

  return [parsed];
}

async function* streamLines(filePath: string): AsyncGenerator<string, void, void> {
  const stream = filePath.endsWith('.gz')
    ? createReadStream(filePath).pipe(createGunzip())
    : createReadStream(filePath);
  const decoder = new StringDecoder('utf8');
  let buffered = '';

  for await (const chunk of stream) {
    buffered += decoder.write(chunk);
    let newlineIndex = buffered.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffered.slice(0, newlineIndex).replace(/\r$/, '');
      buffered = buffered.slice(newlineIndex + 1);
      yield line;
      newlineIndex = buffered.indexOf('\n');
    }
  }

  buffered += decoder.end();
  if (buffered) yield buffered.replace(/\r$/, '');
}

export function listOpenFoodFactsFiles(dirPath: string): Promise<string[]> {
  return fs.readdir(dirPath).then((entries) =>
    entries
      .filter((entry) => /\.jsonl(?:\.gz)?$/i.test(entry))
      .map((entry) => path.join(dirPath, entry))
      .sort()
  );
}

export function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function stringListValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

export function normalizeOpenFoodFactsCountryCode(countriesTags: unknown): string | null {
  for (const countryTag of stringListValue(countriesTags)) {
    const tag = countryTag
      .toLowerCase()
      .replace(/^[a-z]{2}:/, '')
      .replace(/_/g, '-')
      .trim();
    if (/^[a-z]{2}$/.test(tag)) return tag;
    const mapped = OFF_COUNTRY_CODES_BY_TAG[tag];
    if (mapped) return mapped;
  }
  return null;
}

export function numberValue(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return parseNumber(value);
  return null;
}

export function firstNumberValue(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = numberValue(value);
    if (parsed != null) return parsed;
  }
  return null;
}

export function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function openFoodFactsAggregatedNutriments(product: Record<string, unknown>): Record<string, unknown> {
  const nutrition = objectValue(product.nutrition);
  const aggregatedSet = objectValue(nutrition.aggregated_set);
  const nutrients = objectValue(aggregatedSet.nutrients);
  const per = stringValue(aggregatedSet.per)?.toLowerCase() === 'serving' ? 'serving' : '100g';
  const nutriments: Record<string, unknown> = {};

  for (const [key, nutrient] of Object.entries(nutrients)) {
    const nutrientValue = objectValue(nutrient);
    nutriments[`${key}_${per}`] = nutrientValue.value ?? nutrientValue.value_computed;
    nutriments[`${key}_unit`] = nutrientValue.unit;
  }

  return nutriments;
}

type OpenFoodFactsNutrientKind = 'mass' | 'kcal' | 'kj';

interface OpenFoodFactsNutrientResult {
  value: number | null;
  warnings: string[];
}

function openFoodFactsUnitMultiplier(
  kind: OpenFoodFactsNutrientKind,
  rawUnit: unknown
): number | null {
  const unit = stringValue(rawUnit)?.toLowerCase().replace(/μ/g, 'µ') ?? null;
  if (kind === 'mass') {
    if (unit == null || unit === 'g') return 1;
    if (unit === 'mg') return 0.001;
    if (unit === 'µg' || unit === 'ug' || unit === 'mcg') return 0.000001;
    if (unit === 'kg') return 1000;
    return null;
  }
  if (kind === 'kcal') {
    if (unit == null || unit === 'kcal' || unit === 'cal') return 1;
    if (unit === 'kj') return 1 / 4.184;
    return null;
  }
  if (unit == null || unit === 'kj') return 1;
  if (unit === 'kcal' || unit === 'cal') return 4.184;
  return null;
}

function openFoodFactsNutrientPer100g(
  product: Record<string, unknown>,
  nutriments: Record<string, unknown>,
  names: string[],
  kind: OpenFoodFactsNutrientKind,
  servingSizeG: number | null
): OpenFoodFactsNutrientResult {
  const nutritionDataPer = stringValue(product.nutrition_data_per)?.toLowerCase();
  const maximum = kind === 'mass' ? 100 : kind === 'kcal' ? 9_000 : 9_000 * 4.184;

  for (const name of names) {
    const enteredPer = nutritionDataPer === 'serving' ? 'serving' : '100g';
    const candidates = [
      { field: `${name}_100g`, per: '100g' },
      { field: `${name}_serving`, per: 'serving' },
      { field: name, per: enteredPer },
      { field: `${name}_value`, per: enteredPer },
    ] as const;

    for (const candidate of candidates) {
      const rawValue = numberValue(nutriments[candidate.field]);
      if (rawValue == null) continue;

      const multiplier = openFoodFactsUnitMultiplier(kind, nutriments[`${name}_unit`]);
      if (multiplier == null) {
        return {
          value: null,
          warnings: [`dropped ${candidate.field}: unsupported unit`],
        };
      }
      if (candidate.per === 'serving' && servingSizeG == null) {
        return {
          value: null,
          warnings: [`dropped ${candidate.field}: serving grams unavailable`],
        };
      }

      const perMultiplier = candidate.per === 'serving' ? 100 / (servingSizeG as number) : 1;
      const corrected = multiplier !== 1 || perMultiplier !== 1;
      const normalized = corrected
        ? roundNumber(rawValue * multiplier * perMultiplier)
        : rawValue;
      if (normalized < 0 || normalized > maximum) {
        return {
          value: null,
          warnings: [
            `dropped ${candidate.field}: normalized value ${normalized} is outside 0..${maximum}`,
          ],
        };
      }

      return {
        value: normalized,
        warnings: corrected
          ? [`normalized ${candidate.field} from ${rawValue} to ${normalized} per 100g`]
          : [],
      };
    }
  }

  return { value: null, warnings: [] };
}

export function parseOpenFoodFactsStructuredServing(product: Record<string, unknown>): ServingMeasure | null {
  const inputSets = objectValue(product.nutrition).input_sets;
  if (!Array.isArray(inputSets)) return null;

  for (const inputSet of inputSets) {
    const set = objectValue(inputSet);
    const per = stringValue(set.per)?.toLowerCase();
    const source = stringValue(set.source)?.toLowerCase();
    const perUnit = stringValue(set.per_unit)?.toLowerCase();
    const perQuantity = numberValue(set.per_quantity);

    if (per !== 'serving' || source !== 'packaging') continue;
    if (perUnit !== 'g' || perQuantity == null || perQuantity <= 0) continue;

    return createServingMeasure({
      grams: perQuantity,
      quantity: 1,
      unit: 'serving',
      description: stringValue(product.serving_size) ?? 'serving',
      source: 'off_structured',
    });
  }

  return null;
}

export function parseOpenFoodFactsServing(product: Record<string, unknown>): ServingMeasure | null {
  const structuredServing = parseOpenFoodFactsStructuredServing(product);
  if (structuredServing) return structuredServing;

  const servingSize = stringValue(product.serving_size);
  const servingQuantity = numberValue(product.serving_quantity);
  const parsedMeasure = parseQuantityAndUnit(servingSize);
  const gramsFromText =
    servingSize?.match(/\((\d+(?:\.\d+)?)\s*g\)/i)?.[1] ??
    servingSize?.match(/\b(\d+(?:\.\d+)?)\s*g\b/i)?.[1] ??
    null;
  const grams = parseNumber(gramsFromText) ?? servingQuantity;

  return createServingMeasure({
    grams,
    quantity: parsedMeasure?.quantity ?? null,
    unit: parsedMeasure?.unit ?? null,
    description: servingSize,
    source: 'off_label',
  });
}

export async function parseOpenFoodFactsDirectory(
  openFoodFactsDir: string,
  options: OpenFoodFactsParseOptions = {}
): Promise<ParsedSource[]> {
  const files = await listOpenFoodFactsFiles(openFoodFactsDir);
  if (files.length === 0) {
    throw new Error(`Could not find Open Food Facts JSONL files in ${openFoodFactsDir}`);
  }

  const parsed: ParsedSource = {
    sourceId: 'openfoodfacts-jsonl',
    provider: 'openfoodfacts',
    releaseDate: null,
    license: 'ODbL',
    inputFiles: files,
    stagingRecords: [],
    rejectedRows: [],
    energyDiscrepancies: [],
    stagingRecordCount: 0,
    rejectedRowCount: 0,
    nutrientCorrectionCount: 0,
  };

  let rowsRead = 0;
  const reportProgress = async () => {
    if (!options.onProgress || rowsRead % 10_000 !== 0) return;
    await options.onProgress({
      rowsRead,
      stagingRecords: parsed.stagingRecordCount ?? parsed.stagingRecords.length,
      rejectedRows: parsed.rejectedRowCount ?? parsed.rejectedRows.length,
      nutrientCorrections: parsed.nutrientCorrectionCount ?? 0,
    });
  };

  for (const filePath of files) {
    for await (const line of streamLines(filePath)) {
      if (!line.trim()) continue;
      rowsRead += 1;

      let product: Record<string, unknown>;
      try {
        product = JSON.parse(line) as Record<string, unknown>;
      } catch {
        parsed.rejectedRowCount = (parsed.rejectedRowCount ?? parsed.rejectedRows.length) + 1;
        if (parsed.rejectedRows.length < MAX_OPENFOODFACTS_QA_REJECTED_ROWS) {
          parsed.rejectedRows.push({
            provider: 'openfoodfacts',
            providerId: '',
            reason: 'invalid jsonl row',
            name: '',
          });
        }
        await reportProgress();
        continue;
      }

      const providerId = stringValue(product.code) ?? stringValue(product._id);
      const rawName = stringValue(product.product_name) ?? stringValue(product.generic_name);
      if (!providerId || !rawName) {
        await reportProgress();
        continue;
      }

      const servingMeasures = [parseOpenFoodFactsServing(product)].filter(
        (value): value is ServingMeasure => value != null
      );
      const serving = chooseBestServing(servingMeasures);
      const servingSizes = buildServingSizes(servingMeasures, 'off_label');
      const servingSizeG = serving?.grams ?? null;
      const legacyNutriments = objectValue(product.nutriments);
      const aggregatedNutriments = openFoodFactsAggregatedNutriments(product);
      let nutriments = legacyNutriments;
      let kcal = openFoodFactsNutrientPer100g(
        product,
        nutriments,
        ['energy-kcal'],
        'kcal',
        servingSizeG
      );
      let kj = openFoodFactsNutrientPer100g(
        product,
        nutriments,
        ['energy-kj', 'energy'],
        'kj',
        servingSizeG
      );
      if (kcal.value == null && kj.value == null) {
        nutriments = aggregatedNutriments;
        kcal = openFoodFactsNutrientPer100g(
          product,
          nutriments,
          ['energy-kcal'],
          'kcal',
          servingSizeG
        );
        kj = openFoodFactsNutrientPer100g(
          product,
          nutriments,
          ['energy-kj', 'energy'],
          'kj',
          servingSizeG
        );
      }
      const protein = openFoodFactsNutrientPer100g(
        product,
        nutriments,
        ['proteins'],
        'mass',
        servingSizeG
      );
      const carbs = openFoodFactsNutrientPer100g(
        product,
        nutriments,
        ['carbohydrates', 'carbs'],
        'mass',
        servingSizeG
      );
      const fat = openFoodFactsNutrientPer100g(
        product,
        nutriments,
        ['fat'],
        'mass',
        servingSizeG
      );
      const nutrientWarnings = [
        ...kcal.warnings,
        ...kj.warnings,
        ...protein.warnings,
        ...carbs.warnings,
        ...fat.warnings,
      ];
      parsed.nutrientCorrectionCount =
        (parsed.nutrientCorrectionCount ?? 0) + nutrientWarnings.length;
      const normalizedName = normalizeDisplayName(rawName);
      const energyValidation = validateEnergyPair({
        provider: 'openfoodfacts',
        providerId,
        name: normalizedName,
        kcalPer100g: kcal.value,
        kjPer100g: kj.value,
        proteinPer100g: protein.value,
        carbsPer100g: carbs.value,
        fatPer100g: fat.value,
      });
      const calories = energyValidation.caloriesPer100g;
      if (energyValidation.discrepancy) {
        parsed.energyDiscrepancies?.push(energyValidation.discrepancy);
      }
      const imageUrl =
        stringValue(product.image_front_url) ??
        stringValue(product.image_url) ??
        stringValue(product.image_small_url);
      const record = createStagingRecord({
        provider: 'openfoodfacts',
        providerId,
        name: normalizedName,
        brandName: stringValue(product.brands),
        countryCode: normalizeOpenFoodFactsCountryCode(product.countries_tags),
        region: 'global',
        caloriesPer100g: calories,
        proteinPer100g: protein.value,
        carbsPer100g: carbs.value,
        fatPer100g: fat.value,
        servingSizeG,
        servingQuantity: serving?.quantity ?? null,
        servingUnit: serving?.unit ?? null,
        servingDescription: serving?.description ?? null,
        servingWeightsG: servingWeightsFromSizes(servingSizes),
        servingSizes,
        barcode: providerId,
        imageUrl,
        license: 'ODbL',
        sourceUpdatedAt: stringValue(product.last_modified_t),
        warnings: nutrientWarnings,
      });

      const rejectionReason = shouldRejectRecord(record);
      if (rejectionReason) {
        parsed.rejectedRowCount = (parsed.rejectedRowCount ?? parsed.rejectedRows.length) + 1;
        if (parsed.rejectedRows.length < MAX_OPENFOODFACTS_QA_REJECTED_ROWS) {
          parsed.rejectedRows.push({
            provider: 'openfoodfacts',
            providerId,
            reason: rejectionReason,
            name: record.name,
          });
        }
        await reportProgress();
        continue;
      }

      parsed.stagingRecordCount = (parsed.stagingRecordCount ?? parsed.stagingRecords.length) + 1;
      if (options.onStagingRecord) {
        options.onStagingRecord(record);
      } else {
        parsed.stagingRecords.push(record);
      }

      await reportProgress();
    }
  }

  return [parsed];
}
