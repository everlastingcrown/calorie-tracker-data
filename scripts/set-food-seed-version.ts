#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  readFoodSeedInputManifest,
  updateFoodSeedVersion,
  type SemanticReleaseType,
} from './food-seed/input-manifest.ts';

async function main(): Promise<void> {
  const [semver, releaseType, manifestArg] = process.argv.slice(2);
  if (!semver || !releaseType) {
    throw new Error(
      'Usage: set-food-seed-version <MAJOR.MINOR.PATCH> <major|minor|patch> [manifest.json]'
    );
  }

  const manifestPath = manifestArg ?? path.join(process.cwd(), 'inputs', 'manifest.json');
  const manifest = await readFoodSeedInputManifest(manifestPath);
  const updated = updateFoodSeedVersion(
    manifest,
    semver,
    releaseType as SemanticReleaseType
  );
  await fs.writeFile(manifestPath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `Updated food seed version to ${updated.seedVersion.semver} ` +
      `(${updated.seedVersion.compatibility}).\n`
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
