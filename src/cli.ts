#!/usr/bin/env node

import * as path from 'path';

import { runBuild } from './commands/build';
import { runContext } from './commands/context';
import { runTrace } from './commands/trace';
import { runUpdate } from './commands/update';
import { runViz } from './commands/viz';
import { runSymbol } from './commands/symbol';
import {
  DEFAULT_MAX_WORKERS,
  DEFAULT_TOP_K,
  DEFAULT_VIZ_HOPS,
  DEFAULT_VIZ_MAX_NODES,
} from './core/constants';
import {
  parseArgs,
  readBooleanOption,
  readIntOption,
  readStringArrayOption,
  readStringOption,
} from './utils/args';

function parseCsvOptions(values: string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const parts = value.split(',');
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.length > 0) {
        out.push(trimmed);
      }
    }
  }
  return out;
}

function printHelp(): void {
  console.log(`repomap - repository graph indexer for code review

Usage:
  repomap build [--root <dir>] [--max-workers <n>] [--ignore <glob>] [--verbose]
  repomap update [--root <dir>] [--diff <range>] [--max-workers <n>] [--ignore <glob>] [--verbose]
  repomap context [--root <dir>] [--diff <range>] [--target <file>] [--top <n>] [--output <path>] [--verbose]
  repomap trace --root <dir> --target <file> [--limit <n>] [--format <json|md>] [--output <path>] [--verbose]
  repomap symbol --root <dir> --target <file> --name <symbol> [--limit <n>] [--format <json|md>] [--output <path>] [--verbose]
  repomap viz [--root <dir>] [--target <file-or-dir>] [--relation <a,b>] [--hops <n>] [--max-nodes <n>] [--output <path>] [--verbose]

Examples:
  repomap build --root . --max-workers 6
  repomap update --diff origin/main...HEAD
  repomap context --diff origin/main...HEAD --top 40 --output .repomap/context.json
  repomap trace --target packages/ai/src/generate-text/generate-text.ts --format md --output .repomap/trace.md
  repomap symbol --target packages/ai/src/types/usage.ts --name LanguageModelUsage --format md --output .repomap/symbol.md
  repomap viz --target src/app.js --hops 2 --output .repomap/viz.html
  repomap viz --target packages/ai --hops 2 --output .repomap/viz.html
  repomap viz --target packages/ai --relation depends_on,references --hops 1 --max-nodes 220

Notes:
  supported source languages in this build: python, javascript, typescript, tsx
  viz relations (current): defines, references, depends_on, test_covers
`);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.command || parsed.command === 'help' || parsed.command === '--help') {
    printHelp();
    return;
  }

  const rootDir = path.resolve(readStringOption(parsed.options, 'root') ?? process.cwd());
  const maxWorkers = readIntOption(parsed.options, 'max-workers', DEFAULT_MAX_WORKERS);
  const ignore = readStringArrayOption(parsed.options, 'ignore');
  const verbose = readBooleanOption(parsed.options, 'verbose');

  if (parsed.command === 'build') {
    const summary = await runBuild({
      rootDir,
      maxWorkers,
      ignore,
      verbose,
    });
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (parsed.command === 'update') {
    const summary = await runUpdate({
      rootDir,
      maxWorkers,
      ignore,
      verbose,
      diffRange: readStringOption(parsed.options, 'diff'),
    });
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (parsed.command === 'context') {
    const bundle = await runContext({
      rootDir,
      topK: readIntOption(parsed.options, 'top', DEFAULT_TOP_K),
      diffRange: readStringOption(parsed.options, 'diff'),
      targetFiles: readStringArrayOption(parsed.options, 'target'),
      outputPath: readStringOption(parsed.options, 'output'),
      verbose,
    });
    console.log(JSON.stringify(bundle, null, 2));
    return;
  }

  if (parsed.command === 'viz') {
    const summary = await runViz({
      rootDir,
      targetFiles: readStringArrayOption(parsed.options, 'target'),
      relationFilters: parseCsvOptions(readStringArrayOption(parsed.options, 'relation')),
      hops: readIntOption(parsed.options, 'hops', DEFAULT_VIZ_HOPS),
      maxNodes: readIntOption(parsed.options, 'max-nodes', DEFAULT_VIZ_MAX_NODES),
      outputPath: readStringOption(parsed.options, 'output'),
      verbose,
    });
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (parsed.command === 'trace') {
    const targetFile = readStringOption(parsed.options, 'target');
    if (!targetFile) {
      throw new Error('trace requires --target <file>');
    }

    const formatRaw = readStringOption(parsed.options, 'format') ?? 'json';
    const format = formatRaw === 'md' ? 'md' : 'json';

    const result = await runTrace({
      rootDir,
      targetFile,
      limit: readIntOption(parsed.options, 'limit', 80),
      format,
      outputPath: readStringOption(parsed.options, 'output'),
      verbose,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (parsed.command === 'symbol') {
    const targetFile = readStringOption(parsed.options, 'target');
    if (!targetFile) {
      throw new Error('symbol requires --target <file>');
    }

    const symbolName = readStringOption(parsed.options, 'name');
    if (!symbolName) {
      throw new Error('symbol requires --name <symbol>');
    }

    const formatRaw = readStringOption(parsed.options, 'format') ?? 'json';
    const format = formatRaw === 'md' ? 'md' : 'json';

    const result = await runSymbol({
      rootDir,
      targetFile,
      symbolName,
      limit: readIntOption(parsed.options, 'limit', 80),
      format,
      outputPath: readStringOption(parsed.options, 'output'),
      verbose,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  throw new Error(`unknown command: ${parsed.command}`);
}

main().catch((error) => {
  console.error(`[repomap] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
