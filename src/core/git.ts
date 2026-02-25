import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

function normalizePath(value: string): string {
  return value.split('\\').join('/');
}

async function runGit(rootDir: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd: rootDir });
  return result.stdout.trim();
}

export async function listChangedFiles(rootDir: string, diffRange?: string): Promise<string[]> {
  const changed = new Set<string>();

  const diffArgs = diffRange
    ? ['diff', '--name-only', '--diff-filter=ACMRTUXB', diffRange]
    : ['diff', '--name-only', '--diff-filter=ACMRTUXB', 'HEAD'];

  const diffOutput = await runGit(rootDir, diffArgs);
  for (const line of diffOutput.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) {
      changed.add(normalizePath(trimmed));
    }
  }

  if (!diffRange) {
    const untrackedOutput = await runGit(rootDir, ['ls-files', '--others', '--exclude-standard']);
    for (const line of untrackedOutput.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) {
        changed.add(normalizePath(trimmed));
      }
    }
  }

  return Array.from(changed).sort((a, b) => a.localeCompare(b));
}

export async function listDeletedFiles(rootDir: string, diffRange?: string): Promise<string[]> {
  const diffArgs = diffRange
    ? ['diff', '--name-only', '--diff-filter=D', diffRange]
    : ['diff', '--name-only', '--diff-filter=D', 'HEAD'];

  const diffOutput = await runGit(rootDir, diffArgs);
  return diffOutput
    .split('\n')
    .map((line) => normalizePath(line.trim()))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}
