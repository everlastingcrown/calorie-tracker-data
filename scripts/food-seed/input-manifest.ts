import { promises as fs } from 'node:fs';

export interface FoodSeedManifestFile {
  id: string;
  url: string;
  sha256?: string;
  fileName: string;
  extract?: 'zip';
}

export interface FoodSeedManifestLicense {
  name: string;
  url: string;
  attribution: string;
  notes?: string;
}

export interface FoodSeedManifestSource {
  id: string;
  provider: 'usda' | 'afcd' | 'openfoodfacts';
  title: string;
  version: string;
  enabled: boolean;
  outputDir: string;
  license: FoodSeedManifestLicense;
  notes?: string;
  files: FoodSeedManifestFile[];
}

export interface FoodSeedInputManifest {
  schemaVersion: 2;
  seedVersion: {
    semver: string;
    compatibility: 'compatible' | 'non-backward-compatible';
  };
  sources: FoodSeedManifestSource[];
}

export async function readFoodSeedInputManifest(
  manifestPath: string
): Promise<FoodSeedInputManifest> {
  const raw = await fs.readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(raw) as FoodSeedInputManifest;

  if (manifest.schemaVersion !== 2) {
    throw new Error(`Unsupported manifest schema version: ${manifest.schemaVersion}`);
  }

  if (!/^\d+\.\d+\.\d+$/.test(manifest.seedVersion?.semver)) {
    throw new Error('Manifest seedVersion.semver must use MAJOR.MINOR.PATCH.');
  }
  if (
    manifest.seedVersion.compatibility !== 'compatible' &&
    manifest.seedVersion.compatibility !== 'non-backward-compatible'
  ) {
    throw new Error(
      'Manifest seedVersion.compatibility must be compatible or non-backward-compatible.'
    );
  }

  for (const source of manifest.sources) {
    if (!source.id || !source.outputDir) {
      throw new Error('Manifest source entries must include id and outputDir.');
    }
    if (!source.license?.name || !source.license.url || !source.license.attribution) {
      throw new Error(`Manifest source ${source.id} must include license name, url, and attribution.`);
    }
    for (const file of source.files) {
      if (file.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(file.sha256)) {
        throw new Error(`Manifest file ${source.id}/${file.id} has an invalid sha256.`);
      }
    }
  }

  return manifest;
}
