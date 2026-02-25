import * as fs from 'fs/promises';
import * as path from 'path';

import { ContextBundle, ContextOptions, RankedFile } from '../types';
import { listChangedFiles } from '../core/git';
import { rankFiles } from '../core/ranker';
import { loadGraph, loadState } from '../core/state';
import { logVerbose } from '../utils/log';
import { normalizeRepoPath } from '../utils/path';

const CONTRACT_PATTERN = /(api|route|router|controller|handler|schema|contract|dto|migration|openapi|proto)/i;
const GUARDRAIL_PATTERN = /(test|spec|auth|permission|security|policy|payment|billing|migration)/i;

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function normalizeTarget(rootDir: string, target: string): string {
  const normalized = normalizeRepoPath(target);
  if (path.isAbsolute(normalized)) {
    return normalizeRepoPath(path.relative(rootDir, normalized));
  }
  return normalized;
}

function selectByPattern(items: RankedFile[], pattern: RegExp, limit: number): RankedFile[] {
  const out: RankedFile[] = [];
  for (const item of items) {
    if (!pattern.test(item.file)) {
      continue;
    }
    out.push(item);
    if (out.length >= limit) {
      break;
    }
  }
  return out;
}

export async function runContext(options: ContextOptions): Promise<ContextBundle> {
  const [state, graph] = await Promise.all([loadState(options.rootDir), loadGraph(options.rootDir)]);
  if (!state || !graph) {
    throw new Error('repomap index not found. run `repomap build` first.');
  }

  const explicitTargets = unique(options.targetFiles.map((item) => normalizeTarget(options.rootDir, item)));
  const changedTargets = explicitTargets.length
    ? []
    : await listChangedFiles(options.rootDir, options.diffRange);

  const seedFiles = unique([...explicitTargets, ...changedTargets]).filter((file) => file in state.files);

  logVerbose(
    options.verbose,
    `[context] seeds=${seedFiles.length}, diffRange=${options.diffRange ?? 'HEAD'}`,
  );

  const ranked = rankFiles(graph, state.files, seedFiles, Math.max(options.topK * 4, options.topK));
  const rankedByFile = new Map(ranked.map((item) => [item.file, item]));

  const primary: RankedFile[] = [];
  for (const seed of seedFiles) {
    const rankedSeed = rankedByFile.get(seed);
    if (rankedSeed) {
      primary.push(rankedSeed);
      continue;
    }

    primary.push({
      file: seed,
      score: 0,
      features: {
        ppr: 0,
        risk: 0,
        boundaryImpact: 0,
        testGap: 0,
        freshness: 0,
      },
      reasons: ['seed-file'],
    });
  }

  const seedSet = new Set(seedFiles);
  const nonSeed = ranked.filter((item) => !seedSet.has(item.file));

  const causal = nonSeed.slice(0, options.topK);
  const contract = selectByPattern(nonSeed, CONTRACT_PATTERN, Math.max(5, Math.ceil(options.topK / 2)));
  const guardrail = selectByPattern(nonSeed, GUARDRAIL_PATTERN, Math.max(5, Math.ceil(options.topK / 2)));

  const bundle: ContextBundle = {
    metadata: {
      generatedAt: new Date().toISOString(),
      rootDir: options.rootDir,
      diffRange: options.diffRange,
      topK: options.topK,
      seedFiles,
      totalRankedFiles: ranked.length,
    },
    primary,
    causal,
    contract,
    guardrail,
  };

  if (options.outputPath) {
    const output = path.isAbsolute(options.outputPath)
      ? options.outputPath
      : path.join(options.rootDir, options.outputPath);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
    logVerbose(options.verbose, `[context] wrote ${output}`);
  }

  return bundle;
}
