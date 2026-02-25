import * as fs from 'fs/promises';
import * as path from 'path';

import { MultiDirectedGraph } from 'graphology';

import { loadGraph } from '../core/state';
import { logVerbose } from '../utils/log';
import { normalizeRepoPath } from '../utils/path';

interface SymbolOptions {
  rootDir: string;
  targetFile: string;
  symbolName: string;
  limit: number;
  format: 'json' | 'md';
  outputPath?: string;
  verbose: boolean;
}

interface SymbolDefinition {
  file: string;
  line: number;
  symbolType?: string;
}

interface SymbolUse {
  file: string;
  edgeCount: number;
  lines: number[];
  confidence: Record<string, number>;
  resolution: Record<string, number>;
}

interface SymbolResult {
  command: 'symbol';
  targetFile: string;
  symbolName: string;
  definitions: SymbolDefinition[];
  outgoing: SymbolUse[];
  incoming: SymbolUse[];
  outputPath?: string;
  format: 'json' | 'md';
}

interface MutableUse {
  file: string;
  edgeCount: number;
  lines: Set<number>;
  confidence: Map<string, number>;
  resolution: Map<string, number>;
}

function normalizeTarget(rootDir: string, target: string): string {
  const normalized = normalizeRepoPath(target);
  if (path.isAbsolute(normalized)) {
    return normalizeRepoPath(path.relative(rootDir, normalized));
  }
  return normalized;
}

function toFileNodeId(filePath: string): string {
  return `file:${filePath}`;
}

function fromFileNodeId(nodeId: string): string | null {
  if (!nodeId.startsWith('file:')) {
    return null;
  }
  return nodeId.slice('file:'.length);
}

function relationFromAttrs(attrs: unknown): string {
  const raw = (attrs as Record<string, unknown>).relation;
  return typeof raw === 'string' ? raw : 'related';
}

function symbolFromAttrs(attrs: unknown): string | null {
  const raw = (attrs as Record<string, unknown>).symbol;
  return typeof raw === 'string' ? raw : null;
}

function lineFromAttrs(attrs: unknown): number | null {
  const raw = (attrs as Record<string, unknown>).line;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

function addUse(map: Map<string, MutableUse>, file: string, attrs: unknown): void {
  let item = map.get(file);
  if (!item) {
    item = {
      file,
      edgeCount: 0,
      lines: new Set<number>(),
      confidence: new Map<string, number>(),
      resolution: new Map<string, number>(),
    };
    map.set(file, item);
  }

  item.edgeCount += 1;
  const line = lineFromAttrs(attrs);
  if (line !== null) {
    item.lines.add(line);
  }

  const confidence = (attrs as Record<string, unknown>).confidence;
  if (typeof confidence === 'string' && confidence.length > 0) {
    item.confidence.set(confidence, (item.confidence.get(confidence) ?? 0) + 1);
  }

  const resolution = (attrs as Record<string, unknown>).resolution;
  if (typeof resolution === 'string' && resolution.length > 0) {
    item.resolution.set(resolution, (item.resolution.get(resolution) ?? 0) + 1);
  }
}

function mapToObject(map: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    out[key] = value;
  }
  return out;
}

function mapToShortLabel(map: Record<string, number>): string {
  const parts = Object.entries(map)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, value]) => `${key}:${value}`);
  return parts.join(', ');
}

function finalizeUses(map: Map<string, MutableUse>, limit: number): SymbolUse[] {
  const items = Array.from(map.values()).map((item): SymbolUse => ({
    file: item.file,
    edgeCount: item.edgeCount,
    lines: Array.from(item.lines).sort((a, b) => a - b),
    confidence: mapToObject(item.confidence),
    resolution: mapToObject(item.resolution),
  }));

  items.sort((a, b) => {
    if (b.edgeCount !== a.edgeCount) {
      return b.edgeCount - a.edgeCount;
    }
    return a.file.localeCompare(b.file);
  });

  return items.slice(0, limit);
}

function collectDefinitions(graph: MultiDirectedGraph, targetFile: string, symbolName: string): SymbolDefinition[] {
  const out: SymbolDefinition[] = [];

  graph.forEachNode((nodeId, attrs) => {
    if (!nodeId.startsWith('sym:')) {
      return;
    }

    const nodeAttrs = attrs as Record<string, unknown>;
    if (nodeAttrs.kind !== 'symbol') {
      return;
    }

    if (nodeAttrs.ownerFile !== targetFile || nodeAttrs.name !== symbolName) {
      return;
    }

    const line = typeof nodeAttrs.line === 'number' ? nodeAttrs.line : null;
    if (line === null) {
      return;
    }

    out.push({
      file: targetFile,
      line,
      symbolType: typeof nodeAttrs.symbolType === 'string' ? nodeAttrs.symbolType : undefined,
    });
  });

  out.sort((a, b) => a.line - b.line);
  return out;
}

function collectSymbolUses(
  graph: MultiDirectedGraph,
  targetNodeId: string,
  symbolName: string,
  limit: number,
): { outgoing: SymbolUse[]; incoming: SymbolUse[] } {
  const outgoingMap = new Map<string, MutableUse>();
  const incomingMap = new Map<string, MutableUse>();

  graph.forEachOutEdge(targetNodeId, (_edgeId, attrs, _source, target) => {
    if (relationFromAttrs(attrs) !== 'depends_on') {
      return;
    }
    if (symbolFromAttrs(attrs) !== symbolName) {
      return;
    }

    const targetFile = fromFileNodeId(target);
    if (!targetFile) {
      return;
    }
    addUse(outgoingMap, targetFile, attrs);
  });

  graph.forEachInEdge(targetNodeId, (_edgeId, attrs, source) => {
    if (relationFromAttrs(attrs) !== 'depends_on') {
      return;
    }
    if (symbolFromAttrs(attrs) !== symbolName) {
      return;
    }

    const sourceFile = fromFileNodeId(source);
    if (!sourceFile) {
      return;
    }
    addUse(incomingMap, sourceFile, attrs);
  });

  return {
    outgoing: finalizeUses(outgoingMap, limit),
    incoming: finalizeUses(incomingMap, limit),
  };
}

function toMarkdown(result: SymbolResult): string {
  const lines: string[] = [];
  lines.push('# repomap symbol');
  lines.push('');
  lines.push(`- target: \`${result.targetFile}\``);
  lines.push(`- symbol: \`${result.symbolName}\``);
  lines.push(`- definitions: ${result.definitions.length}`);
  lines.push(`- outgoing: ${result.outgoing.length}`);
  lines.push(`- incoming: ${result.incoming.length}`);
  lines.push('');

  lines.push('## Definitions');
  if (result.definitions.length === 0) {
    lines.push('- (none found in target file)');
  } else {
    for (const def of result.definitions) {
      const kind = def.symbolType ? ` type=${def.symbolType}` : '';
      lines.push(`- \`${def.file}:${def.line}\`${kind}`);
    }
  }

  lines.push('');
  lines.push('## Outgoing Uses (Target File Uses Others via Symbol)');
  if (result.outgoing.length === 0) {
    lines.push('- (none)');
  } else {
    for (const item of result.outgoing) {
      const preview = item.lines.slice(0, 12).join(', ');
      const suffix = item.lines.length > 12 ? ', ...' : '';
      const confidenceLabel = mapToShortLabel(item.confidence);
      const resolutionLabel = mapToShortLabel(item.resolution);
      lines.push(
        `- \`${item.file}\` (edges=${item.edgeCount}; lines=[${preview}${suffix}]; confidence=${confidenceLabel || 'n/a'}; resolution=${resolutionLabel || 'n/a'})`,
      );
    }
  }

  lines.push('');
  lines.push('## Incoming Uses (Others Use Target File via Symbol)');
  if (result.incoming.length === 0) {
    lines.push('- (none)');
  } else {
    for (const item of result.incoming) {
      const preview = item.lines.slice(0, 12).join(', ');
      const suffix = item.lines.length > 12 ? ', ...' : '';
      const confidenceLabel = mapToShortLabel(item.confidence);
      const resolutionLabel = mapToShortLabel(item.resolution);
      lines.push(
        `- \`${item.file}\` (edges=${item.edgeCount}; lines=[${preview}${suffix}]; confidence=${confidenceLabel || 'n/a'}; resolution=${resolutionLabel || 'n/a'})`,
      );
    }
  }

  lines.push('');
  return `${lines.join('\n')}\n`;
}

export async function runSymbol(options: SymbolOptions): Promise<SymbolResult> {
  const graph = await loadGraph(options.rootDir);
  if (!graph) {
    throw new Error('repomap graph not found. run `repomap build` first.');
  }

  const targetFile = normalizeTarget(options.rootDir, options.targetFile);
  const targetNodeId = toFileNodeId(targetFile);
  if (!graph.hasNode(targetNodeId)) {
    throw new Error(`target file not found in graph: ${targetFile}`);
  }

  const symbolName = options.symbolName.trim();
  if (symbolName.length === 0) {
    throw new Error('symbol name is empty');
  }

  const definitions = collectDefinitions(graph, targetFile, symbolName);
  const { outgoing, incoming } = collectSymbolUses(graph, targetNodeId, symbolName, options.limit);

  const result: SymbolResult = {
    command: 'symbol',
    targetFile,
    symbolName,
    definitions,
    outgoing,
    incoming,
    format: options.format,
  };

  if (options.outputPath) {
    const outputPath = path.isAbsolute(options.outputPath)
      ? options.outputPath
      : path.join(options.rootDir, options.outputPath);

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const content = options.format === 'md'
      ? toMarkdown(result)
      : `${JSON.stringify(result, null, 2)}\n`;
    await fs.writeFile(outputPath, content, 'utf8');
    result.outputPath = outputPath;
    logVerbose(options.verbose, `[symbol] wrote ${outputPath}`);
  }

  return result;
}
