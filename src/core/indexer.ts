import * as fs from 'fs/promises';

import { FileRecord } from '../types';
import { SourceFile } from './files';
import { hashContent } from './hash';
import { mapLimit } from './parallel';
import { parseFileArtifacts } from './parser';

interface ParseResult {
  relPath: string;
  record: FileRecord;
  fromCache: boolean;
}

export interface IndexBuildResult {
  files: Record<string, FileRecord>;
  parsedFiles: number;
  reusedFiles: number;
}

export async function buildFileIndex(
  sourceFiles: SourceFile[],
  existingRecords: Record<string, FileRecord>,
  maxWorkers: number,
): Promise<IndexBuildResult> {
  const results = await mapLimit(sourceFiles, maxWorkers, async (sourceFile): Promise<ParseResult> => {
    const content = await fs.readFile(sourceFile.absPath, 'utf8');
    const hash = hashContent(content);

    const cached = existingRecords[sourceFile.relPath];
    if (cached && cached.hash === hash && Array.isArray(cached.imports)) {
      return {
        relPath: sourceFile.relPath,
        record: cached,
        fromCache: true,
      };
    }

    const parsed = await parseFileArtifacts(sourceFile, content);
    return {
      relPath: sourceFile.relPath,
      record: {
        hash,
        language: sourceFile.language,
        tags: parsed.tags,
        imports: parsed.imports,
        lastParsedAt: new Date().toISOString(),
      },
      fromCache: false,
    };
  });

  const files: Record<string, FileRecord> = {};
  let parsedFiles = 0;
  let reusedFiles = 0;

  for (const result of results) {
    files[result.relPath] = result.record;
    if (result.fromCache) {
      reusedFiles += 1;
    } else {
      parsedFiles += 1;
    }
  }

  return {
    files,
    parsedFiles,
    reusedFiles,
  };
}
