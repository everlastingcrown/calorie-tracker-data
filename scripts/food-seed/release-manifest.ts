import type { SeedCompatibility, SeedRelease } from './types.ts';
import type { FoodSeedValidationReport } from './validation.ts';
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

export function setSeedReleaseVerification(
  current: SeedVersionIndex,
  release: SeedRelease,
  validation: FoodSeedValidationReport,
  verified: boolean,
  changedAt: string
): SeedVersionIndex {
  const parsedChangedAt = new Date(changedAt);
  if (Number.isNaN(parsedChangedAt.valueOf()) || parsedChangedAt.toISOString() !== changedAt) {
    throw new Error('Verification changedAt must be a canonical ISO 8601 UTC timestamp.');
  }
  if (validation.schemaVersion !== 1 || !['pass', 'fail'].includes(validation.status)) {
    throw new Error('Unsupported food seed validation report.');
  }
  if (validation.generatedAt !== release.runAt) {
    throw new Error('Validation report does not belong to the selected release.');
  }
  if (verified && validation.status !== 'pass') {
    throw new Error('A release cannot be verified unless its validation report passed.');
  }

  const target = current.versions.find((item) => item.versionId === release.versionId);
  if (!target) {
    throw new Error(`Version ${release.versionId} is not present in the release index.`);
  }
  if (target.releaseTag !== release.releaseTag || target.runAt !== release.runAt) {
    throw new Error('Release manifest does not match the indexed version.');
  }

  const versions = current.versions.map((item) =>
    item.versionId === release.versionId ? { ...item, verified } : item
  );

  return {
    ...current,
    updatedAt: changedAt,
    latestVerified: versions.find((item) => item.verified)?.versionId ?? null,
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
