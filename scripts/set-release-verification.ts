#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  parseSeedVersionIndex,
  setSeedReleaseVerification,
} from './food-seed/release-manifest.ts';
import type { FoodSeedValidationReport } from './food-seed/validation.ts';
import type { SeedManifest } from './food-seed/types.ts';

async function main(): Promise<void> {
  const [indexPath, manifestPath, validationPath, state, outputPath, changedAt] =
    process.argv.slice(2);
  if (
    !indexPath ||
    !manifestPath ||
    !validationPath ||
    !state ||
    !outputPath ||
    !changedAt ||
    !['verified', 'unverified'].includes(state)
  ) {
    throw new Error(
      'Usage: set-release-verification <index.json> <manifest.json> <validation.json> ' +
        '<verified|unverified> <output.json> <changed-at>'
    );
  }

  const [indexValue, manifestValue, validationValue] = await Promise.all([
    fs.readFile(indexPath, 'utf8').then(JSON.parse),
    fs.readFile(manifestPath, 'utf8').then(JSON.parse),
    fs.readFile(validationPath, 'utf8').then(JSON.parse),
  ]);
  const manifest = manifestValue as SeedManifest;
  if (!manifest.release) {
    throw new Error('Release manifest is missing release metadata.');
  }

  const updated = setSeedReleaseVerification(
    parseSeedVersionIndex(indexValue),
    manifest.release,
    validationValue as FoodSeedValidationReport,
    state === 'verified',
    changedAt
  );
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
