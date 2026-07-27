import type { IndexedSeedRelease, SeedCompatibility, SeedRelease } from './types.ts';
import type { FoodSeedValidationReport } from './validation.ts';
import { seedCompression } from './compression.ts';

export interface SeedVersionIndex {
  schemaVersion: 1;
  updatedAt: string;
  latestVerified: string | null;
  versions: IndexedSeedRelease[];
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
  repository: string,
  genericAssetSha256: string
): SeedVersionIndex {
  if (!/^[^/]+\/[^/]+$/.test(repository)) {
    throw new Error('Repository must use owner/name format.');
  }
  if (!/^[a-f0-9]{64}$/.test(genericAssetSha256)) {
    throw new Error('Generic seed asset SHA-256 must be 64 lowercase hexadecimal characters.');
  }
  const baseUrl =
    `https://github.com/${repository}/releases/download/` +
    encodeURIComponent(release.releaseTag);
  const publishedRelease: IndexedSeedRelease = {
    ...release,
    assets: {
      generic: `${baseUrl}/${release.assets.generic}`,
      brandedTemplate: `${baseUrl}/${release.assets.brandedTemplate}`,
      manifest: `${baseUrl}/${release.assets.manifest}`,
      sha256: genericAssetSha256,
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
  for (const version of index.versions) {
    if (!/^[a-f0-9]{64}$/.test(version?.assets?.sha256 ?? '')) {
      throw new Error(
        `Seed version ${version?.versionId ?? '<unknown>'} has a missing or invalid assets.sha256.`
      );
    }
  }
  return index as SeedVersionIndex;
}

export async function backfillSeedVersionIndexDigests(
  value: unknown,
  readSha256: (url: string) => Promise<string>
): Promise<SeedVersionIndex> {
  const index = value as Partial<SeedVersionIndex>;
  if (index.schemaVersion !== 1 || !Array.isArray(index.versions)) {
    throw new Error('Unsupported seed version index.');
  }

  const versions: IndexedSeedRelease[] = [];
  for (const version of index.versions) {
    if (/^[a-f0-9]{64}$/.test(version?.assets?.sha256 ?? '')) {
      versions.push(version);
      continue;
    }
    if (version?.assets?.sha256 !== undefined) {
      throw new Error(
        `Seed version ${version?.versionId ?? '<unknown>'} has an invalid assets.sha256.`
      );
    }
    if (typeof version?.assets?.generic !== 'string') {
      throw new Error(
        `Seed version ${version?.versionId ?? '<unknown>'} is missing its generic asset URL.`
      );
    }
    versions.push({
      ...version,
      assets: {
        ...version.assets,
        sha256: await readSha256(version.assets.generic),
      },
    });
  }

  return parseSeedVersionIndex({ ...index, versions });
}
