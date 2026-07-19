#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  parseSeedVersionIndex,
  updateSeedVersionIndex,
} from './food-seed/release-manifest.ts';
import type { SeedManifest } from './food-seed/types.ts';

async function main(): Promise<void> {
  const [manifestPath, existingIndexPath, outputPath, repository] = process.argv.slice(2);
  if (!manifestPath || !existingIndexPath || !outputPath || !repository) {
    throw new Error(
      'Usage: update-release-index <foods.manifest.json> <existing-or-missing-index.json> <output.json> <owner/repo>'
    );
  }
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as SeedManifest;
  let current = null;
  try {
    current = parseSeedVersionIndex(JSON.parse(await fs.readFile(existingIndexPath, 'utf8')));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  const updated = updateSeedVersionIndex(current, manifest.release, repository);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
