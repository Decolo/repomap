import * as fs from 'fs/promises';
import * as path from 'path';

import { MultiDirectedGraph } from 'graphology';

import { loadGraph } from '../core/state';
import { logVerbose } from '../utils/log';
import { normalizeRepoPath } from '../utils/path';

interface TraceOptions {
  rootDir: string;
  targetFile: string;
  limit: number;
  format: 'json' | 'md';
  outputPath?: string;
  verbose: boolean;
}

interface TraceDependency {
  file: string;
  edgeCount: number;
  symbols: string[];
  lines: number[];
  confidence: Record<string, number>;
  resolution: Record<string, number>;
}

interface TraceResult {
  command: 'trace';
  targetFile: string;
  outgoing: TraceDependency[];
  incoming: TraceDependency[];
  outputPath?: string;
  format: 'json' | 'md';
}

interface MutableDep {
  file: string;
  edgeCount: number;
  symbols: Set<string>;
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

function addDep(map: Map<string, MutableDep>, file: string, attrs: unknown): void {
  let dep = map.get(file);
  if (!dep) {
    dep = {
      file,
      edgeCount: 0,
      symbols: new Set<string>(),
      lines: new Set<number>(),
      confidence: new Map<string, number>(),
      resolution: new Map<string, number>(),
    };
    map.set(file, dep);
  }

  dep.edgeCount += 1;

  const symbol = (attrs as Record<string, unknown>).symbol;
  if (typeof symbol === 'string' && symbol.length > 0) {
    dep.symbols.add(symbol);
  }

  const line = (attrs as Record<string, unknown>).line;
  if (typeof line === 'number' && Number.isFinite(line)) {
    dep.lines.add(line);
  }

  const confidence = (attrs as Record<string, unknown>).confidence;
  if (typeof confidence === 'string' && confidence.length > 0) {
    dep.confidence.set(confidence, (dep.confidence.get(confidence) ?? 0) + 1);
  }

  const resolution = (attrs as Record<string, unknown>).resolution;
  if (typeof resolution === 'string' && resolution.length > 0) {
    dep.resolution.set(resolution, (dep.resolution.get(resolution) ?? 0) + 1);
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

function finalizeDeps(map: Map<string, MutableDep>, limit: number): TraceDependency[] {
  const items = Array.from(map.values()).map((dep): TraceDependency => ({
    file: dep.file,
    edgeCount: dep.edgeCount,
    symbols: Array.from(dep.symbols).sort((a, b) => a.localeCompare(b)),
    lines: Array.from(dep.lines).sort((a, b) => a - b),
    confidence: mapToObject(dep.confidence),
    resolution: mapToObject(dep.resolution),
  }));

  items.sort((a, b) => {
    if (b.edgeCount !== a.edgeCount) {
      return b.edgeCount - a.edgeCount;
    }
    return a.file.localeCompare(b.file);
  });

  return items.slice(0, limit);
}

function collectDependencies(graph: MultiDirectedGraph, targetNodeId: string, limit: number): {
  outgoing: TraceDependency[];
  incoming: TraceDependency[];
} {
  const outgoingMap = new Map<string, MutableDep>();
  const incomingMap = new Map<string, MutableDep>();

  graph.forEachOutEdge(targetNodeId, (_edgeId, attrs, _source, target) => {
    if (relationFromAttrs(attrs) !== 'depends_on') {
      return;
    }
    const targetFile = fromFileNodeId(target);
    if (!targetFile) {
      return;
    }
    addDep(outgoingMap, targetFile, attrs);
  });

  graph.forEachInEdge(targetNodeId, (_edgeId, attrs, source) => {
    if (relationFromAttrs(attrs) !== 'depends_on') {
      return;
    }
    const sourceFile = fromFileNodeId(source);
    if (!sourceFile) {
      return;
    }
    addDep(incomingMap, sourceFile, attrs);
  });

  return {
    outgoing: finalizeDeps(outgoingMap, limit),
    incoming: finalizeDeps(incomingMap, limit),
  };
}

function toMarkdown(result: TraceResult): string {
  const lines: string[] = [];
  lines.push(`# repomap trace`);
  lines.push('');
  lines.push(`- target: \`${result.targetFile}\``);
  lines.push(`- outgoing: ${result.outgoing.length}`);
  lines.push(`- incoming: ${result.incoming.length}`);
  lines.push('');

  lines.push('## This File Depends On');
  if (result.outgoing.length === 0) {
    lines.push('- (none)');
  } else {
    for (const dep of result.outgoing) {
      const symbols = dep.symbols.slice(0, 8).join(', ');
      const symbolLabel = symbols.length > 0 ? `; symbols: ${symbols}` : '';
      const confidenceLabel = mapToShortLabel(dep.confidence);
      const resolutionLabel = mapToShortLabel(dep.resolution);
      lines.push(
        `- \`${dep.file}\` (edges=${dep.edgeCount}${symbolLabel}; confidence=${confidenceLabel || 'n/a'}; resolution=${resolutionLabel || 'n/a'})`,
      );
    }
  }

  lines.push('');
  lines.push('## Files That Depend On This File');
  if (result.incoming.length === 0) {
    lines.push('- (none)');
  } else {
    for (const dep of result.incoming) {
      const symbols = dep.symbols.slice(0, 8).join(', ');
      const symbolLabel = symbols.length > 0 ? `; symbols: ${symbols}` : '';
      const confidenceLabel = mapToShortLabel(dep.confidence);
      const resolutionLabel = mapToShortLabel(dep.resolution);
      lines.push(
        `- \`${dep.file}\` (edges=${dep.edgeCount}${symbolLabel}; confidence=${confidenceLabel || 'n/a'}; resolution=${resolutionLabel || 'n/a'})`,
      );
    }
  }

  lines.push('');
  return `${lines.join('\n')}\n`;
}

export async function runTrace(options: TraceOptions): Promise<TraceResult> {
  const graph = await loadGraph(options.rootDir);
  if (!graph) {
    throw new Error('repomap graph not found. run `repomap build` first.');
  }

  const targetFile = normalizeTarget(options.rootDir, options.targetFile);
  const targetNodeId = toFileNodeId(targetFile);

  if (!graph.hasNode(targetNodeId)) {
    throw new Error(`target file not found in graph: ${targetFile}`);
  }

  const { outgoing, incoming } = collectDependencies(graph, targetNodeId, options.limit);

  const result: TraceResult = {
    command: 'trace',
    targetFile,
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
    logVerbose(options.verbose, `[trace] wrote ${outputPath}`);
  }

  return result;
}
