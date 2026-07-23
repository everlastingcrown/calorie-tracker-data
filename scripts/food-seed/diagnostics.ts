import { promises as fs } from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import type { DedupeAccumulator, ParsedSource } from './types.ts';

export interface PipelineDiagnosticsOptions {
  log?: (message: string) => void;
  now?: () => number;
  minIntervalMs?: number;
  rowInterval?: number;
}

export interface PipelineProgressCounts {
  rowsRead?: number;
  stagingRecords?: number;
  rejectedRows?: number;
  genericRecords?: number;
  brandedGroups?: number;
  duplicateGroups?: number;
  emittedFoods?: number;
  nutrientCorrections?: number;
}

export class PipelineDiagnostics {
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  private readonly minIntervalMs: number;
  private readonly rowInterval: number;
  private lastLoggedAt = 0;
  private lastLoggedRows = 0;

  constructor(options: PipelineDiagnosticsOptions = {}) {
    this.log = options.log ?? ((message) => process.stderr.write(message + '\n'));
    this.now = options.now ?? (() => Date.now());
    this.minIntervalMs = options.minIntervalMs ?? 60_000;
    this.rowInterval = options.rowInterval ?? 10_000;
  }

  async milestone(
    stage: string,
    counts: PipelineProgressCounts = {},
    outputDir?: string
  ): Promise<void> {
    await this.write(stage, counts, outputDir);
  }

  async progress(
    stage: string,
    counts: PipelineProgressCounts = {},
    outputDir?: string
  ): Promise<void> {
    const rowsRead = counts.rowsRead ?? 0;
    const elapsed = this.now() - this.lastLoggedAt;
    const rowDelta = rowsRead - this.lastLoggedRows;
    if (this.lastLoggedAt > 0 && elapsed < this.minIntervalMs && rowDelta < this.rowInterval) return;
    await this.write(stage, counts, outputDir);
    this.lastLoggedAt = this.now();
    this.lastLoggedRows = rowsRead;
  }

  private async write(
    stage: string,
    counts: PipelineProgressCounts,
    outputDir?: string
  ): Promise<void> {
    const memory = process.memoryUsage();
    const heapLimit = v8.getHeapStatistics().heap_size_limit;
    const storageBytes = outputDir ? await directorySize(outputDir).catch(() => null) : null;
    const parts = [
      'timestamp=' + new Date(this.now()).toISOString(),
      'stage=' + stage,
      ...formatCounts(counts),
      'rss=' + formatBytes(memory.rss),
      'heapUsed=' + formatBytes(memory.heapUsed),
      'heapTotal=' + formatBytes(memory.heapTotal),
      'heapLimit=' + formatBytes(heapLimit),
      'external=' + formatBytes(memory.external),
    ];
    if (storageBytes != null) parts.push('storage=' + formatBytes(storageBytes));
    this.log('[food-seed] ' + parts.join(' '));
  }
}

export function sourceCounts(sources: ParsedSource[]): PipelineProgressCounts {
  return {
    stagingRecords: sources.reduce(
      (sum, source) => sum + (source.stagingRecordCount ?? source.stagingRecords.length),
      0
    ),
    rejectedRows: sources.reduce(
      (sum, source) => sum + (source.rejectedRowCount ?? source.rejectedRows.length),
      0
    ),
    nutrientCorrections: sources.reduce(
      (sum, source) => sum + (source.nutrientCorrectionCount ?? 0),
      0
    ),
  };
}

export function dedupeAccumulatorGroupCount(accumulator: DedupeAccumulator): number {
  return accumulator.groups.size;
}

function formatCounts(counts: PipelineProgressCounts): string[] {
  return Object.entries(counts)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    .map(([key, value]) => key + '=' + value);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KiB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + 'MiB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + 'GiB';
}

async function directorySize(dirPath: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(entryPath);
    } else if (entry.isFile()) {
      total += (await fs.stat(entryPath)).size;
    }
  }
  return total;
}
