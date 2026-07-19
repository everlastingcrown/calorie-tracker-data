import type { SeedCompatibility, SeedRelease } from './types.ts';
import { seedCompression } from './compression.ts';

export interface SeedVersionIndex {
  schemaVersion: 1;
  updatedAt: string;
  latestVerified: string | null;
  versions: SeedRelease[];
}

export function createSeedRelease(input: {
  semver: string;
  compatibility: SeedCompatibility;
  runAt: string;
  verified: boolean;
}): SeedRelease {
  if (!/^\d+\.\d+\.\d+$/.test(input.semver)) {
    throw new Error('Seed semver must use MAJOR.MINOR.PATCH.');
  }
  const parsedRunAt = new Date(input.runAt);
  if (Number.isNaN(parsedRunAt.valueOf()) || parsedRunAt.toISOString() !== input.runAt) {
    throw new Error('Seed runAt must be a canonical ISO 8601 UTC timestamp.');
  }

  const runId = input.runAt.replace(/[-:]/g, '').replace('.000', '');
  const versionId = `${input.semver}+${runId}`;
  const releaseTag = `food-seed-v${input.semver}-${runId}`;

  return {
    versionId,
    semver: input.semver,
    compatibility: input.compatibility,
    runAt: input.runAt,
    verified: input.verified,
    releaseTag,
    compression: seedCompression,
    assets: {
      generic: 'foods.seed.json.gz',
      brandedTemplate: 'foods-{country}.branded.json.gz',
      manifest: 'foods.manifest.json',
    },
  };
}

export function updateSeedVersionIndex(
  current: SeedVersionIndex | null,
  release: SeedRelease,
  repository: string
): SeedVersionIndex {
  if (!/^[^/]+\/[^/]+$/.test(repository)) {
    throw new Error('Repository must use owner/name format.');
  }
  const baseUrl =
    `https://github.com/${repository}/releases/download/` +
    encodeURIComponent(release.releaseTag);
  const publishedRelease: SeedRelease = {
    ...release,
    assets: {
      generic: `${baseUrl}/${release.assets.generic}`,
      brandedTemplate: `${baseUrl}/${release.assets.brandedTemplate}`,
      manifest: `${baseUrl}/${release.assets.manifest}`,
    },
  };
  const versions = [
    ...(current?.versions ?? []).filter((item) => item.versionId !== release.versionId),
    publishedRelease,
  ].sort((left, right) => right.runAt.localeCompare(left.runAt));
  const latestVerified = versions.find((item) => item.verified)?.versionId ?? null;

  return {
    schemaVersion: 1,
    updatedAt: release.runAt,
    latestVerified,
    versions,
  };
}

export function parseSeedVersionIndex(value: unknown): SeedVersionIndex {
  const index = value as Partial<SeedVersionIndex>;
  if (index.schemaVersion !== 1 || !Array.isArray(index.versions)) {
    throw new Error('Unsupported seed version index.');
  }
  return index as SeedVersionIndex;
}
