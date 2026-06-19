import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { createGunzip } from 'node:zlib';
import * as XLSXModule from 'xlsx';

type Provider = 'usda_foundation' | 'usda_sr_legacy' | 'afcd' | 'openfoodfacts';

export interface FoodSeedBuildArgs {
  usdaDir: string;
  afcdDir?: string;
  openFoodFactsDir: string;
  outputDir: string;
}

export interface SeedFood {
  id: string;
  name: string;
  brandName: string | null;
  countryCode: string | null;
  caloriesPer100g: number;
  proteinPer100g: number;
  carbsPer100g: number;
  fatPer100g: number;
  servingSizeG: number | null;
  servingQuantity: number | null;
  servingUnit: string | null;
  servingDescription: string | null;
  servingWeightsG: Record<string, number>;
  barcode: string | null;
  barcodes: string[];
  source: 'usda' | 'afcd' | 'openfoodfacts' | 'user' | 'quick_add';
  license: string;
  sourceUpdatedAt: string | null;
  createdAt: string;
}

export interface SeedStagingRecord {
  provider: Provider;
  providerId: string;
  name: string;
  brandName: string | null;
  countryCode: string | null;
  region: 'us' | 'au' | 'global';
  caloriesPer100g: number | null;
  proteinPer100g: number | null;
  carbsPer100g: number | null;
  fatPer100g: number | null;
  servingSizeG: number | null;
  servingQuantity: number | null;
  servingUnit: string | null;
  servingDescription: string | null;
  servingWeightsG: Record<string, number>;
  barcode: string | null;
  barcodes: string[];
  imageUrl: string | null;
  license: string;
  sourceUpdatedAt: string | null;
  qualityScore: number;
  warnings: string[];
}

interface ParsedSource {
  sourceId: string;
  provider: 'usda' | 'afcd' | 'openfoodfacts';
  releaseDate: string | null;
  license: string;
  inputFiles: string[];
  stagingRecords: SeedStagingRecord[];
  rejectedRows: RejectedRow[];
  stagingRecordCount?: number;
  rejectedRowCount?: number;
}

interface RejectedRow {
  provider: string;
  providerId: string;
  reason: string;
  name: string;
}

interface QADuplicateGroup {
  normalizedName: string;
  keptId: string;
  droppedIds: string[];
}

interface SeedManifest {
  generatedAt: string;
  stagingSchemaVersion: 2;
  sources: {
    sourceId: string;
    provider: string;
    releaseDate: string | null;
    license: string;
    files: {
      path: string;
      sha256: string;
      sizeBytes: number;
    }[];
    stagingRecordCount: number;
    rejectedRowCount: number;
  }[];
  totals: {
    stagingRecordCount: number;
    seedCount: number;
    genericSeedCount: number;
    brandedSeedCount: number;
    rejectedRowCount: number;
    duplicateGroupCount: number;
  };
}

interface SeedQAReport {
  generatedAt: string;
  counts: {
    stagingRecords: number;
    emittedFoods: number;
    genericFoods: number;
    brandedFoods: number;
    rejectedRows: number;
    duplicateGroups: number;
  };
  rejectedRows: RejectedRow[];
  duplicateGroups: QADuplicateGroup[];
}

interface BuildSummary {
  outputDir: string;
  genericSeedCount: number;
  brandedSeedCount: number;
  sourceCount: number;
  rejectedCount: number;
  duplicateCount: number;
}

interface DedupeAccumulator {
  groups: Set<SeedStagingRecord[]>;
  groupsByKey: Map<string, SeedStagingRecord[]>;
}

interface OpenFoodFactsParseOptions {
  onStagingRecord?: (record: SeedStagingRecord) => void;
}

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
  foodName: [/^food$/i, /^food[_\s-]*name$/i, /^food[_\s-]*description$/i],
  energyKj: [/^energy.*dietary fibre.*kj/i, /^energy.*kj/i, /^kj$/i],
  protein: [/^protein/i],
  carbs: [/^carbohydrate/i, /^available carbohydrate/i],
  fat: [/^fat[, ]*total/i, /^total fat/i],
  gramWeight: [/^gram[_\s-]*amount$/i, /^gram[_\s-]*weight$/i, /^weight.*g/i],
  measureDescription: [/^measure/i, /^portion/i, /^descriptor/i, /^quantity$/i, /^description$/i],
} as const;

const COMMON_SERVING_UNITS = ['cup', 'tbsp', 'tsp', 'fl_oz'] as const;

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

interface ServingMeasure {
  grams: number;
  quantity: number | null;
  unit: string | null;
  description: string | null;
  weightsG: Record<string, number>;
}

type XlsxModule = typeof import('xlsx');
const XLSX = ((XLSXModule as XlsxModule & { default?: XlsxModule }).default ??
  XLSXModule) as XlsxModule;

function parseNumber(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseMixedNumber(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  const number = Number(trimmed);
  if (Number.isFinite(number)) return number;

  const fraction = trimmed.match(/^(\d+)\/(\d+)$/);
  if (fraction) {
    const numerator = Number(fraction[1]);
    const denominator = Number(fraction[2]);
    return denominator > 0 ? numerator / denominator : null;
  }

  const mixed = trimmed.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixed) {
    const whole = Number(mixed[1]);
    const numerator = Number(mixed[2]);
    const denominator = Number(mixed[3]);
    return denominator > 0 ? whole + numerator / denominator : null;
  }

  return null;
}

function roundNumber(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizeServingUnit(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value
    .toLowerCase()
    .replace(/[().,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (/\b(cup|cups|c)\b/.test(normalized)) return 'cup';
  if (/\b(tablespoon|tablespoons|tbsp|tbs|tb)\b/.test(normalized)) return 'tbsp';
  if (/\b(teaspoon|teaspoons|tsp|ts)\b/.test(normalized)) return 'tsp';
  if (/\b(fluid ounce|fluid ounces|fl oz|fl ounce|fl ounces|floz)\b/.test(normalized)) {
    return 'fl_oz';
  }

  return null;
}

function parseQuantityAndUnit(value: string | null | undefined): {
  quantity: number;
  unit: string;
} | null {
  if (!value) return null;
  const pattern =
    /(\d+(?:\.\d+)?(?:\s+\d+\/\d+)?|\d+\/\d+)\s*(cups?|c|tablespoons?|tbsp|tbs|tb|teaspoons?|tsp|ts|fluid ounces?|fl ounces?|fl oz|floz)\b/i;
  const matched = value.match(pattern);
  if (!matched) return null;

  const quantity = parseMixedNumber(matched[1]);
  const unit = normalizeServingUnit(matched[2]);
  if (quantity == null || quantity <= 0 || !unit) return null;
  return { quantity, unit };
}

function mergeServingWeights(
  left: Record<string, number>,
  right: Record<string, number>
): Record<string, number> {
  const merged = { ...left };
  for (const [unit, grams] of Object.entries(right)) {
    if (grams <= 0) continue;
    merged[unit] = roundNumber(grams);
  }
  return merged;
}

function servingWeightsForMeasure(
  grams: number,
  quantity: number | null,
  unit: string | null
): Record<string, number> {
  if (quantity == null || quantity <= 0 || !unit) return {};
  return { [unit]: roundNumber(grams / quantity) };
}

function createServingMeasure(input: {
  grams: number | null;
  quantity?: number | null;
  unit?: string | null;
  description?: string | null;
  weightsG?: Record<string, number>;
}): ServingMeasure | null {
  if (input.grams == null || input.grams <= 0) return null;

  const quantity = input.quantity ?? null;
  const unit = input.unit ?? null;
  return {
    grams: roundNumber(input.grams),
    quantity: quantity != null ? roundNumber(quantity) : null,
    unit,
    description: input.description?.trim() || null,
    weightsG: mergeServingWeights(
      input.weightsG ?? {},
      servingWeightsForMeasure(input.grams, quantity, unit)
    ),
  };
}

function combineServingMeasures(servings: ServingMeasure[]): ServingMeasure | null {
  if (servings.length === 0) return null;

  const weightsG = servings.reduce<Record<string, number>>(
    (accumulator, serving) => mergeServingWeights(accumulator, serving.weightsG),
    {}
  );
  const preferred = [...servings].sort((left, right) => {
    const leftCommon =
      left.unit && (COMMON_SERVING_UNITS as readonly string[]).includes(left.unit) ? 1 : 0;
    const rightCommon =
      right.unit && (COMMON_SERVING_UNITS as readonly string[]).includes(right.unit) ? 1 : 0;
    if (leftCommon !== rightCommon) return rightCommon - leftCommon;
    return left.grams - right.grams;
  })[0];

  return { ...preferred, weightsG };
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);

  for await (const chunk of stream) {
    hash.update(chunk);
  }

  return hash.digest('hex');
}

async function readManifestFileInfo(filePath: string): Promise<{
  path: string;
  sha256: string;
  sizeBytes: number;
}> {
  const [sha256Digest, stats] = await Promise.all([hashFile(filePath), fs.stat(filePath)]);

  return {
    path: path.basename(filePath),
    sha256: sha256Digest,
    sizeBytes: stats.size,
  };
}

function createManifestFileCollector(
  readFileInfo: typeof readManifestFileInfo = readManifestFileInfo
): (filePath: string) => ReturnType<typeof readManifestFileInfo> {
  const fileInfoByPath = new Map<string, ReturnType<typeof readManifestFileInfo>>();

  return (filePath) => {
    let fileInfo = fileInfoByPath.get(filePath);
    if (!fileInfo) {
      fileInfo = readFileInfo(filePath);
      fileInfoByPath.set(filePath, fileInfo);
    }
    return fileInfo;
  };
}

function normalizeDisplayName(value: string): string {
  const compact = value
    .replace(/[–—/_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .trim();

  if (!compact) return compact;
  if (compact === compact.toUpperCase()) {
    return compact.toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
  }
  return compact;
}

function normalizedNameKey(value: string): string {
  return normalizeDisplayName(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const DEDUPE_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'by',
  'for',
  'of',
  'the',
  'with',
]);

function normalizeDedupeToken(token: string): string {
  if (token.length <= 3) return token;
  if (token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.endsWith('oes') || token.endsWith('xes') || token.endsWith('ches') || token.endsWith('shes')) {
    return token.slice(0, -2);
  }
  if (token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

function dedupeNameTokens(value: string): string[] {
  const withoutPackageNoise = normalizeDisplayName(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b\d+(?:\.\d+)?\s*(?:g|gram|grams|kg|ml|l|litre|liter|litres|liters|oz|ounce|ounces|lb|lbs|pound|pounds|fl\s*oz)\b/g, ' ')
    .replace(/\b\d+\s*(?:ct|count|pack|pk|pcs|pieces)\b/g, ' ')
    .replace(/\b(?:can|cans|jar|jars|bottle|bottles|box|boxes|bag|bags|packet|packets)\b/g, ' ');
  const tokens = withoutPackageNoise
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token && !DEDUPE_STOP_WORDS.has(token))
    .map(normalizeDedupeToken);

  return [...new Set(tokens)];
}

function dedupeNameKey(value: string): string {
  return dedupeNameTokens(value).join(' ');
}

function dedupeMatchKey(value: string): string {
  return dedupeNameTokens(value).sort().join(' ');
}

function canonicalPackageUnit(value: string): string {
  const compact = value.replace(/\s+/g, '');
  if (compact === 'gram' || compact === 'grams') return 'g';
  if (compact === 'litre' || compact === 'liter' || compact === 'litres' || compact === 'liters') return 'l';
  if (compact === 'ounce' || compact === 'ounces') return 'oz';
  if (compact === 'lbs' || compact === 'pound' || compact === 'pounds') return 'lb';
  if (compact === 'count') return 'ct';
  if (compact === 'pk') return 'pack';
  if (compact === 'pcs' || compact === 'pieces') return 'pc';
  return compact;
}

function dedupePackageKey(value: string): string {
  const normalized = normalizeDisplayName(value).toLowerCase();
  const packageParts = [
    ...normalized.matchAll(
      /\b(\d+(?:\.\d+)?)\s*(fl\s*oz|g|gram|grams|kg|ml|l|litre|liter|litres|liters|oz|ounce|ounces|lb|lbs|pound|pounds)\b/g
    ),
    ...normalized.matchAll(/\b(\d+)\s*(ct|count|pack|pk|pcs|pieces)\b/g),
  ].map((match) => {
    const amount = Number.parseFloat(match[1]);
    const unit = canonicalPackageUnit(match[2]);
    return `${Number.isInteger(amount) ? amount.toFixed(0) : amount}:${unit}`;
  });

  return [...new Set(packageParts)].sort().join(' ');
}

function normalizeDedupeField(value: string | null): string {
  return value ? normalizedNameKey(value) : '';
}

function normalizeBarcodeKey(value: string | null): string {
  return value?.replace(/[^a-zA-Z0-9]+/g, '').toLowerCase() ?? '';
}

function normalizeBarcodeValue(value: string | null): string | null {
  const normalized = value?.replace(/[^a-zA-Z0-9]+/g, '') ?? '';
  return normalized || null;
}

function uniqueBarcodes(values: (string | null)[]): string[] {
  const seen = new Set<string>();
  const barcodes: string[] = [];
  for (const value of values) {
    const normalized = normalizeBarcodeValue(value);
    if (!normalized) continue;
    const key = normalizeBarcodeKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    barcodes.push(normalized);
  }
  return barcodes;
}

function recordBarcodes(record: SeedStagingRecord): string[] {
  return uniqueBarcodes([...record.barcodes, record.barcode]);
}

function dedupeIdentityKey(record: SeedStagingRecord): string {
  return [
    `name:${dedupeMatchKey(record.name)}`,
    `brand:${normalizeDedupeField(record.brandName)}`,
    `country:${record.countryCode?.toLowerCase() ?? ''}`,
    `package:${dedupePackageKey(record.name)}`,
  ].join('|');
}

function dedupeRecordKeys(record: SeedStagingRecord): string[] {
  const barcodeKey = normalizeBarcodeKey(record.barcode);
  return barcodeKey ? [`barcode:${barcodeKey}`, dedupeIdentityKey(record)] : [dedupeIdentityKey(record)];
}

function buildQualityScore(record: Omit<SeedStagingRecord, 'qualityScore' | 'barcodes'>): number {
  let score = 0;
  if (record.caloriesPer100g != null) score += 3;
  if (record.proteinPer100g != null && record.carbsPer100g != null && record.fatPer100g != null) {
    score += 3;
  }
  if (record.servingSizeG != null) score += 2;
  if (Object.keys(record.servingWeightsG).length > 0) score += 2;
  if (record.barcode) score += 1;
  if (record.brandName) score += 1;
  if (record.imageUrl) score += 1;
  if (
    record.caloriesPer100g != null &&
    record.caloriesPer100g >= 100 &&
    (record.proteinPer100g ?? 0) === 0 &&
    (record.carbsPer100g ?? 0) === 0 &&
    (record.fatPer100g ?? 0) === 0
  ) {
    score -= 2;
  }
  return score;
}

function createStagingRecord(
  input: Omit<SeedStagingRecord, 'qualityScore' | 'barcodes'> & {
    barcodes?: string[];
    warnings?: string[];
  }
): SeedStagingRecord {
  const warnings = input.warnings ?? [];
  const barcodes = uniqueBarcodes([...(input.barcodes ?? []), input.barcode]);
  return {
    ...input,
    barcodes,
    warnings,
    qualityScore: buildQualityScore({ ...input, warnings }),
  };
}

function seedSourceForProvider(provider: Provider): SeedFood['source'] {
  if (provider === 'usda_foundation' || provider === 'usda_sr_legacy') return 'usda';
  return provider;
}

function buildSeedFood(record: SeedStagingRecord, generatedAt: string): SeedFood {
  const source = seedSourceForProvider(record.provider);
  const idPrefix = record.provider === 'openfoodfacts' ? 'off' : source;

  return {
    id: `${idPrefix}-${record.providerId}`,
    name: record.name,
    brandName: record.brandName,
    countryCode: record.countryCode,
    caloriesPer100g: record.caloriesPer100g ?? 0,
    proteinPer100g: record.proteinPer100g ?? 0,
    carbsPer100g: record.carbsPer100g ?? 0,
    fatPer100g: record.fatPer100g ?? 0,
    servingSizeG: record.servingSizeG,
    servingQuantity: record.servingQuantity,
    servingUnit: record.servingUnit,
    servingDescription: record.servingDescription,
    servingWeightsG: record.servingWeightsG,
    barcode: record.barcode,
    barcodes: recordBarcodes(record),
    source,
    license: record.license,
    sourceUpdatedAt: record.sourceUpdatedAt,
    createdAt: generatedAt,
  };
}

function compareRecords(left: SeedStagingRecord, right: SeedStagingRecord): number {
  if (left.qualityScore !== right.qualityScore) {
    return right.qualityScore - left.qualityScore;
  }

  const leftFoundation = left.provider === 'usda_foundation' ? 1 : 0;
  const rightFoundation = right.provider === 'usda_foundation' ? 1 : 0;
  if (leftFoundation !== rightFoundation) {
    return rightFoundation - leftFoundation;
  }

  const leftServing = left.servingSizeG != null ? 1 : 0;
  const rightServing = right.servingSizeG != null ? 1 : 0;
  if (leftServing !== rightServing) {
    return rightServing - leftServing;
  }

  return left.name.localeCompare(right.name);
}

function dedupeSeedRecords(records: SeedStagingRecord[]): {
  records: SeedStagingRecord[];
  duplicateGroups: QADuplicateGroup[];
} {
  const accumulator = createDedupeAccumulator();
  for (const record of records) {
    addDedupeRecord(accumulator, record);
  }

  return finalizeDedupeAccumulator(accumulator);
}

function buildDuplicateGroup(group: SeedStagingRecord[]): {
  kept: SeedStagingRecord;
  duplicateGroup: QADuplicateGroup | null;
} {
  group.sort(compareRecords);
  const kept = group[0];
  const barcodes = uniqueBarcodes(group.flatMap((record) => recordBarcodes(record)));
  const keptWithBarcodes = {
    ...kept,
    barcode: kept.barcode ?? barcodes[0] ?? null,
    barcodes,
  };
  const duplicateGroup =
    group.length > 1
      ? {
          normalizedName: dedupeNameKey(keptWithBarcodes.name),
          keptId: keptWithBarcodes.providerId,
          droppedIds: group.slice(1).map((record) => record.providerId),
        }
      : null;

  return { kept: keptWithBarcodes, duplicateGroup };
}

function createDedupeAccumulator(): DedupeAccumulator {
  return {
    groups: new Set(),
    groupsByKey: new Map(),
  };
}

function addDedupeRecord(accumulator: DedupeAccumulator, record: SeedStagingRecord): void {
  const keys = dedupeRecordKeys(record);
  const matchingGroups: SeedStagingRecord[][] = [];
  for (const key of keys) {
    const group = accumulator.groupsByKey.get(key);
    if (group && !matchingGroups.includes(group)) matchingGroups.push(group);
  }

  if (matchingGroups.length === 0) {
    const group = [record];
    accumulator.groups.add(group);
    for (const key of keys) accumulator.groupsByKey.set(key, group);
    return;
  }

  const mergedGroup = [...matchingGroups.flat(), record];
  for (const group of matchingGroups) accumulator.groups.delete(group);
  accumulator.groups.add(mergedGroup);

  for (const groupedRecord of mergedGroup) {
    for (const key of dedupeRecordKeys(groupedRecord)) {
      accumulator.groupsByKey.set(key, mergedGroup);
    }
  }
}

function finalizeDedupeAccumulator(accumulator: DedupeAccumulator): {
  records: SeedStagingRecord[];
  duplicateGroups: QADuplicateGroup[];
} {
  const records: SeedStagingRecord[] = [];
  const duplicateGroups: QADuplicateGroup[] = [];
  for (const group of accumulator.groups) {
    const { kept, duplicateGroup } = buildDuplicateGroup(group);
    records.push(kept);
    if (duplicateGroup) duplicateGroups.push(duplicateGroup);
  }

  records.sort((left, right) => left.name.localeCompare(right.name));
  duplicateGroups.sort((left, right) => left.normalizedName.localeCompare(right.normalizedName));

  return { records, duplicateGroups };
}

interface CsvRowParser {
  push(chunk: string): string[][];
  finish(): string[][];
}

function createCsvRowParser(): CsvRowParser {
  let currentField = '';
  let currentRow: string[] = [];
  let inQuotes = false;
  let pendingQuote = false;
  let skipLeadingLineFeed = false;

  const parseChunk = (chunk: string, isFinalChunk: boolean): string[][] => {
    const rows: string[][] = [];
    let index = 0;

    if (skipLeadingLineFeed && chunk[0] === '\n') {
      index = 1;
    }
    skipLeadingLineFeed = false;

    for (; index < chunk.length; index += 1) {
      const char = chunk[index];
      const next = chunk[index + 1];

      if (pendingQuote) {
        pendingQuote = false;
        if (char === '"') {
          currentField += '"';
          continue;
        }
        inQuotes = !inQuotes;
      }

      if (char === '"') {
        if (inQuotes && next === '"') {
          currentField += '"';
          index += 1;
        } else if (next == null) {
          pendingQuote = true;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }

      if (!inQuotes && char === ',') {
        currentRow.push(currentField);
        currentField = '';
        continue;
      }

      if (!inQuotes && (char === '\n' || char === '\r')) {
        if (char === '\r' && next === '\n') {
          index += 1;
        } else if (char === '\r' && next == null) {
          skipLeadingLineFeed = true;
        }
        currentRow.push(currentField);
        rows.push(currentRow);
        currentField = '';
        currentRow = [];
        continue;
      }

      currentField += char;
    }

    if (isFinalChunk && pendingQuote) {
      pendingQuote = false;
      inQuotes = !inQuotes;
    }

    if (isFinalChunk && (currentField.length > 0 || currentRow.length > 0)) {
      currentRow.push(currentField);
      rows.push(currentRow);
      currentField = '';
      currentRow = [];
    }

    return rows;
  };

  return {
    push(chunk: string) {
      return parseChunk(chunk, false);
    },
    finish() {
      return parseChunk('', true);
    },
  };
}

function mapCsvRows(rows: string[][]): Record<string, string>[] {
  if (rows.length === 0) return [];
  const headers = rows[0].map((header) => header.trim());
  return rows
    .slice(1)
    .filter((row) => row.some((field) => field.trim() !== ''))
    .map((row) => {
      const record: Record<string, string> = {};
      headers.forEach((header, index) => {
        record[header] = row[index]?.trim() ?? '';
      });
      return record;
    });
}

function parseCsv(text: string): Record<string, string>[] {
  const parser = createCsvRowParser();
  const rows = [...parser.push(text), ...parser.finish()];
  return mapCsvRows(rows);
}

async function* streamCsv(filePath: string): AsyncGenerator<Record<string, string>, void, void> {
  const parser = createCsvRowParser();
  const decoder = new StringDecoder('utf8');
  const stream = createReadStream(filePath);
  let headers: string[] | null = null;

  const emitRows = async function* (rows: string[][]): AsyncGenerator<Record<string, string>> {
    for (const row of rows) {
      if (!headers) {
        headers = row.map((header) => header.trim());
        continue;
      }
      if (!row.some((field) => field.trim() !== '')) continue;
      const record: Record<string, string> = {};
      headers.forEach((header, index) => {
        record[header] = row[index]?.trim() ?? '';
      });
      yield record;
    }
  };

  for await (const chunk of stream) {
    const rows = parser.push(decoder.write(chunk));
    yield* emitRows(rows);
  }

  const rows = [...parser.push(decoder.end()), ...parser.finish()];
  yield* emitRows(rows);
}

function findHeaderKey(row: Record<string, unknown>, matchers: readonly RegExp[]): string {
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

function chooseBestServing(servings: ServingMeasure[]): ServingMeasure | null {
  return combineServingMeasures(servings);
}

function shouldRejectRecord(record: SeedStagingRecord): string | null {
  if (record.caloriesPer100g == null) {
    return 'missing calories';
  }
  if (record.proteinPer100g == null && record.carbsPer100g == null && record.fatPer100g == null) {
    return 'missing all macros';
  }
  return null;
}

function normalizeUsdaProvider(dataType: string): Provider | null {
  const value = dataType.trim().toLowerCase().replace(/\s+/g, ' ');
  if (value === 'foundation' || value === 'foundation_food') return 'usda_foundation';
  if (value === 'sr legacy' || value === 'sr_legacy') return 'usda_sr_legacy';
  return null;
}

async function parseUsdaDirectory(usdaDir: string): Promise<ParsedSource[]> {
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
    const serving = chooseBestServing(servingsByFood.get(providerId) ?? []);

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
      servingWeightsG: serving?.weightsG ?? {},
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

function valueForHeader<T extends Record<string, unknown>>(
  row: T,
  matchers: readonly RegExp[]
): string | number | undefined {
  const key = findHeaderKey(row, matchers);
  const value = row[key];
  if (typeof value === 'number' || typeof value === 'string') return value;
  return undefined;
}

function listWorkbookFiles(dirPath: string): Promise<string[]> {
  return fs.readdir(dirPath).then((entries) =>
    entries
      .filter((entry) => /\.(xlsx|xls)$/i.test(entry))
      .map((entry) => path.join(dirPath, entry))
      .sort()
  );
}

function findWorkbook(files: string[], matchers: readonly RegExp[], description: string): string {
  const matched = files.find((filePath) =>
    matchers.some((matcher) => matcher.test(path.basename(filePath).toLowerCase()))
  );
  if (!matched) {
    throw new Error(`Could not find ${description} workbook in ${files.join(', ')}`);
  }
  return matched;
}

function readWorkbookRows(workbookPath: string): Record<string, unknown>[] {
  const workbook = XLSX.readFile(workbookPath, { cellDates: false });
  const sheetName =
    workbook.SheetNames.find((name) => !/contents/i.test(name)) ?? workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    range: 2,
    defval: '',
    raw: true,
  });
}

async function parseAfcdDirectory(afcdDir: string): Promise<ParsedSource[]> {
  const files = await listWorkbookFiles(afcdDir);
  const detailsPath = findWorkbook(files, [/food details/i], 'AFCD food details');
  const nutrientsPath = findWorkbook(
    files,
    [/nutrient profiles/i, /nutrient file/i],
    'AFCD nutrient profiles'
  );

  const detailsRows = readWorkbookRows(detailsPath);
  const nutrientRows = readWorkbookRows(nutrientsPath);

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
    inputFiles: [detailsPath, nutrientsPath],
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
      servingSizeG: null,
      servingQuantity: null,
      servingUnit: null,
      servingDescription: null,
      servingWeightsG: {},
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

function listOpenFoodFactsFiles(dirPath: string): Promise<string[]> {
  return fs.readdir(dirPath).then((entries) =>
    entries
      .filter((entry) => /\.jsonl(?:\.gz)?$/i.test(entry))
      .map((entry) => path.join(dirPath, entry))
      .sort()
  );
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stringListValue(value: unknown): string[] {
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

function normalizeOpenFoodFactsCountryCode(countriesTags: unknown): string | null {
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

function numberValue(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return parseNumber(value);
  return null;
}

function firstNumberValue(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = numberValue(value);
    if (parsed != null) return parsed;
  }
  return null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseOpenFoodFactsServing(product: Record<string, unknown>): ServingMeasure | null {
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
  });
}

async function parseOpenFoodFactsDirectory(
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
    stagingRecordCount: 0,
    rejectedRowCount: 0,
  };

  for (const filePath of files) {
    for await (const line of streamLines(filePath)) {
      if (!line.trim()) continue;

      let product: Record<string, unknown>;
      try {
        product = JSON.parse(line) as Record<string, unknown>;
      } catch {
        parsed.rejectedRowCount = (parsed.rejectedRowCount ?? parsed.rejectedRows.length) + 1;
        parsed.rejectedRows.push({
          provider: 'openfoodfacts',
          providerId: '',
          reason: 'invalid jsonl row',
          name: '',
        });
        continue;
      }

      const providerId = stringValue(product.code) ?? stringValue(product._id);
      const rawName = stringValue(product.product_name) ?? stringValue(product.generic_name);
      if (!providerId || !rawName) continue;

      const nutriments = objectValue(product.nutriments);
      const calories =
        firstNumberValue(nutriments['energy-kcal_100g'], nutriments['energy-kcal']) ??
        (() => {
          const energyKj = firstNumberValue(nutriments['energy-kj_100g'], nutriments.energy_100g);
          return energyKj != null ? roundNumber(energyKj * 0.239005736) : null;
        })();
      const serving = parseOpenFoodFactsServing(product);
      const imageUrl =
        stringValue(product.image_front_url) ??
        stringValue(product.image_url) ??
        stringValue(product.image_small_url);
      const record = createStagingRecord({
        provider: 'openfoodfacts',
        providerId,
        name: normalizeDisplayName(rawName),
        brandName: stringValue(product.brands),
        countryCode: normalizeOpenFoodFactsCountryCode(product.countries_tags),
        region: 'global',
        caloriesPer100g: calories,
        proteinPer100g: firstNumberValue(nutriments.proteins_100g, nutriments.proteins),
        carbsPer100g: firstNumberValue(
          nutriments.carbohydrates_100g,
          nutriments.carbs_100g,
          nutriments.carbohydrates,
          nutriments.carbs
        ),
        fatPer100g: firstNumberValue(nutriments.fat_100g, nutriments.fat),
        servingSizeG: serving?.grams ?? null,
        servingQuantity: serving?.quantity ?? null,
        servingUnit: serving?.unit ?? null,
        servingDescription: serving?.description ?? null,
        servingWeightsG: serving?.weightsG ?? {},
        barcode: providerId,
        imageUrl,
        license: 'ODbL',
        sourceUpdatedAt: stringValue(product.last_modified_t),
        warnings: [],
      });

      const rejectionReason = shouldRejectRecord(record);
      if (rejectionReason) {
        parsed.rejectedRowCount = (parsed.rejectedRowCount ?? parsed.rejectedRows.length) + 1;
        parsed.rejectedRows.push({
          provider: 'openfoodfacts',
          providerId,
          reason: rejectionReason,
          name: record.name,
        });
        continue;
      }

      parsed.stagingRecordCount = (parsed.stagingRecordCount ?? parsed.stagingRecords.length) + 1;
      if (options.onStagingRecord) {
        options.onStagingRecord(record);
      } else {
        parsed.stagingRecords.push(record);
      }
    }
  }

  return [parsed];
}

async function buildManifest(
  sources: ParsedSource[],
  seedCounts: { generic: number; branded: number },
  duplicateGroups: QADuplicateGroup[],
  generatedAt: string
): Promise<SeedManifest> {
  const getManifestFileInfo = createManifestFileCollector();

  const manifestSources = await Promise.all(
    sources.map(async (source) => ({
      sourceId: source.sourceId,
      provider: source.provider,
      releaseDate: source.releaseDate,
      license: source.license,
      files: await Promise.all(source.inputFiles.map((filePath) => getManifestFileInfo(filePath))),
      stagingRecordCount: source.stagingRecordCount ?? source.stagingRecords.length,
      rejectedRowCount: source.rejectedRowCount ?? source.rejectedRows.length,
    }))
  );

  const stagingRecordCount = sources.reduce(
    (sum, source) => sum + (source.stagingRecordCount ?? source.stagingRecords.length),
    0
  );
  const rejectedRowCount = sources.reduce(
    (sum, source) => sum + (source.rejectedRowCount ?? source.rejectedRows.length),
    0
  );

  return {
    generatedAt,
    stagingSchemaVersion: 2,
    sources: manifestSources,
    totals: {
      stagingRecordCount,
      seedCount: seedCounts.generic + seedCounts.branded,
      genericSeedCount: seedCounts.generic,
      brandedSeedCount: seedCounts.branded,
      rejectedRowCount,
      duplicateGroupCount: duplicateGroups.length,
    },
  };
}

function countStagingRecords(sources: ParsedSource[]): number {
  return sources.reduce(
    (sum, source) => sum + (source.stagingRecordCount ?? source.stagingRecords.length),
    0
  );
}

function countRejectedRows(sources: ParsedSource[]): number {
  return sources.reduce(
    (sum, source) => sum + (source.rejectedRowCount ?? source.rejectedRows.length),
    0
  );
}

function groupBrandedRecordsByCountry(
  records: SeedStagingRecord[]
): Map<string, SeedStagingRecord[]> {
  const groups = new Map<string, SeedStagingRecord[]>();
  for (const record of records) {
    const countryCode = record.countryCode ?? 'unknown';
    const group = groups.get(countryCode) ?? [];
    group.push(record);
    groups.set(countryCode, group);
  }

  return new Map([...groups.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

async function writeJsonArray<T>(
  filePath: string,
  items: Iterable<T>,
  mapItem: (item: T) => unknown = (item) => item
): Promise<void> {
  const stream = createWriteStream(filePath, { encoding: 'utf8' });
  try {
    if (!stream.write('[\n')) await once(stream, 'drain');
    let index = 0;
    for (const item of items) {
      const prefix = index === 0 ? '  ' : ',\n  ';
      const line = `${prefix}${JSON.stringify(mapItem(item), null, 2).replace(/\n/g, '\n  ')}`;
      if (!stream.write(line)) await once(stream, 'drain');
      index += 1;
    }
    stream.end('\n]\n');
    await once(stream, 'finish');
  } catch (error) {
    stream.destroy();
    throw error;
  }
}

export function parseBuildArgs(args: string[]): FoodSeedBuildArgs {
  const options: Partial<FoodSeedBuildArgs> = {
    outputDir: path.join(process.cwd(), 'generated', 'food-seed'),
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === '--usda-dir' && next) {
      options.usdaDir = next;
      index += 1;
      continue;
    }
    if (arg === '--afcd-dir' && next) {
      options.afcdDir = next;
      index += 1;
      continue;
    }
    if (arg === '--openfoodfacts-dir' && next) {
      options.openFoodFactsDir = next;
      index += 1;
      continue;
    }
    if (arg === '--output-dir' && next) {
      options.outputDir = next;
      index += 1;
      continue;
    }
  }

  if (!options.usdaDir || !options.openFoodFactsDir || !options.outputDir) {
    throw new Error(
      'Usage: npm run build:food-seed -- --usda-dir <path> --openfoodfacts-dir <path> [--afcd-dir <path>] [--output-dir <path>]'
    );
  }

  return options as FoodSeedBuildArgs;
}

export async function buildFoodSeedArtifacts(args: FoodSeedBuildArgs): Promise<BuildSummary> {
  const generatedAt = new Date().toISOString();
  const brandedAccumulator = createDedupeAccumulator();
  const sources = [
    ...(await parseUsdaDirectory(args.usdaDir)),
    ...(args.afcdDir ? await parseAfcdDirectory(args.afcdDir) : []),
    ...(await parseOpenFoodFactsDirectory(args.openFoodFactsDir, {
      onStagingRecord: (record) => addDedupeRecord(brandedAccumulator, record),
    })),
  ];
  const stagingRecords = sources.flatMap((source) => source.stagingRecords);
  const rejectedRows = sources.flatMap((source) => source.rejectedRows);
  const genericStagingRecords = stagingRecords.filter((record) => record.provider !== 'openfoodfacts');
  const {
    records: dedupedGenericRecords,
    duplicateGroups: genericDuplicateGroups,
  } = dedupeSeedRecords(genericStagingRecords);
  const {
    records: dedupedBrandedRecords,
    duplicateGroups: brandedDuplicateGroups,
  } = finalizeDedupeAccumulator(brandedAccumulator);
  const duplicateGroups = [...genericDuplicateGroups, ...brandedDuplicateGroups].sort((left, right) =>
    left.normalizedName.localeCompare(right.normalizedName)
  );
  const genericSeedFoods = dedupedGenericRecords.map((record) => buildSeedFood(record, generatedAt));
  const brandedRecordsByCountry = groupBrandedRecordsByCountry(dedupedBrandedRecords);
  const stagingRecordCount = countStagingRecords(sources);
  const rejectedRowCount = countRejectedRows(sources);
  const manifest = await buildManifest(
    sources,
    { generic: genericSeedFoods.length, branded: dedupedBrandedRecords.length },
    duplicateGroups,
    generatedAt
  );
  const qaReport: SeedQAReport = {
    generatedAt,
    counts: {
      stagingRecords: stagingRecordCount,
      emittedFoods: genericSeedFoods.length + dedupedBrandedRecords.length,
      genericFoods: genericSeedFoods.length,
      brandedFoods: dedupedBrandedRecords.length,
      rejectedRows: rejectedRowCount,
      duplicateGroups: duplicateGroups.length,
    },
    rejectedRows,
    duplicateGroups,
  };

  await fs.mkdir(args.outputDir, { recursive: true });
  const brandedWrites = [...brandedRecordsByCountry.entries()].map(([countryCode, records]) =>
    writeJsonArray(
      path.join(args.outputDir, `foods-${countryCode}.branded.json`),
      records,
      (record) => buildSeedFood(record, generatedAt)
    )
  );
  await Promise.all([
    writeJsonArray(
      path.join(args.outputDir, 'foods.seed.json'),
      genericSeedFoods
    ),
    ...brandedWrites,
    fs.writeFile(
      path.join(args.outputDir, 'foods.manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8'
    ),
    fs.writeFile(
      path.join(args.outputDir, 'foods.qa.json'),
      `${JSON.stringify(qaReport, null, 2)}\n`,
      'utf8'
    ),
  ]);

  return {
    outputDir: args.outputDir,
    genericSeedCount: genericSeedFoods.length,
    brandedSeedCount: dedupedBrandedRecords.length,
    sourceCount: sources.length,
    rejectedCount: rejectedRowCount,
    duplicateCount: duplicateGroups.length,
  };
}

export const testExports = {
  createCsvRowParser,
  parseCsv,
  normalizeDisplayName,
  normalizedNameKey,
  dedupeNameKey,
  dedupeMatchKey,
  dedupeSeedRecords,
  createStagingRecord,
  buildSeedFood,
  parseUsdaDirectory,
  parseAfcdDirectory,
  parseOpenFoodFactsDirectory,
  parseOpenFoodFactsServing,
  parseQuantityAndUnit,
  createManifestFileCollector,
  readManifestFileInfo,
  readWorkbookRows,
  parseBuildArgs,
  buildFoodSeedArtifacts,
  sha256,
};
