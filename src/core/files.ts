import * as path from 'path';
import { glob } from 'glob';

import { DEFAULT_IGNORES, SUPPORTED_EXTENSIONS } from './constants';
import { SupportedLanguage } from '../types';
import { normalizeRepoPath } from '../utils/path';

export interface SourceFile {
  absPath: string;
  relPath: string;
  language: SupportedLanguage;
}

export function detectLanguage(filePath: string): SupportedLanguage | null {
  const ext = path.extname(filePath).toLowerCase();
  return SUPPORTED_EXTENSIONS[ext] ?? null;
}

export async function discoverSourceFiles(rootDir: string, ignore: string[]): Promise<SourceFile[]> {
  const files = await glob('**/*', {
    cwd: rootDir,
    absolute: true,
    nodir: true,
    ignore: [...DEFAULT_IGNORES, ...ignore],
  });

  const discovered: SourceFile[] = [];
  for (const absPath of files) {
    const language = detectLanguage(absPath);
    if (!language) {
      continue;
    }

    discovered.push({
      absPath,
      relPath: normalizeRepoPath(path.relative(rootDir, absPath)),
      language,
    });
  }

  discovered.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return discovered;
}
