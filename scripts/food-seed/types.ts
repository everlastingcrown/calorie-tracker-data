export type Provider = 'usda_foundation' | 'usda_sr_legacy' | 'afcd' | 'openfoodfacts';

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

export interface ParsedSource {
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

export interface RejectedRow {
  provider: string;
  providerId: string;
  reason: string;
  name: string;
}

export interface QADuplicateGroup {
  normalizedName: string;
  keptId: string;
  droppedIds: string[];
}

export interface DedupeGroup {
  records: SeedStagingRecord[];
  keys: Set<string>;
}

export interface SeedManifest {
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

export interface SeedQAReport {
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
  rejectedRowsTruncated: boolean;
  duplicateGroups: QADuplicateGroup[];
}

export interface BuildSummary {
  outputDir: string;
  genericSeedCount: number;
  brandedSeedCount: number;
  sourceCount: number;
  rejectedCount: number;
  duplicateCount: number;
}

export interface DedupeAccumulator {
  groups: Set<DedupeGroup>;
  groupsByKey: Map<string, DedupeGroup>;
}

export interface OpenFoodFactsParseOptions {
  onStagingRecord?: (record: SeedStagingRecord) => void;
  onProgress?: (counts: {
    rowsRead: number;
    stagingRecords: number;
    rejectedRows: number;
  }) => void | Promise<void>;
}

export interface ServingMeasure {
  grams: number;
  quantity: number | null;
  unit: string | null;
  description: string | null;
  weightsG: Record<string, number>;
}
