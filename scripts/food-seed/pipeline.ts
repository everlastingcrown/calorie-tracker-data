import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import * as XLSXModule from 'xlsx';

type Provider = 'usda_foundation' | 'usda_sr_legacy' | 'ausnut' | 'afcd';

export interface FoodSeedBuildArgs {
  usdaDir: string;
  ausnutDir: string;
  afcdDir?: string;
  outputDir: string;
}

export interface SeedFood {
  id: string;
  name: string;
  caloriesPer100g: number;
  proteinPer100g: number;
  carbsPer100g: number;
  fatPer100g: number;
  servingSizeG: number | null;
  barcode: string | null;
  source: 'usda' | 'ausnut' | 'afcd' | 'openfoodfacts' | 'user' | 'quick_add';
  createdAt: string;
}

export interface SeedStagingRecord {
  provider: Provider;
  providerId: string;
  name: string;
  brandName: string | null;
  region: 'us' | 'au';
  caloriesPer100g: number | null;
  proteinPer100g: number | null;
  carbsPer100g: number | null;
  fatPer100g: number | null;
  servingSizeG: number | null;
  servingDescription: string | null;
  barcode: string | null;
  sourceUpdatedAt: string | null;
  qualityScore: number;
  warnings: string[];
}

interface ParsedSource {
  sourceId: string;
  provider: 'usda' | 'ausnut' | 'afcd';
  releaseDate: string | null;
  license: string;
  inputFiles: string[];
  stagingRecords: SeedStagingRecord[];
  rejectedRows: RejectedRow[];
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
  stagingSchemaVersion: 1;
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
    rejectedRowCount: number;
    duplicateGroupCount: number;
  };
}

interface SeedQAReport {
  generatedAt: string;
  counts: {
    stagingRecords: number;
    emittedFoods: number;
    rejectedRows: number;
    duplicateGroups: number;
  };
  rejectedRows: RejectedRow[];
  duplicateGroups: QADuplicateGroup[];
}

interface BuildSummary {
  outputDir: string;
  seedCount: number;
  sourceCount: number;
  rejectedCount: number;
  duplicateCount: number;
}

const USDA_NUTRIENTS = {
  calories: 1008,
  protein: 1003,
  carbs: 1005,
  fat: 1004,
} as const;

const AUSNUT_HEADER_MATCHERS = {
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

function roundNumber(value: number): number {
  return Math.round(value * 100) / 100;
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

function buildQualityScore(record: Omit<SeedStagingRecord, 'qualityScore'>): number {
  let score = 0;
  if (record.caloriesPer100g != null) score += 3;
  if (record.proteinPer100g != null && record.carbsPer100g != null && record.fatPer100g != null) {
    score += 3;
  }
  if (record.servingSizeG != null) score += 2;
  if (record.barcode) score += 1;
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
  input: Omit<SeedStagingRecord, 'qualityScore'> & { warnings?: string[] }
): SeedStagingRecord {
  const warnings = input.warnings ?? [];
  return {
    ...input,
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

  return {
    id: `${source}-${record.providerId}`,
    name: record.name,
    caloriesPer100g: record.caloriesPer100g ?? 0,
    proteinPer100g: record.proteinPer100g ?? 0,
    carbsPer100g: record.carbsPer100g ?? 0,
    fatPer100g: record.fatPer100g ?? 0,
    servingSizeG: record.servingSizeG,
    barcode: record.barcode,
    source,
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
  const groups = new Map<string, SeedStagingRecord[]>();
  for (const record of records) {
    const key = normalizedNameKey(record.name);
    const list = groups.get(key) ?? [];
    list.push(record);
    groups.set(key, list);
  }

  const deduped: SeedStagingRecord[] = [];
  const duplicateGroups: QADuplicateGroup[] = [];
  for (const [normalizedName, group] of groups.entries()) {
    group.sort(compareRecords);
    deduped.push(group[0]);
    if (group.length > 1) {
      duplicateGroups.push({
        normalizedName,
        keptId: group[0].providerId,
        droppedIds: group.slice(1).map((record) => record.providerId),
      });
    }
  }

  deduped.sort((left, right) => left.name.localeCompare(right.name));
  duplicateGroups.sort((left, right) => left.normalizedName.localeCompare(right.normalizedName));

  return { records: deduped, duplicateGroups };
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

function chooseBestServing(
  servings: { grams: number; description: string | null }[]
): { grams: number; description: string | null } | null {
  if (servings.length === 0) return null;
  const sorted = [...servings].sort((left, right) => left.grams - right.grams);
  return sorted[0];
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

  const servingsByFood = new Map<string, { grams: number; description: string | null }>();
  for await (const row of streamCsv(portionPath)) {
    const fdcId = row.fdc_id;
    const grams = parseNumber(row.gram_weight);
    if (!fdcId || grams == null || grams <= 0) continue;
    const serving = {
      grams: roundNumber(grams),
      description: row.portion_description || row.modifier || null,
    };
    const currentBest = servingsByFood.get(fdcId);
    if (!currentBest || serving.grams < currentBest.grams) {
      servingsByFood.set(fdcId, serving);
    }
  }

  const foundation: ParsedSource = {
    sourceId: 'usda-foundation',
    provider: 'usda',
    releaseDate: null,
    license: 'USDA FoodData Central public domain',
    inputFiles: [foodPath, nutrientPath, portionPath],
    stagingRecords: [],
    rejectedRows: [],
  };
  const legacy: ParsedSource = {
    sourceId: 'usda-sr-legacy',
    provider: 'usda',
    releaseDate: null,
    license: 'USDA FoodData Central public domain',
    inputFiles: [foodPath, nutrientPath, portionPath],
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
    const serving = servingsByFood.get(providerId) ?? null;

    const record = createStagingRecord({
      provider,
      providerId,
      name: normalizeDisplayName(row.description ?? ''),
      brandName: null,
      region: 'us',
      caloriesPer100g: nutrients.calories != null ? roundNumber(nutrients.calories) : null,
      proteinPer100g: nutrients.protein != null ? roundNumber(nutrients.protein) : null,
      carbsPer100g: nutrients.carbs != null ? roundNumber(nutrients.carbs) : null,
      fatPer100g: nutrients.fat != null ? roundNumber(nutrients.fat) : null,
      servingSizeG: serving?.grams ?? null,
      servingDescription: serving?.description ?? null,
      barcode: null,
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

async function parseAusnutDirectory(ausnutDir: string): Promise<ParsedSource[]> {
  const files = await listWorkbookFiles(ausnutDir);
  const detailsPath = findWorkbook(files, [/food details/i], 'AUSNUT food details');
  const nutrientsPath = findWorkbook(
    files,
    [/food nutrient profiles/i, /food nutrients/i],
    'AUSNUT food nutrient profiles'
  );
  const measuresPath = findWorkbook(files, [/food measures/i], 'AUSNUT food measures');

  const detailsRows = readWorkbookRows(detailsPath);
  const nutrientRows = readWorkbookRows(nutrientsPath);
  const measureRows = readWorkbookRows(measuresPath);

  const nutrientsByFood = new Map<
    string,
    { calories: number | null; protein: number | null; carbs: number | null; fat: number | null }
  >();
  for (const row of nutrientRows) {
    const providerId = String(valueForHeader(row, AUSNUT_HEADER_MATCHERS.foodId) ?? '').trim();
    if (!providerId) continue;
    const caloriesKj = parseNumber(valueForHeader(row, AUSNUT_HEADER_MATCHERS.energyKj));
    const protein = parseNumber(valueForHeader(row, AUSNUT_HEADER_MATCHERS.protein));
    const carbs = parseNumber(valueForHeader(row, AUSNUT_HEADER_MATCHERS.carbs));
    const fat = parseNumber(valueForHeader(row, AUSNUT_HEADER_MATCHERS.fat));

    nutrientsByFood.set(providerId, {
      calories: caloriesKj != null ? roundNumber(caloriesKj * 0.239005736) : null,
      protein,
      carbs,
      fat,
    });
  }

  const servingsByFood = new Map<string, { grams: number; description: string | null }[]>();
  for (const row of measureRows) {
    const providerId = String(valueForHeader(row, AUSNUT_HEADER_MATCHERS.foodId) ?? '').trim();
    const grams = parseNumber(valueForHeader(row, AUSNUT_HEADER_MATCHERS.gramWeight));
    if (!providerId || grams == null || grams <= 0) continue;
    const description =
      String(valueForHeader(row, AUSNUT_HEADER_MATCHERS.measureDescription) ?? '').trim() || null;
    const list = servingsByFood.get(providerId) ?? [];
    list.push({ grams: roundNumber(grams), description });
    servingsByFood.set(providerId, list);
  }

  const parsed: ParsedSource = {
    sourceId: 'ausnut-2023',
    provider: 'ausnut',
    releaseDate: null,
    license: 'FSANZ AUSNUT 2023 site terms; redistribution confirmation required separately',
    inputFiles: [detailsPath, nutrientsPath, measuresPath],
    stagingRecords: [],
    rejectedRows: [],
  };

  for (const row of detailsRows) {
    const providerId = String(valueForHeader(row, AUSNUT_HEADER_MATCHERS.foodId) ?? '').trim();
    const rawName = String(valueForHeader(row, AUSNUT_HEADER_MATCHERS.foodName) ?? '').trim();
    if (!providerId || !rawName) continue;

    const nutrients = nutrientsByFood.get(providerId) ?? {
      calories: null,
      protein: null,
      carbs: null,
      fat: null,
    };
    const serving = chooseBestServing(servingsByFood.get(providerId) ?? []);

    const record = createStagingRecord({
      provider: 'ausnut',
      providerId,
      name: normalizeDisplayName(rawName),
      brandName: null,
      region: 'au',
      caloriesPer100g: nutrients.calories,
      proteinPer100g: nutrients.protein,
      carbsPer100g: nutrients.carbs,
      fatPer100g: nutrients.fat,
      servingSizeG: serving?.grams ?? null,
      servingDescription: serving?.description ?? null,
      barcode: null,
      sourceUpdatedAt: null,
      warnings: [],
    });

    const rejectionReason = shouldRejectRecord(record);
    if (rejectionReason) {
      parsed.rejectedRows.push({
        provider: 'ausnut',
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
    const providerId = String(valueForHeader(row, AUSNUT_HEADER_MATCHERS.foodId) ?? '').trim();
    if (!providerId) continue;
    const caloriesKj = parseNumber(valueForHeader(row, AUSNUT_HEADER_MATCHERS.energyKj));
    const protein = parseNumber(valueForHeader(row, AUSNUT_HEADER_MATCHERS.protein));
    const carbs = parseNumber(valueForHeader(row, AUSNUT_HEADER_MATCHERS.carbs));
    const fat = parseNumber(valueForHeader(row, AUSNUT_HEADER_MATCHERS.fat));

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
    const providerId = String(valueForHeader(row, AUSNUT_HEADER_MATCHERS.foodId) ?? '').trim();
    const rawName = String(valueForHeader(row, AUSNUT_HEADER_MATCHERS.foodName) ?? '').trim();
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
      region: 'au',
      caloriesPer100g: nutrients.calories,
      proteinPer100g: nutrients.protein,
      carbsPer100g: nutrients.carbs,
      fatPer100g: nutrients.fat,
      servingSizeG: null,
      servingDescription: null,
      barcode: null,
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

async function buildManifest(
  sources: ParsedSource[],
  seedFoods: SeedFood[],
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
      stagingRecordCount: source.stagingRecords.length,
      rejectedRowCount: source.rejectedRows.length,
    }))
  );

  return {
    generatedAt,
    stagingSchemaVersion: 1,
    sources: manifestSources,
    totals: {
      stagingRecordCount: sources.reduce((sum, source) => sum + source.stagingRecords.length, 0),
      seedCount: seedFoods.length,
      rejectedRowCount: sources.reduce((sum, source) => sum + source.rejectedRows.length, 0),
      duplicateGroupCount: duplicateGroups.length,
    },
  };
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
    if (arg === '--ausnut-dir' && next) {
      options.ausnutDir = next;
      index += 1;
      continue;
    }
    if (arg === '--afcd-dir' && next) {
      options.afcdDir = next;
      index += 1;
      continue;
    }
    if (arg === '--output-dir' && next) {
      options.outputDir = next;
      index += 1;
      continue;
    }
  }

  if (!options.usdaDir || !options.ausnutDir || !options.outputDir) {
    throw new Error(
      'Usage: npm run build:food-seed -- --usda-dir <path> --ausnut-dir <path> [--afcd-dir <path>] [--output-dir <path>]'
    );
  }

  return options as FoodSeedBuildArgs;
}

export async function buildFoodSeedArtifacts(args: FoodSeedBuildArgs): Promise<BuildSummary> {
  const generatedAt = new Date().toISOString();
  const sources = [
    ...(await parseUsdaDirectory(args.usdaDir)),
    ...(await parseAusnutDirectory(args.ausnutDir)),
    ...(args.afcdDir ? await parseAfcdDirectory(args.afcdDir) : []),
  ];
  const stagingRecords = sources.flatMap((source) => source.stagingRecords);
  const rejectedRows = sources.flatMap((source) => source.rejectedRows);
  const { records: dedupedRecords, duplicateGroups } = dedupeSeedRecords(stagingRecords);
  const seedFoods = dedupedRecords.map((record) => buildSeedFood(record, generatedAt));
  const manifest = await buildManifest(sources, seedFoods, duplicateGroups, generatedAt);
  const qaReport: SeedQAReport = {
    generatedAt,
    counts: {
      stagingRecords: stagingRecords.length,
      emittedFoods: seedFoods.length,
      rejectedRows: rejectedRows.length,
      duplicateGroups: duplicateGroups.length,
    },
    rejectedRows,
    duplicateGroups,
  };

  await fs.mkdir(args.outputDir, { recursive: true });
  await Promise.all([
    fs.writeFile(
      path.join(args.outputDir, 'foods.seed.json'),
      `${JSON.stringify(seedFoods, null, 2)}\n`,
      'utf8'
    ),
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
    seedCount: seedFoods.length,
    sourceCount: sources.length,
    rejectedCount: rejectedRows.length,
    duplicateCount: duplicateGroups.length,
  };
}

export const testExports = {
  createCsvRowParser,
  parseCsv,
  normalizeDisplayName,
  normalizedNameKey,
  dedupeSeedRecords,
  createStagingRecord,
  buildSeedFood,
  parseAfcdDirectory,
  createManifestFileCollector,
  readManifestFileInfo,
  readWorkbookRows,
  sha256,
};
