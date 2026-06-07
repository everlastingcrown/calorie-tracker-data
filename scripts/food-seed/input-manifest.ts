import { promises as fs } from 'node:fs';

export interface FoodSeedManifestFile {
  id: string;
  url: string;
  sha256: string;
  fileName: string;
  extract?: 'zip';
}

export interface FoodSeedManifestSource {
  id: string;
  provider: 'usda' | 'afcd' | 'openfoodfacts';
  title: string;
  version: string;
  enabled: boolean;
  outputDir: string;
  notes?: string;
  files: FoodSeedManifestFile[];
}

export interface FoodSeedInputManifest {
  schemaVersion: 1;
  releaseTag: string;
  sources: FoodSeedManifestSource[];
}

export async function readFoodSeedInputManifest(
  manifestPath: string
): Promise<FoodSeedInputManifest> {
  const raw = await fs.readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(raw) as FoodSeedInputManifest;

  if (manifest.schemaVersion !== 1) {
    throw new Error(`Unsupported manifest schema version: ${manifest.schemaVersion}`);
  }

  for (const source of manifest.sources) {
    if (!source.id || !source.outputDir) {
      throw new Error('Manifest source entries must include id and outputDir.');
    }
    for (const file of source.files) {
      if (!/^[a-f0-9]{64}$/.test(file.sha256)) {
        throw new Error(`Manifest file ${source.id}/${file.id} has an invalid sha256.`);
      }
    }
  }

  return manifest;
}
