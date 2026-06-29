import { createReadStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

export interface CsvRowParser {
  push(chunk: string): string[][];
  finish(): string[][];
}

export function createCsvRowParser(): CsvRowParser {
  let currentField = '';
  let currentRow: string[] = [];
  let inQuotes = false;
  let pendingQuote = false;
  let skipLeadingLineFeed = false;

  const parseChunk = (chunk: string, isFinalChunk: boolean): string[][] => {
    const rows: string[][] = [];
    let index = 0;

    if (skipLeadingLineFeed && chunk[0] === '\n') {
      index = 1;
    }
    skipLeadingLineFeed = false;

    for (; index < chunk.length; index += 1) {
      const char = chunk[index];
      const next = chunk[index + 1];

      if (pendingQuote) {
        pendingQuote = false;
        if (char === '"') {
          currentField += '"';
          continue;
        }
        inQuotes = !inQuotes;
      }

      if (char === '"') {
        if (inQuotes && next === '"') {
          currentField += '"';
          index += 1;
        } else if (next == null) {
          pendingQuote = true;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }

      if (!inQuotes && char === ',') {
        currentRow.push(currentField);
        currentField = '';
        continue;
      }

      if (!inQuotes && (char === '\n' || char === '\r')) {
        if (char === '\r' && next === '\n') {
          index += 1;
        } else if (char === '\r' && next == null) {
          skipLeadingLineFeed = true;
        }
        currentRow.push(currentField);
        rows.push(currentRow);
        currentField = '';
        currentRow = [];
        continue;
      }

      currentField += char;
    }

    if (isFinalChunk && pendingQuote) {
      pendingQuote = false;
      inQuotes = !inQuotes;
    }

    if (isFinalChunk && (currentField.length > 0 || currentRow.length > 0)) {
      currentRow.push(currentField);
      rows.push(currentRow);
      currentField = '';
      currentRow = [];
    }

    return rows;
  };

  return {
    push(chunk: string) {
      return parseChunk(chunk, false);
    },
    finish() {
      return parseChunk('', true);
    },
  };
}

export function mapCsvRows(rows: string[][]): Record<string, string>[] {
  if (rows.length === 0) return [];
  const headers = rows[0].map((header) => header.trim());
  return rows
    .slice(1)
    .filter((row) => row.some((field) => field.trim() !== ''))
    .map((row) => {
      const record: Record<string, string> = {};
      headers.forEach((header, index) => {
        record[header] = row[index]?.trim() ?? '';
      });
      return record;
    });
}

export function parseCsv(text: string): Record<string, string>[] {
  const parser = createCsvRowParser();
  const rows = [...parser.push(text), ...parser.finish()];
  return mapCsvRows(rows);
}

export async function* streamCsv(filePath: string): AsyncGenerator<Record<string, string>, void, void> {
  const parser = createCsvRowParser();
  const decoder = new StringDecoder('utf8');
  const stream = createReadStream(filePath);
  let headers: string[] | null = null;

  const emitRows = async function* (rows: string[][]): AsyncGenerator<Record<string, string>> {
    for (const row of rows) {
      if (!headers) {
        headers = row.map((header) => header.trim());
        continue;
      }
      if (!row.some((field) => field.trim() !== '')) continue;
      const record: Record<string, string> = {};
      headers.forEach((header, index) => {
        record[header] = row[index]?.trim() ?? '';
      });
      yield record;
    }
  };

  for await (const chunk of stream) {
    const rows = parser.push(decoder.write(chunk));
    yield* emitRows(rows);
  }

  const rows = [...parser.push(decoder.end()), ...parser.finish()];
  yield* emitRows(rows);
}
