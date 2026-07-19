#!/usr/bin/env node

import path from 'node:path';
import { readFoodSeedInputManifest } from './food-seed/input-manifest.ts';
import { createSeedRelease } from './food-seed/release-manifest.ts';

async function main(): Promise<void> {
  const manifestPath = process.argv[2] ?? path.join(process.cwd(), 'inputs', 'manifest.json');
  const manifest = await readFoodSeedInputManifest(manifestPath);
  const release = createSeedRelease({
    ...manifest.seedVersion,
    runAt: process.env.FOOD_SEED_RUN_AT ?? new Date().toISOString(),
    verified: process.env.FOOD_SEED_VERIFIED === 'true',
  });
  process.stdout.write(`${release.releaseTag}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
