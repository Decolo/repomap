import * as path from 'path';

export function normalizeRepoPath(value: string): string {
  return value.split(path.sep).join('/');
}
