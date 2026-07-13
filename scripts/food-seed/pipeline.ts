import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createCsvRowParser, parseCsv } from './csv.ts';
import {
  PipelineDiagnostics,
  dedupeAccumulatorGroupCount,
  sourceCounts,
} from './diagnostics.ts';
import {
  parseAfcdDirectory,
  parseOpenFoodFactsDirectory,
  parseOpenFoodFactsServing,
  parseUsdaDirectory,
  readWorkbookRows,
} from './source-parsers.ts';
import {
  buildServingSizes,
  isPlausibleServingGrams,
  servingWeightsFromSizes,
} from './serving-sizes.ts';
import {
  addDedupeRecord,
  buildSeedFood,
  createDedupeAccumulator,
  createManifestFileCollector,
  createStagingRecord,
  dedupeMatchKey,
  dedupeNameKey,
  dedupeSeedRecords,
  finalizeDedupeAccumulator,
  normalizeDisplayName,
  normalizedNameKey,
  parseQuantityAndUnit,
  readManifestFileInfo,
  sha256,
  writeJsonArray,
} from './shared.ts';
import type {
  BuildSummary,
  EnergyDiscrepancyReport,
  FoodSeedBuildArgs,
  ParsedSource,
  QADuplicateGroup,
  SeedManifest,
  SeedQAReport,
  SeedStagingRecord,
} from './types.ts';
export type { FoodSeedBuildArgs, SeedFood, SeedStagingRecord } from './types.ts';

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
  const diagnostics = new PipelineDiagnostics();
  const brandedAccumulator = createDedupeAccumulator();
  await diagnostics.milestone('start', {}, args.outputDir);

  const usdaSources = await parseUsdaDirectory(args.usdaDir);
  await diagnostics.milestone('usda parsed', sourceCounts(usdaSources), args.outputDir);

  const afcdSources = args.afcdDir ? await parseAfcdDirectory(args.afcdDir) : [];
  if (args.afcdDir) {
    await diagnostics.milestone(
      'afcd parsed',
      sourceCounts([...usdaSources, ...afcdSources]),
      args.outputDir
    );
  }

  const openFoodFactsSources = await parseOpenFoodFactsDirectory(args.openFoodFactsDir, {
    onStagingRecord: (record) => addDedupeRecord(brandedAccumulator, record),
    onProgress: (counts) =>
      diagnostics.progress(
        'openfoodfacts parsing',
        {
          ...counts,
          brandedGroups: dedupeAccumulatorGroupCount(brandedAccumulator),
        }
      ),
  });
  const sources = [...usdaSources, ...afcdSources, ...openFoodFactsSources];
  await diagnostics.milestone(
    'sources parsed',
    {
      ...sourceCounts(sources),
      brandedGroups: dedupeAccumulatorGroupCount(brandedAccumulator),
    },
    args.outputDir
  );

  const stagingRecords = sources.flatMap((source) => source.stagingRecords);
  const rejectedRows = sources.flatMap((source) => source.rejectedRows);
  const rejectedRowsTruncated = sources.some(
    (source) => (source.rejectedRowCount ?? source.rejectedRows.length) > source.rejectedRows.length
  );
  const energyDiscrepancies = sources.flatMap((source) => source.energyDiscrepancies ?? []);
  const genericStagingRecords = stagingRecords.filter((record) => record.provider !== 'openfoodfacts');
  const {
    records: dedupedGenericRecords,
    duplicateGroups: genericDuplicateGroups,
  } = dedupeSeedRecords(genericStagingRecords);
  const {
    records: dedupedBrandedRecords,
    duplicateGroups: brandedDuplicateGroups,
  } = finalizeDedupeAccumulator(brandedAccumulator);
  await diagnostics.milestone(
    'dedupe complete',
    {
      genericRecords: dedupedGenericRecords.length,
      brandedGroups: dedupedBrandedRecords.length,
      duplicateGroups: genericDuplicateGroups.length + brandedDuplicateGroups.length,
    },
    args.outputDir
  );
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
    rejectedRowsTruncated,
    duplicateGroups,
  };
  const energyDiscrepancyReport: EnergyDiscrepancyReport = {
    generatedAt,
    count: energyDiscrepancies.length,
    correctedCount: energyDiscrepancies.filter(
      (discrepancy) => discrepancy.resolution === 'replaced_kcal_from_kj'
    ).length,
    discrepancies: energyDiscrepancies,
  };

  await fs.mkdir(args.outputDir, { recursive: true });
  await diagnostics.milestone(
    'writing artifacts',
    {
      genericRecords: genericSeedFoods.length,
      brandedGroups: dedupedBrandedRecords.length,
      duplicateGroups: duplicateGroups.length,
      emittedFoods: genericSeedFoods.length + dedupedBrandedRecords.length,
    },
    args.outputDir
  );
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
    fs.writeFile(
      path.join(args.outputDir, 'foods.energy-discrepancies.json'),
      `${JSON.stringify(energyDiscrepancyReport, null, 2)}\n`,
      'utf8'
    ),
  ]);
  await diagnostics.milestone(
    'complete',
    {
      stagingRecords: stagingRecordCount,
      rejectedRows: rejectedRowCount,
      genericRecords: genericSeedFoods.length,
      brandedGroups: dedupedBrandedRecords.length,
      duplicateGroups: duplicateGroups.length,
      emittedFoods: genericSeedFoods.length + dedupedBrandedRecords.length,
    },
    args.outputDir
  );

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
  createDedupeAccumulator,
  addDedupeRecord,
  dedupeAccumulatorGroupCount,
  finalizeDedupeAccumulator,
  createStagingRecord,
  buildSeedFood,
  parseUsdaDirectory,
  parseAfcdDirectory,
  parseOpenFoodFactsDirectory,
  parseOpenFoodFactsServing,
  parseQuantityAndUnit,
  buildServingSizes,
  isPlausibleServingGrams,
  servingWeightsFromSizes,
  createManifestFileCollector,
  readManifestFileInfo,
  readWorkbookRows,
  parseBuildArgs,
  buildFoodSeedArtifacts,
  sha256,
};
