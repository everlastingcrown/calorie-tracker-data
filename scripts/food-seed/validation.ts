import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createGunzip } from 'node:zlib';
import type { SeedFood, SeedManifest, SeedQAReport } from './types.ts';

export type ValidationStatus = 'pass' | 'fail';

export interface ValidationCheck {
  asset: string;
  category: 'integrity' | 'schema' | 'content';
  status: ValidationStatus;
  summary: string;
  errors: string[];
}

export interface FoodSeedValidationReport {
  schemaVersion: 1;
  generatedAt: string;
  status: ValidationStatus;
  summary: {
    assetsChecked: number;
    recordsChecked: number;
    checksPassed: number;
    checksFailed: number;
  };
  dataQuality: SeedQAReport['counts'];
  assets: { file: string; kind: 'generic' | 'branded'; records: number }[];
  checks: ValidationCheck[];
}

const REQUIRED_FOOD_FIELDS = [
  'id',
  'name',
  'brandName',
  'countryCode',
  'caloriesPer100g',
  'proteinPer100g',
  'carbsPer100g',
  'fatPer100g',
  'servingSizeG',
  'servingQuantity',
  'servingUnit',
  'servingDescription',
  'servingWeightsG',
  'servingSizes',
  'barcode',
  'barcodes',
  'source',
  'license',
  'sourceUpdatedAt',
  'quality',
  'qualityScore',
  'createdAt',
] as const;

const MAX_REPORTED_ERRORS = 20;

function pushError(errors: string[], message: string): void {
  if (errors.length < MAX_REPORTED_ERRORS) errors.push(message);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateFoodSchema(value: unknown, recordLabel: string, errors: string[]): value is SeedFood {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    pushError(errors, `${recordLabel}: expected an object`);
    return false;
  }

  const record = value as Record<string, unknown>;
  const missing = REQUIRED_FOOD_FIELDS.filter((field) => !(field in record));
  if (missing.length > 0) {
    pushError(errors, `${recordLabel}: missing fields ${missing.join(', ')}`);
    return false;
  }

  const stringFields = ['id', 'name', 'source', 'license', 'quality', 'createdAt'] as const;
  const nullableStringFields = [
    'brandName',
    'countryCode',
    'servingUnit',
    'servingDescription',
    'barcode',
    'sourceUpdatedAt',
  ] as const;
  const numberFields = [
    'caloriesPer100g',
    'proteinPer100g',
    'carbsPer100g',
    'fatPer100g',
    'qualityScore',
  ] as const;
  const nullableNumberFields = ['servingSizeG', 'servingQuantity'] as const;

  for (const field of stringFields) {
    if (typeof record[field] !== 'string') pushError(errors, `${recordLabel}.${field}: expected string`);
  }
  for (const field of nullableStringFields) {
    if (!isNullableString(record[field])) {
      pushError(errors, `${recordLabel}.${field}: expected string or null`);
    }
  }
  for (const field of numberFields) {
    if (!isFiniteNumber(record[field])) pushError(errors, `${recordLabel}.${field}: expected finite number`);
  }
  for (const field of nullableNumberFields) {
    if (record[field] !== null && !isFiniteNumber(record[field])) {
      pushError(errors, `${recordLabel}.${field}: expected finite number or null`);
    }
  }
  if (!record.servingWeightsG || typeof record.servingWeightsG !== 'object' || Array.isArray(record.servingWeightsG)) {
    pushError(errors, `${recordLabel}.servingWeightsG: expected object`);
  } else if (Object.values(record.servingWeightsG).some((item) => !isFiniteNumber(item))) {
    pushError(errors, `${recordLabel}.servingWeightsG: expected finite number values`);
  }
  if (!Array.isArray(record.servingSizes)) {
    pushError(errors, `${recordLabel}.servingSizes: expected array`);
  } else {
    for (const [index, item] of record.servingSizes.entries()) {
      const serving = item as Record<string, unknown> | null;
      if (
        !serving ||
        !isFiniteNumber(serving.grams) ||
        (serving.quantity !== null && !isFiniteNumber(serving.quantity)) ||
        !isNullableString(serving.unit) ||
        !isNullableString(serving.description) ||
        typeof serving.source !== 'string' ||
        typeof serving.quality !== 'string' ||
        !isFiniteNumber(serving.confidence)
      ) {
        pushError(errors, `${recordLabel}.servingSizes[${index}]: invalid serving schema`);
      }
    }
  }
  if (!Array.isArray(record.barcodes) || record.barcodes.some((item) => typeof item !== 'string')) {
    pushError(errors, `${recordLabel}.barcodes: expected string array`);
  }

  return errors.length === 0;
}

function validateFoodContent(
  food: SeedFood,
  recordLabel: string,
  kind: 'generic' | 'branded',
  countryCode: string | null,
  errors: string[]
): void {
  if (!food.id.trim()) pushError(errors, `${recordLabel}.id: must not be blank`);
  if (!food.name.trim()) pushError(errors, `${recordLabel}.name: must not be blank`);
  if (!food.license.trim()) pushError(errors, `${recordLabel}.license: must not be blank`);
  if (!['high', 'medium', 'low'].includes(food.quality)) {
    pushError(errors, `${recordLabel}.quality: unsupported value ${food.quality}`);
  }

  const nutrients = [
    ['caloriesPer100g', food.caloriesPer100g, 9_000],
    ['proteinPer100g', food.proteinPer100g, 100],
    ['carbsPer100g', food.carbsPer100g, 100],
    ['fatPer100g', food.fatPer100g, 100],
  ] as const;
  for (const [field, value, maximum] of nutrients) {
    if (value < 0 || value > maximum) {
      pushError(errors, `${recordLabel}.${field}: ${value} is outside 0..${maximum}`);
    }
  }

  if (kind === 'generic') {
    if (food.brandName !== null) pushError(errors, `${recordLabel}.brandName: generic food must be unbranded`);
    if (!['usda', 'afcd'].includes(food.source)) {
      pushError(errors, `${recordLabel}.source: generic food must come from USDA or AFCD`);
    }
  } else {
    if (food.source !== 'openfoodfacts') {
      pushError(errors, `${recordLabel}.source: branded food must come from Open Food Facts`);
    }
    if (food.countryCode !== countryCode) {
      pushError(errors, `${recordLabel}.countryCode: expected ${countryCode}, got ${food.countryCode}`);
    }
    if (food.brandName !== null && !food.brandName.trim()) {
      pushError(errors, `${recordLabel}.brandName: must be null or non-blank`);
    }
  }
}

async function* readJsonObjectArray(filePath: string): AsyncGenerator<unknown> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  let state: 'before' | 'between' | 'value' | 'done' = 'before';
  let buffer = '';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for await (const chunk of stream) {
    for (const character of chunk) {
      if (state === 'before') {
        if (/\s/.test(character)) continue;
        if (character !== '[') throw new Error('expected a top-level JSON array');
        state = 'between';
        continue;
      }
      if (state === 'done') {
        if (!/\s/.test(character)) throw new Error('unexpected data after JSON array');
        continue;
      }
      if (state === 'between') {
        if (/\s/.test(character) || character === ',') continue;
        if (character === ']') {
          state = 'done';
          continue;
        }
        if (character !== '{') throw new Error('expected an object in JSON array');
        state = 'value';
        buffer = character;
        depth = 1;
        inString = false;
        escaped = false;
        continue;
      }

      buffer += character;
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === '{' || character === '[') depth += 1;
      else if (character === '}' || character === ']') depth -= 1;

      if (depth === 0) {
        yield JSON.parse(buffer) as unknown;
        buffer = '';
        state = 'between';
      }
    }
  }

  if (state !== 'done') throw new Error('incomplete JSON array');
}

async function hashStream(stream: NodeJS.ReadableStream): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

async function validateIntegrity(filePath: string): Promise<string[]> {
  const errors: string[] = [];
  const compressedPath = `${filePath}.gz`;
  try {
    await fs.access(compressedPath);
    const [plainHash, compressedContentHash] = await Promise.all([
      hashStream(createReadStream(filePath)),
      hashStream(createReadStream(compressedPath).pipe(createGunzip())),
    ]);
    if (plainHash !== compressedContentHash) errors.push('gzip content does not match plain JSON');
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors;
}

function check(
  asset: string,
  category: ValidationCheck['category'],
  errors: string[],
  passedSummary: string
): ValidationCheck {
  return {
    asset,
    category,
    status: errors.length === 0 ? 'pass' : 'fail',
    summary: errors.length === 0 ? passedSummary : `${errors.length} error(s)`,
    errors,
  };
}

function renderMarkdown(report: FoodSeedValidationReport): string {
  const icon = report.status === 'pass' ? 'PASS' : 'FAIL';
  const lines = [
    '# Food Seed Validation Report',
    '',
    `**Overall: ${icon}**`,
    '',
    `- Release: \`${report.generatedAt}\``,
    `- Assets checked: ${report.summary.assetsChecked}`,
    `- Records checked: ${report.summary.recordsChecked}`,
    `- Checks: ${report.summary.checksPassed} passed, ${report.summary.checksFailed} failed`,
    `- Rejected source rows: ${report.dataQuality.rejectedRows}`,
    `- Duplicate groups resolved: ${report.dataQuality.duplicateGroups}`,
    `- Food quality: ${report.dataQuality.quality.high} high, ${report.dataQuality.quality.medium} medium, ${report.dataQuality.quality.low} low, ${report.dataQuality.quality.missing} missing`,
    '',
    '| Result | Asset | Category | Summary |',
    '| --- | --- | --- | --- |',
    ...report.checks.map(
      (item) => `| ${item.status.toUpperCase()} | \`${item.asset}\` | ${item.category} | ${item.summary} |`
    ),
  ];

  const failures = report.checks.filter((item) => item.status === 'fail');
  if (failures.length > 0) {
    lines.push('', '## Failures', '');
    for (const failure of failures) {
      lines.push(`### ${failure.asset}: ${failure.category}`, '');
      for (const error of failure.errors) lines.push(`- ${error}`);
      lines.push('');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export async function validateFoodSeedArtifacts(outputDir: string): Promise<FoodSeedValidationReport> {
  const manifest = JSON.parse(
    await fs.readFile(path.join(outputDir, 'foods.manifest.json'), 'utf8')
  ) as SeedManifest;
  const qa = JSON.parse(
    await fs.readFile(path.join(outputDir, 'foods.qa.json'), 'utf8')
  ) as SeedQAReport;
  const files = (await fs.readdir(outputDir))
    .filter((file) => file === 'foods.seed.json' || /^foods-[a-z0-9-]+\.branded\.json$/.test(file))
    .sort();
  const checks: ValidationCheck[] = [];
  const assets: FoodSeedValidationReport['assets'] = [];

  for (const file of files) {
    const kind = file === 'foods.seed.json' ? 'generic' : 'branded';
    const countryCode = kind === 'branded' ? file.match(/^foods-([a-z0-9-]+)\./)?.[1] ?? null : null;
    const filePath = path.join(outputDir, file);
    checks.push(check(file, 'integrity', await validateIntegrity(filePath), 'JSON and gzip are readable and identical'));

    const schemaErrors: string[] = [];
    const contentErrors: string[] = [];
    let records = 0;
    try {
      for await (const value of readJsonObjectArray(filePath)) {
        records += 1;
        const label = `record ${records}`;
        const recordSchemaErrors: string[] = [];
        if (validateFoodSchema(value, label, recordSchemaErrors)) {
          validateFoodContent(value, label, kind, countryCode, contentErrors);
        } else {
          for (const error of recordSchemaErrors) pushError(schemaErrors, error);
        }
      }
    } catch (error) {
      pushError(schemaErrors, error instanceof Error ? error.message : String(error));
    }
    assets.push({ file, kind, records });
    checks.push(check(file, 'schema', schemaErrors, `${records} records match the seed schema`));
    checks.push(check(file, 'content', contentErrors, `${records} records pass content checks`));
  }

  const reconciliationErrors: string[] = [];
  const genericRecords = assets.find((asset) => asset.kind === 'generic')?.records ?? 0;
  const brandedRecords = assets
    .filter((asset) => asset.kind === 'branded')
    .reduce((sum, asset) => sum + asset.records, 0);
  if (files.length === 0) reconciliationErrors.push('no seed assets found');
  if (genericRecords !== manifest.totals.genericSeedCount) {
    reconciliationErrors.push(`generic count ${genericRecords} does not match manifest ${manifest.totals.genericSeedCount}`);
  }
  if (brandedRecords !== manifest.totals.brandedSeedCount) {
    reconciliationErrors.push(`branded count ${brandedRecords} does not match manifest ${manifest.totals.brandedSeedCount}`);
  }
  if (genericRecords + brandedRecords !== manifest.totals.seedCount) {
    reconciliationErrors.push(`total count ${genericRecords + brandedRecords} does not match manifest ${manifest.totals.seedCount}`);
  }
  if (qa.counts.genericFoods !== genericRecords || qa.counts.brandedFoods !== brandedRecords) {
    reconciliationErrors.push('QA generic/branded counts do not match validated assets');
  }
  checks.push(check('foods.manifest.json / foods.qa.json', 'integrity', reconciliationErrors, 'artifact counts reconcile'));

  const checksFailed = checks.filter((item) => item.status === 'fail').length;
  const report: FoodSeedValidationReport = {
    schemaVersion: 1,
    generatedAt: manifest.generatedAt,
    status: checksFailed === 0 ? 'pass' : 'fail',
    summary: {
      assetsChecked: assets.length,
      recordsChecked: genericRecords + brandedRecords,
      checksPassed: checks.length - checksFailed,
      checksFailed,
    },
    dataQuality: qa.counts,
    assets,
    checks,
  };

  await Promise.all([
    fs.writeFile(path.join(outputDir, 'foods.validation.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
    fs.writeFile(path.join(outputDir, 'foods.validation.md'), renderMarkdown(report), 'utf8'),
  ]);
  return report;
}
