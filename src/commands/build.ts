import { BuildOptions, RepoMapState } from '../types';
import { discoverSourceFiles } from '../core/files';
import { buildGraph } from '../core/graph';
import { buildFileIndex } from '../core/indexer';
import { loadState, saveGraph, saveState } from '../core/state';
import { loadModulePathResolver } from '../core/tsconfig';
import { logVerbose } from '../utils/log';

export interface BuildSummary {
  command: 'build';
  totalSourceFiles: number;
  parsedFiles: number;
  reusedFiles: number;
  totalNodes: number;
  totalEdges: number;
  generatedAt: string;
}

export async function runBuild(options: BuildOptions): Promise<BuildSummary> {
  logVerbose(options.verbose, `[build] scanning source files in ${options.rootDir}`);
  const sourceFiles = await discoverSourceFiles(options.rootDir, options.ignore);

  const existingState = await loadState(options.rootDir);
  const existingRecords = existingState?.files ?? {};

  logVerbose(options.verbose, `[build] discovered ${sourceFiles.length} supported files`);
  const indexResult = await buildFileIndex(sourceFiles, existingRecords, options.maxWorkers);

  const state: RepoMapState = {
    version: 1,
    generatedAt: new Date().toISOString(),
    repoRoot: options.rootDir,
    files: indexResult.files,
  };

  const modulePathResolver = loadModulePathResolver(options.rootDir, options.verbose);
  const graph = buildGraph(state.files, { modulePathResolver });

  await saveState(options.rootDir, state);
  await saveGraph(options.rootDir, graph);

  const summary: BuildSummary = {
    command: 'build',
    totalSourceFiles: sourceFiles.length,
    parsedFiles: indexResult.parsedFiles,
    reusedFiles: indexResult.reusedFiles,
    totalNodes: graph.order,
    totalEdges: graph.size,
    generatedAt: state.generatedAt,
  };

  return summary;
}
