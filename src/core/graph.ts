import * as path from 'path';

import { MultiDirectedGraph } from 'graphology';

import { FileRecord } from '../types';
import { ModulePathResolver } from './tsconfig';

const FILE_NODE_PREFIX = 'file:';
const SYMBOL_NODE_PREFIX = 'sym:';

const RESOLVABLE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.d.ts',
] as const;

interface DefinitionEntry {
  symbolId: string;
  ownerFile: string;
  symbolName: string;
}

interface ResolvedImportBinding {
  ownerFile: string | null;
  localName: string;
  importedName: string;
  isTypeOnly: boolean;
  unresolved: boolean;
  line?: number;
}

export interface BuildGraphOptions {
  modulePathResolver?: ModulePathResolver | null;
}

function normalizeRepoPath(value: string): string {
  return value.split(path.sep).join('/');
}

function encodeKeyPart(value: string): string {
  return encodeURIComponent(value);
}

function fileNodeId(relPath: string): string {
  return `${FILE_NODE_PREFIX}${relPath}`;
}

function symbolNodeId(relPath: string, name: string, line: number): string {
  return `${SYMBOL_NODE_PREFIX}${encodeKeyPart(relPath)}:${encodeKeyPart(name)}:${line}`;
}

function isTestFile(relPath: string): boolean {
  return /(^|\/)(test|tests|__tests__)\//.test(relPath) || /(test|spec)\.(py|js|jsx|mjs|cjs|ts|tsx|mts|cts)$/.test(relPath);
}

function pushUniqueBinding(
  arr: ResolvedImportBinding[],
  binding: ResolvedImportBinding,
): void {
  const key = `${binding.ownerFile ?? 'null'}|${binding.localName}|${binding.importedName}|${binding.line ?? ''}|${binding.isTypeOnly ? '1' : '0'}|${binding.unresolved ? '1' : '0'}`;
  for (const existing of arr) {
    const existingKey = `${existing.ownerFile ?? 'null'}|${existing.localName}|${existing.importedName}|${existing.line ?? ''}|${existing.isTypeOnly ? '1' : '0'}|${existing.unresolved ? '1' : '0'}`;
    if (existingKey === key) {
      return;
    }
  }
  arr.push(binding);
}

function addEdge(
  graph: MultiDirectedGraph,
  source: string,
  target: string,
  relation: string,
  attributes: Record<string, unknown>,
): void {
  const key = [
    relation,
    encodeKeyPart(source),
    encodeKeyPart(target),
    encodeKeyPart(String(attributes.symbol ?? '')),
    encodeKeyPart(String(attributes.localSymbol ?? '')),
    encodeKeyPart(String(attributes.line ?? '')),
    encodeKeyPart(String(attributes.ownerFile ?? '')),
    encodeKeyPart(String(attributes.resolution ?? '')),
  ].join('|');

  if (graph.hasEdge(key)) {
    return;
  }

  graph.addDirectedEdgeWithKey(key, source, target, {
    relation,
    ...attributes,
  });
}

function buildDefinitions(
  records: Record<string, FileRecord>,
  graph: MultiDirectedGraph,
): {
  byName: Map<string, DefinitionEntry[]>;
  byFileAndName: Map<string, Map<string, DefinitionEntry[]>>;
} {
  const byName = new Map<string, DefinitionEntry[]>();
  const byFileAndName = new Map<string, Map<string, DefinitionEntry[]>>();

  const files = Object.keys(records).sort((a, b) => a.localeCompare(b));
  for (const relPath of files) {
    const record = records[relPath];
    const fileNode = fileNodeId(relPath);

    if (!graph.hasNode(fileNode)) {
      graph.addNode(fileNode, {
        kind: 'file',
        path: relPath,
        language: record.language,
        isTest: isTestFile(relPath),
      });
    }

    for (const tag of record.tags) {
      if (tag.kind !== 'def') {
        continue;
      }

      const symId = symbolNodeId(relPath, tag.name, tag.line);
      if (!graph.hasNode(symId)) {
        graph.addNode(symId, {
          kind: 'symbol',
          name: tag.name,
          ownerFile: relPath,
          line: tag.line,
          symbolType: tag.type,
        });
      }

      addEdge(graph, fileNode, symId, 'defines', {
        symbol: tag.name,
        line: tag.line,
        symbolType: tag.type,
        ownerFile: relPath,
        confidence: 'high',
        resolution: 'definition',
      });

      const defEntry: DefinitionEntry = {
        symbolId: symId,
        ownerFile: relPath,
        symbolName: tag.name,
      };

      const defsByName = byName.get(tag.name) ?? [];
      defsByName.push(defEntry);
      byName.set(tag.name, defsByName);

      let namesInFile = byFileAndName.get(relPath);
      if (!namesInFile) {
        namesInFile = new Map<string, DefinitionEntry[]>();
        byFileAndName.set(relPath, namesInFile);
      }
      const defsInFile = namesInFile.get(tag.name) ?? [];
      defsInFile.push(defEntry);
      namesInFile.set(tag.name, defsInFile);
    }
  }

  return { byName, byFileAndName };
}

function candidatePaths(baseWithoutExt: string): string[] {
  const out: string[] = [];
  for (const ext of RESOLVABLE_EXTENSIONS) {
    out.push(`${baseWithoutExt}${ext}`);
  }
  for (const ext of RESOLVABLE_EXTENSIONS) {
    out.push(`${baseWithoutExt}/index${ext}`);
  }
  return out;
}

function resolveImportTargets(
  sourceFile: string,
  moduleSpecifier: string,
  allFiles: Set<string>,
  modulePathResolver?: ModulePathResolver | null,
): string[] {
  const results = new Set<string>();
  const sourceDir = path.posix.dirname(sourceFile);

  const tryBase = (basePath: string): void => {
    const normalized = normalizeRepoPath(path.posix.normalize(basePath));
    if (allFiles.has(normalized)) {
      results.add(normalized);
    }
    const ext = path.posix.extname(normalized);
    if (ext.length > 0) {
      return;
    }
    for (const candidate of candidatePaths(normalized)) {
      if (allFiles.has(candidate)) {
        results.add(candidate);
      }
    }
  };

  if (moduleSpecifier.startsWith('.')) {
    tryBase(path.posix.join(sourceDir, moduleSpecifier));
    return Array.from(results);
  }

  if (modulePathResolver) {
    const candidates = modulePathResolver.resolve(sourceFile, moduleSpecifier);
    for (const candidate of candidates) {
      tryBase(candidate);
    }
  }

  // Support direct repo-like paths e.g. packages/foo/src/bar
  tryBase(moduleSpecifier);
  return Array.from(results);
}

function buildImportLookup(
  records: Record<string, FileRecord>,
  modulePathResolver?: ModulePathResolver | null,
): Map<string, Map<string, ResolvedImportBinding[]>> {
  const allFiles = new Set(Object.keys(records));
  const lookup = new Map<string, Map<string, ResolvedImportBinding[]>>();

  for (const [sourceFile, record] of Object.entries(records)) {
    const localMap = new Map<string, ResolvedImportBinding[]>();

    for (const binding of record.imports ?? []) {
      const byLocal = localMap.get(binding.localName) ?? [];
      const targets = resolveImportTargets(sourceFile, binding.moduleSpecifier, allFiles, modulePathResolver);

      if (targets.length === 0) {
        pushUniqueBinding(byLocal, {
          ownerFile: null,
          localName: binding.localName,
          importedName: binding.importedName,
          isTypeOnly: binding.isTypeOnly,
          unresolved: true,
          line: binding.line,
        });
      } else {
        for (const ownerFile of targets) {
          pushUniqueBinding(byLocal, {
            ownerFile,
            localName: binding.localName,
            importedName: binding.importedName,
            isTypeOnly: binding.isTypeOnly,
            unresolved: false,
            line: binding.line,
          });
        }
      }

      localMap.set(binding.localName, byLocal);
    }

    lookup.set(sourceFile, localMap);
  }

  return lookup;
}

export function buildGraph(
  records: Record<string, FileRecord>,
  options: BuildGraphOptions = {},
): MultiDirectedGraph {
  const graph = new MultiDirectedGraph();
  const { byName: definitionsByName, byFileAndName: definitionsByFileAndName } = buildDefinitions(records, graph);
  const importLookupByFile = buildImportLookup(records, options.modulePathResolver);

  const files = Object.keys(records).sort((a, b) => a.localeCompare(b));

  for (const relPath of files) {
    const record = records[relPath];
    const sourceFileNode = fileNodeId(relPath);
    const importLookup = importLookupByFile.get(relPath) ?? new Map<string, ResolvedImportBinding[]>();

    // File-level dependency should be created from import declarations even when
    // query-based reference capture misses a usage shape.
    for (const [localName, importedBindings] of importLookup.entries()) {
      for (const binding of importedBindings) {
        if (!binding.ownerFile || binding.ownerFile === relPath) {
          continue;
        }

        const targetFileNode = fileNodeId(binding.ownerFile);
        const attrs: Record<string, unknown> = {
          symbol: binding.importedName,
          localSymbol: localName,
          ownerFile: binding.ownerFile,
          confidence: 'import_only',
          resolution: 'import_declaration',
        };
        if (typeof binding.line === 'number' && Number.isFinite(binding.line)) {
          attrs.line = binding.line;
        }

        addEdge(graph, sourceFileNode, targetFileNode, 'depends_on', attrs);
      }
    }

    for (const tag of record.tags) {
      if (tag.kind !== 'ref') {
        continue;
      }

      const importedBindings = importLookup.get(tag.name);
      if (importedBindings && importedBindings.length > 0) {
        for (const binding of importedBindings) {
          if (!binding.ownerFile) {
            continue;
          }

          const targetFileNode = fileNodeId(binding.ownerFile);
          const targetDefsByName = definitionsByFileAndName.get(binding.ownerFile);

          let expectedName = binding.importedName;
          if (expectedName === 'default') {
            expectedName = tag.name;
          }

          const matchingDefs =
            expectedName === '*'
              ? []
              : targetDefsByName?.get(expectedName) ?? [];

          if (matchingDefs.length === 0) {
            if (binding.ownerFile !== relPath) {
              addEdge(graph, sourceFileNode, targetFileNode, 'depends_on', {
                symbol: expectedName,
                localSymbol: tag.name,
                line: tag.line,
                ownerFile: binding.ownerFile,
                confidence: 'import_only',
                resolution: 'import',
              });
            }
            continue;
          }

          for (const def of matchingDefs) {
            addEdge(graph, sourceFileNode, def.symbolId, 'references', {
              symbol: expectedName,
              localSymbol: tag.name,
              line: tag.line,
              ownerFile: def.ownerFile,
              confidence: 'high',
              resolution: 'import',
            });

            if (def.ownerFile !== relPath) {
              addEdge(graph, sourceFileNode, targetFileNode, 'depends_on', {
                symbol: expectedName,
                localSymbol: tag.name,
                line: tag.line,
                ownerFile: def.ownerFile,
                confidence: 'high',
                resolution: 'import',
              });

              if (isTestFile(relPath)) {
                addEdge(graph, sourceFileNode, targetFileNode, 'test_covers', {
                  symbol: expectedName,
                  localSymbol: tag.name,
                  line: tag.line,
                  ownerFile: def.ownerFile,
                  confidence: 'high',
                  resolution: 'import',
                });
              }
            }
          }
        }

        // Import binding exists. Do not fallback to global same-name matching.
        continue;
      }

      const defs = definitionsByName.get(tag.name);
      if (!defs || defs.length === 0) {
        continue;
      }

      for (const def of defs) {
        addEdge(graph, sourceFileNode, def.symbolId, 'references', {
          symbol: tag.name,
          localSymbol: tag.name,
          line: tag.line,
          ownerFile: def.ownerFile,
          confidence: 'fallback',
          resolution: 'name_match',
        });

        const targetFileNode = fileNodeId(def.ownerFile);
        if (!graph.hasNode(targetFileNode)) {
          continue;
        }

        if (def.ownerFile !== relPath) {
          addEdge(graph, sourceFileNode, targetFileNode, 'depends_on', {
            symbol: tag.name,
            localSymbol: tag.name,
            line: tag.line,
            ownerFile: def.ownerFile,
            confidence: 'fallback',
            resolution: 'name_match',
          });

          if (isTestFile(relPath)) {
            addEdge(graph, sourceFileNode, targetFileNode, 'test_covers', {
              symbol: tag.name,
              localSymbol: tag.name,
              line: tag.line,
              ownerFile: def.ownerFile,
              confidence: 'fallback',
              resolution: 'name_match',
            });
          }
        }
      }
    }
  }

  return graph;
}

export function getFileNodeId(relPath: string): string {
  return fileNodeId(relPath);
}

export function isFileNode(nodeId: string): boolean {
  return nodeId.startsWith(FILE_NODE_PREFIX);
}

export function getFilePathFromNode(graph: MultiDirectedGraph, nodeId: string): string | null {
  if (!graph.hasNode(nodeId)) {
    return null;
  }
  const attrs = graph.getNodeAttributes(nodeId) as Record<string, unknown>;
  return typeof attrs.path === 'string' ? attrs.path : null;
}
