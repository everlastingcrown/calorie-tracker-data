import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createGzip, constants } from 'node:zlib';

export const seedCompression = {
  codec: 'gzip',
  mediaType: 'application/gzip',
  fileExtension: '.gz',
} as const;

export async function compressSeedAsset(inputPath: string): Promise<string> {
  const outputPath = `${inputPath}${seedCompression.fileExtension}`;
  await pipeline(
    createReadStream(inputPath),
    createGzip({ level: constants.Z_BEST_COMPRESSION }),
    createWriteStream(outputPath)
  );
  return outputPath;
}
