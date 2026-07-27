#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  backfillSeedVersionIndexDigests,
  updateSeedVersionIndex,
} from './food-seed/release-manifest.ts';
import { hashFile } from './food-seed/shared.ts';
import type { SeedManifest } from './food-seed/types.ts';

async function main(): Promise<void> {
  const [manifestPath, genericAssetPath, existingIndexPath, outputPath, repository] =
    process.argv.slice(2);
  if (!manifestPath || !genericAssetPath || !existingIndexPath || !outputPath || !repository) {
    throw new Error(
      'Usage: update-release-index <foods.manifest.json> <foods.seed.json.gz> ' +
        '<existing-or-missing-index.json> <output.json> <owner/repo>'
    );
  }
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as SeedManifest;
  let current = null;
  try {
    current = await backfillSeedVersionIndexDigests(
      JSON.parse(await fs.readFile(existingIndexPath, 'utf8')),
      hashUrl
    );
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  const genericAssetSha256 = await hashFile(genericAssetPath);
  const updated = updateSeedVersionIndex(
    current,
    manifest.release,
    repository,
    genericAssetSha256
  );
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
}

async function hashUrl(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download retained seed asset ${url}: HTTP ${response.status}.`);
  }
  const hash = createHash('sha256');
  for await (const chunk of response.body) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
