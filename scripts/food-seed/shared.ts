import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import type {
  DedupeAccumulator,
  DedupeGroup,
  Provider,
  QADuplicateGroup,
  SeedFood,
  SeedStagingRecord,
  ServingMeasure,
} from './types.ts';

const COMMON_SERVING_UNITS = [
  'cup',
  'tbsp',
  'tsp',
  'fl_oz',
  'ml',
  'l',
  'oz',
  'slice',
  'piece',
  'bar',
  'cookie',
  'can',
  'bottle',
  'packet',
  'serving',
  'serve',
  'small',
  'medium',
  'large',
] as const;

export function parseNumber(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseMixedNumber(value: string | number | null | undefined): number | null {
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

export function roundNumber(value: number): number {
  return Math.round(value * 100) / 100;
}

export function normalizeServingUnit(value: string | null | undefined): string | null {
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
  if (/\b(milliliter|milliliters|millilitre|millilitres|ml)\b/.test(normalized)) return 'ml';
  if (/\b(liter|liters|litre|litres|l)\b/.test(normalized)) return 'l';
  if (/\b(ounce|ounces|oz)\b/.test(normalized)) return 'oz';
  if (/\b(slice|slices)\b/.test(normalized)) return 'slice';
  if (/\b(piece|pieces)\b/.test(normalized)) return 'piece';
  if (/\b(bar|bars)\b/.test(normalized)) return 'bar';
  if (/\b(cookie|cookies)\b/.test(normalized)) return 'cookie';
  if (/\b(can|cans)\b/.test(normalized)) return 'can';
  if (/\b(bottle|bottles)\b/.test(normalized)) return 'bottle';
  if (/\b(packet|packets|package|packages|pkg|pkgs)\b/.test(normalized)) return 'packet';
  if (/\b(serve|serves|serving|servings)\b/.test(normalized)) return 'serving';
  if (/\bsmall\b/.test(normalized)) return 'small';
  if (/\bmedium\b/.test(normalized)) return 'medium';
  if (/\blarge\b/.test(normalized)) return 'large';

  return null;
}

export function parseQuantityAndUnit(value: string | null | undefined): {
  quantity: number;
  unit: string;
} | null {
  if (!value) return null;
  const pattern =
    /(\d+(?:\.\d+)?(?:\s+\d+\/\d+)?|\d+\/\d+)\s*(cups?|c|tablespoons?|tbsp|tbs|tb|teaspoons?|tsp|ts|fluid ounces?|fl ounces?|fl oz|floz|milliliters?|millilitres?|ml|liters?|litres?|l|ounces?|oz|slices?|pieces?|bars?|cookies?|cans?|bottles?|packets?|packages?|pkgs?|serves?|servings?|small|medium|large)\b/i;
  const matched = value.match(pattern);
  if (!matched) return null;

  const quantity = parseMixedNumber(matched[1]);
  const unit = normalizeServingUnit(matched[2]);
  if (quantity == null || quantity <= 0 || !unit) return null;
  return { quantity, unit };
}

export function mergeServingWeights(
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

export function servingWeightsForMeasure(
  grams: number,
  quantity: number | null,
  unit: string | null
): Record<string, number> {
  if (quantity == null || quantity <= 0 || !unit) return {};
  return { [unit]: roundNumber(grams / quantity) };
}

export function createServingMeasure(input: {
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

export function combineServingMeasures(servings: ServingMeasure[]): ServingMeasure | null {
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

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);

  for await (const chunk of stream) {
    hash.update(chunk);
  }

  return hash.digest('hex');
}

export async function readManifestFileInfo(filePath: string): Promise<{
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

export function createManifestFileCollector(
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

export function normalizeDisplayName(value: string): string {
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

export function normalizedNameKey(value: string): string {
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

export function normalizeDedupeToken(token: string): string {
  if (token.length <= 3) return token;
  if (token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.endsWith('oes') || token.endsWith('xes') || token.endsWith('ches') || token.endsWith('shes')) {
    return token.slice(0, -2);
  }
  if (token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

export function dedupeNameTokens(value: string): string[] {
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

export function dedupeNameKey(value: string): string {
  return dedupeNameTokens(value).join(' ');
}

export function dedupeMatchKey(value: string): string {
  return dedupeNameTokens(value).sort().join(' ');
}

export function canonicalPackageUnit(value: string): string {
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

export function dedupePackageKey(value: string): string {
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

export function normalizeDedupeField(value: string | null): string {
  return value ? normalizedNameKey(value) : '';
}

export function normalizeBarcodeKey(value: string | null): string {
  return value?.replace(/[^a-zA-Z0-9]+/g, '').toLowerCase() ?? '';
}

export function normalizeBarcodeValue(value: string | null): string | null {
  const normalized = value?.replace(/[^a-zA-Z0-9]+/g, '') ?? '';
  return normalized || null;
}

export function uniqueBarcodes(values: (string | null)[]): string[] {
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

export function recordBarcodes(record: SeedStagingRecord): string[] {
  return uniqueBarcodes([...record.barcodes, record.barcode]);
}

export function dedupeIdentityKey(record: SeedStagingRecord): string {
  return [
    `name:${dedupeMatchKey(record.name)}`,
    `brand:${normalizeDedupeField(record.brandName)}`,
    `country:${record.countryCode?.toLowerCase() ?? ''}`,
    `package:${dedupePackageKey(record.name)}`,
  ].join('|');
}

export function dedupeRecordKeys(record: SeedStagingRecord): string[] {
  const barcodeKey = normalizeBarcodeKey(record.barcode);
  return barcodeKey ? [`barcode:${barcodeKey}`, dedupeIdentityKey(record)] : [dedupeIdentityKey(record)];
}

export function buildQualityScore(record: Omit<SeedStagingRecord, 'qualityScore' | 'barcodes'>): number {
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

export function createStagingRecord(
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

export function seedSourceForProvider(provider: Provider): SeedFood['source'] {
  if (provider === 'usda_foundation' || provider === 'usda_sr_legacy') return 'usda';
  return provider;
}

export function buildSeedFood(record: SeedStagingRecord, generatedAt: string): SeedFood {
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

export function compareRecords(left: SeedStagingRecord, right: SeedStagingRecord): number {
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

export function dedupeSeedRecords(records: SeedStagingRecord[]): {
  records: SeedStagingRecord[];
  duplicateGroups: QADuplicateGroup[];
} {
  const accumulator = createDedupeAccumulator();
  for (const record of records) {
    addDedupeRecord(accumulator, record);
  }

  return finalizeDedupeAccumulator(accumulator);
}

export function buildDuplicateGroup(group: SeedStagingRecord[]): {
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

export function createDedupeAccumulator(): DedupeAccumulator {
  return {
    groups: new Set(),
    groupsByKey: new Map(),
  };
}

function createDedupeGroup(record: SeedStagingRecord, keys: string[]): DedupeGroup {
  return {
    records: [record],
    keys: new Set(keys),
  };
}

export function addDedupeRecord(accumulator: DedupeAccumulator, record: SeedStagingRecord): void {
  const keys = dedupeRecordKeys(record);
  const matchingGroups: DedupeGroup[] = [];
  for (const key of keys) {
    const group = accumulator.groupsByKey.get(key);
    if (group && !matchingGroups.includes(group)) matchingGroups.push(group);
  }

  if (matchingGroups.length === 0) {
    const group = createDedupeGroup(record, keys);
    accumulator.groups.add(group);
    for (const key of keys) accumulator.groupsByKey.set(key, group);
    return;
  }

  const targetGroup = matchingGroups.reduce((largest, group) =>
    group.records.length > largest.records.length ? group : largest
  );
  targetGroup.records.push(record);
  for (const key of keys) {
    targetGroup.keys.add(key);
    accumulator.groupsByKey.set(key, targetGroup);
  }

  for (const group of matchingGroups) {
    if (group === targetGroup) continue;
    accumulator.groups.delete(group);
    targetGroup.records.push(...group.records);
    for (const key of group.keys) {
      targetGroup.keys.add(key);
      accumulator.groupsByKey.set(key, targetGroup);
    }
  }
}

export function finalizeDedupeAccumulator(accumulator: DedupeAccumulator): {
  records: SeedStagingRecord[];
  duplicateGroups: QADuplicateGroup[];
} {
  const records: SeedStagingRecord[] = [];
  const duplicateGroups: QADuplicateGroup[] = [];
  for (const group of accumulator.groups) {
    const { kept, duplicateGroup } = buildDuplicateGroup(group.records);
    records.push(kept);
    if (duplicateGroup) duplicateGroups.push(duplicateGroup);
  }
  accumulator.groups.clear();
  accumulator.groupsByKey.clear();

  records.sort((left, right) => left.name.localeCompare(right.name));
  duplicateGroups.sort((left, right) => left.normalizedName.localeCompare(right.normalizedName));

  return { records, duplicateGroups };
}


export async function writeJsonArray<T>(
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
      const line = prefix + JSON.stringify(mapItem(item), null, 2).replace(/\n/g, '\n  ');
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
