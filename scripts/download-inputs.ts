#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFoodSeedInputManifest } from './food-seed/input-manifest.ts';
import type { FoodSeedInputManifest, FoodSeedManifestFile } from './food-seed/input-manifest.ts';

const execFileAsync = promisify(execFile);

interface DownloadArgs {
  manifestPath: string;
  cacheDir: string;
  outputDir: string;
  includeDisabled: boolean;
}

export function parseDownloadArgs(argv: string[]): DownloadArgs {
  const args: DownloadArgs = {
    manifestPath: path.join(process.cwd(), 'inputs', 'manifest.json'),
    cacheDir: path.join(process.cwd(), '.cache', 'food-seed-inputs'),
    outputDir: path.join(process.cwd(), 'inputs', 'food-seed'),
    includeDisabled: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === '--manifest') {
      args.manifestPath = value;
      index += 1;
    } else if (arg === '--cache-dir') {
      args.cacheDir = value;
      index += 1;
    } else if (arg === '--output-dir') {
      args.outputDir = value;
      index += 1;
    } else if (arg === '--include-disabled') {
      args.includeDisabled = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);

  for await (const chunk of stream) {
    hash.update(chunk);
  }

  return hash.digest('hex');
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function cachedFilePath(cacheDir: string, file: FoodSeedManifestFile): string {
  return path.join(cacheDir, `${file.sha256}-${file.fileName}`);
}

async function downloadFile(url: string, filePath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const bytes = new Uint8Array(await response.arrayBuffer());
  await fs.writeFile(filePath, bytes);
}

async function ensureCachedFile(cacheDir: string, file: FoodSeedManifestFile): Promise<string> {
  const cachePath = cachedFilePath(cacheDir, file);
  if (await fileExists(cachePath)) {
    const cachedSha = await hashFile(cachePath);
    if (cachedSha === file.sha256) return cachePath;
    await fs.rm(cachePath, { force: true });
  }

  process.stdout.write(`Downloading ${file.url}\n`);
  await downloadFile(file.url, cachePath);

  const actualSha = await hashFile(cachePath);
  if (actualSha !== file.sha256) {
    await fs.rm(cachePath, { force: true });
    throw new Error(
      `SHA256 mismatch for ${file.id}: expected ${file.sha256}, downloaded ${actualSha}`
    );
  }

  return cachePath;
}

async function extractZipArchive(zipPath: string, destinationDir: string): Promise<void> {
  try {
    await execFileAsync('unzip', ['-o', '-j', zipPath, '-d', destinationDir]);
  } catch {
    throw new Error('Failed to extract ZIP input with `unzip`. Install `unzip` and try again.');
  }
}

export async function downloadManifestInputs(
  manifest: FoodSeedInputManifest,
  args: DownloadArgs
): Promise<void> {
  await fs.rm(args.outputDir, { recursive: true, force: true });
  await fs.mkdir(args.outputDir, { recursive: true });

  for (const source of manifest.sources) {
    if (!source.enabled && !args.includeDisabled) {
      process.stdout.write(`Skipping disabled source ${source.id}\n`);
      continue;
    }

    const sourceOutputDir = path.join(args.outputDir, source.outputDir);
    await fs.mkdir(sourceOutputDir, { recursive: true });

    for (const file of source.files) {
      const cachePath = await ensureCachedFile(args.cacheDir, file);
      const outputPath = path.join(sourceOutputDir, file.fileName);

      await fs.copyFile(cachePath, outputPath);
      if (file.extract === 'zip') {
        process.stdout.write(`Extracting ${file.fileName} into ${sourceOutputDir}\n`);
        await extractZipArchive(outputPath, sourceOutputDir);
      }
    }
  }
}

async function main(): Promise<void> {
  const args = parseDownloadArgs(process.argv.slice(2));
  const manifest = await readFoodSeedInputManifest(args.manifestPath);

  await downloadManifestInputs(manifest, args);
  process.stdout.write(`Food seed inputs are ready in ${args.outputDir}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
