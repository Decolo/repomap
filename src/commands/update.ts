import { BuildOptions, FileRecord, RepoMapState, UpdateOptions } from '../types';
import { discoverSourceFiles } from '../core/files';
import { listChangedFiles, listDeletedFiles } from '../core/git';
import { buildGraph } from '../core/graph';
import { buildFileIndex } from '../core/indexer';
import { loadState, saveGraph, saveState } from '../core/state';
import { loadModulePathResolver } from '../core/tsconfig';
import { logVerbose } from '../utils/log';

export interface UpdateSummary {
  command: 'update';
  diffRange?: string;
  changedFiles: number;
  deletedFiles: number;
  parsedFiles: number;
  reusedFiles: number;
  trackedFiles: number;
  totalNodes: number;
  totalEdges: number;
  generatedAt: string;
}

function toBuildOptions(options: UpdateOptions): BuildOptions {
  return {
    rootDir: options.rootDir,
    ignore: options.ignore,
    maxWorkers: options.maxWorkers,
    verbose: options.verbose,
  };
}

export async function runUpdate(options: UpdateOptions): Promise<UpdateSummary> {
  const existingState = await loadState(options.rootDir);
  if (!existingState) {
    logVerbose(options.verbose, '[update] no state found. running full build');
    const { runBuild } = await import('./build');
    const summary = await runBuild(toBuildOptions(options));
    return {
      command: 'update',
      diffRange: options.diffRange,
      changedFiles: summary.totalSourceFiles,
      deletedFiles: 0,
      parsedFiles: summary.parsedFiles,
      reusedFiles: summary.reusedFiles,
      trackedFiles: summary.totalSourceFiles,
      totalNodes: summary.totalNodes,
      totalEdges: summary.totalEdges,
      generatedAt: summary.generatedAt,
    };
  }

  const sourceFiles = await discoverSourceFiles(options.rootDir, options.ignore);
  const changed = await listChangedFiles(options.rootDir, options.diffRange);
  const deleted = await listDeletedFiles(options.rootDir, options.diffRange);

  const sourceByRelPath = new Map(sourceFiles.map((file) => [file.relPath, file]));
  const changedSet = new Set(changed);

  const parseCandidates = sourceFiles.filter(
    (file) => changedSet.has(file.relPath) || !(file.relPath in existingState.files),
  );

  logVerbose(
    options.verbose,
    `[update] changed=${changed.length}, deleted=${deleted.length}, parseCandidates=${parseCandidates.length}`,
  );

  const indexed = await buildFileIndex(parseCandidates, existingState.files, options.maxWorkers);

  const nextFiles: Record<string, FileRecord> = { ...existingState.files };

  for (const relPath of Object.keys(nextFiles)) {
    if (!sourceByRelPath.has(relPath) || deleted.includes(relPath)) {
      delete nextFiles[relPath];
    }
  }

  for (const [relPath, record] of Object.entries(indexed.files)) {
    nextFiles[relPath] = record;
  }

  const state: RepoMapState = {
    version: existingState.version,
    repoRoot: existingState.repoRoot,
    generatedAt: new Date().toISOString(),
    files: nextFiles,
  };

  const modulePathResolver = loadModulePathResolver(options.rootDir, options.verbose);
  const graph = buildGraph(state.files, { modulePathResolver });
  await saveState(options.rootDir, state);
  await saveGraph(options.rootDir, graph);

  return {
    command: 'update',
    diffRange: options.diffRange,
    changedFiles: changed.length,
    deletedFiles: deleted.length,
    parsedFiles: indexed.parsedFiles,
    reusedFiles: indexed.reusedFiles,
    trackedFiles: Object.keys(nextFiles).length,
    totalNodes: graph.order,
    totalEdges: graph.size,
    generatedAt: state.generatedAt,
  };
}
