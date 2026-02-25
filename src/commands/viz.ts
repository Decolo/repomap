import * as fs from 'fs/promises';
import * as path from 'path';

import { MultiDirectedGraph } from 'graphology';

import { loadGraph } from '../core/state';
import { getFileNodeId } from '../core/graph';
import { logVerbose } from '../utils/log';
import { normalizeRepoPath } from '../utils/path';

interface VizOptions {
  rootDir: string;
  targetFiles: string[];
  relationFilters: string[];
  hops: number;
  maxNodes: number;
  outputPath?: string;
  verbose: boolean;
}

interface VizSummary {
  command: 'viz';
  outputPath: string;
  seedFiles: string[];
  relationFilters: string[];
  hops: number;
  maxNodes: number;
  renderedNodes: number;
  renderedEdges: number;
}

interface VizNode {
  id: string;
  label: string;
  kind: string;
  path?: string;
  symbol?: string;
  symbolType?: string;
  line?: number;
  language?: string;
  isSeed: 0 | 1;
}

interface VizEdge {
  id: string;
  source: string;
  target: string;
  relation: string;
  symbol?: string;
}

function normalizeTarget(rootDir: string, target: string): string {
  const normalized = normalizeRepoPath(target);
  if (path.isAbsolute(normalized)) {
    return normalizeRepoPath(path.relative(rootDir, normalized));
  }
  return normalized.replace(/\/+$/, '');
}

function collectFileNodes(graph: MultiDirectedGraph): string[] {
  const out: string[] = [];
  graph.forEachNode((nodeId, attrs) => {
    if ((attrs as Record<string, unknown>).kind === 'file') {
      out.push(nodeId);
    }
  });
  return out;
}

function collectFilePathMap(graph: MultiDirectedGraph): Map<string, string> {
  const byPath = new Map<string, string>();
  graph.forEachNode((nodeId, attrs) => {
    const nodeAttrs = attrs as Record<string, unknown>;
    if (nodeAttrs.kind !== 'file') {
      return;
    }
    const filePath = nodeAttrs.path;
    if (typeof filePath === 'string') {
      byPath.set(filePath, nodeId);
    }
  });
  return byPath;
}

function chooseDefaultSeeds(graph: MultiDirectedGraph, limit: number): string[] {
  const fileNodes = collectFileNodes(graph);
  fileNodes.sort((a, b) => graph.degree(b) - graph.degree(a));
  return fileNodes.slice(0, Math.max(1, limit));
}

function resolveSeedNodes(graph: MultiDirectedGraph, rootDir: string, targets: string[]): { seedNodes: string[]; seedFiles: string[] } {
  if (targets.length === 0) {
    const seedNodes = chooseDefaultSeeds(graph, 3);
    const seedFiles = seedNodes
      .map((nodeId) => {
        const attrs = graph.getNodeAttributes(nodeId) as Record<string, unknown>;
        return String(attrs.path ?? '');
      })
      .filter(Boolean);
    return { seedNodes, seedFiles };
  }

  const normalizedTargets = targets.map((target) => normalizeTarget(rootDir, target));
  const filePathMap = collectFilePathMap(graph);
  const seedNodes: string[] = [];
  const seedFiles: string[] = [];
  const seen = new Set<string>();

  for (const target of normalizedTargets) {
    const nodeId = getFileNodeId(target);
    if (graph.hasNode(nodeId) && !seen.has(nodeId)) {
      seen.add(nodeId);
      seedNodes.push(nodeId);
      seedFiles.push(target);
      continue;
    }

    const prefix = target.length > 0 ? `${target}/` : '';
    for (const [filePath, fileNodeId] of filePathMap.entries()) {
      if (filePath === target || (prefix && filePath.startsWith(prefix))) {
        if (seen.has(fileNodeId)) {
          continue;
        }
        seen.add(fileNodeId);
        seedNodes.push(fileNodeId);
        seedFiles.push(filePath);
      }
    }
  }

  return { seedNodes, seedFiles };
}

function relationFromAttrs(attrs: unknown): string {
  const raw = (attrs as Record<string, unknown>).relation;
  return typeof raw === 'string' ? raw : 'related';
}

function addNeighbors(
  graph: MultiDirectedGraph,
  nodeId: string,
  out: Set<string>,
  allowedRelations: Set<string> | null,
): void {
  if (!allowedRelations) {
    graph.forEachOutNeighbor(nodeId, (neighbor) => out.add(neighbor));
    graph.forEachInNeighbor(nodeId, (neighbor) => out.add(neighbor));
    return;
  }

  graph.forEachOutEdge(nodeId, (_edgeId, attrs, _source, target) => {
    if (allowedRelations.has(relationFromAttrs(attrs))) {
      out.add(target);
    }
  });

  graph.forEachInEdge(nodeId, (_edgeId, attrs, source) => {
    if (allowedRelations.has(relationFromAttrs(attrs))) {
      out.add(source);
    }
  });
}

function buildSubgraphNodeSet(
  graph: MultiDirectedGraph,
  seeds: string[],
  hops: number,
  maxNodes: number,
  allowedRelations: Set<string> | null,
): Set<string> {
  const selected = new Set<string>();
  const queue: Array<{ nodeId: string; depth: number }> = [];

  for (const seed of seeds) {
    selected.add(seed);
    queue.push({ nodeId: seed, depth: 0 });
  }

  while (queue.length > 0 && selected.size < maxNodes) {
    const current = queue.shift();
    if (!current) {
      break;
    }
    if (current.depth >= hops) {
      continue;
    }

    const neighbors = new Set<string>();
    addNeighbors(graph, current.nodeId, neighbors, allowedRelations);

    for (const neighbor of neighbors) {
      if (selected.has(neighbor)) {
        continue;
      }
      selected.add(neighbor);
      queue.push({ nodeId: neighbor, depth: current.depth + 1 });
      if (selected.size >= maxNodes) {
        break;
      }
    }
  }

  return selected;
}

function buildVizNodes(graph: MultiDirectedGraph, selected: Set<string>, seeds: Set<string>): VizNode[] {
  const nodes: VizNode[] = [];
  for (const nodeId of selected) {
    const attrs = graph.getNodeAttributes(nodeId) as Record<string, unknown>;
    const kind = String(attrs.kind ?? 'unknown');
    const isSeed = seeds.has(nodeId) ? 1 : 0;

    nodes.push({
      id: nodeId,
      label: String(attrs.path ?? attrs.name ?? nodeId),
      kind,
      path: typeof attrs.path === 'string' ? attrs.path : undefined,
      symbol: typeof attrs.name === 'string' ? attrs.name : undefined,
      symbolType: typeof attrs.symbolType === 'string' ? attrs.symbolType : undefined,
      line: typeof attrs.line === 'number' ? attrs.line : undefined,
      language: typeof attrs.language === 'string' ? attrs.language : undefined,
      isSeed,
    });
  }

  nodes.sort((a, b) => a.label.localeCompare(b.label));
  return nodes;
}

function buildVizEdges(
  graph: MultiDirectedGraph,
  selected: Set<string>,
  maxEdges: number,
  allowedRelations: Set<string> | null,
): VizEdge[] {
  const edges: VizEdge[] = [];
  graph.forEachEdge((edgeId, attrs, source, target) => {
    if (edges.length >= maxEdges) {
      return;
    }
    if (!selected.has(source) || !selected.has(target)) {
      return;
    }

    const edgeAttrs = attrs as Record<string, unknown>;
    const relation = relationFromAttrs(edgeAttrs);
    if (allowedRelations && !allowedRelations.has(relation)) {
      return;
    }

    edges.push({
      id: String(edgeId),
      source,
      target,
      relation,
      symbol: typeof edgeAttrs.symbol === 'string' ? edgeAttrs.symbol : undefined,
    });
  });

  return edges;
}

function escJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function escInlineScript(source: string): string {
  return source.replace(/<\/script/gi, '<\\/script');
}

async function loadBundledCytoscapeScript(): Promise<string | null> {
  try {
    const bundlePath = require.resolve('cytoscape/dist/cytoscape.min.js');
    const bundle = await fs.readFile(bundlePath, 'utf8');
    return escInlineScript(bundle);
  } catch {
    return null;
  }
}

function htmlTemplate(payload: {
  title: string;
  subtitle: string;
  generatedAt: string;
  nodes: VizNode[];
  edges: VizEdge[];
  cytoscapeScript: string | null;
}): string {
  const serializedNodes = escJson(payload.nodes);
  const serializedEdges = escJson(payload.edges);
  const cytoscapeTag = payload.cytoscapeScript
    ? `<script>${payload.cytoscapeScript}</script>`
    : '<script src="https://unpkg.com/cytoscape@3.30.2/dist/cytoscape.min.js"></script>';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${payload.title}</title>
  ${cytoscapeTag}
  <style>
    :root {
      --bg: #f5f3ee;
      --panel: #fffaf0;
      --ink: #1f2933;
      --muted: #5b6670;
      --line: #d9d5cb;
      --seed: #e24a33;
      --file: #1f7a8c;
      --symbol: #8f5db7;
      --unknown: #6b7280;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, -apple-system, Segoe UI, Helvetica, Arial, sans-serif;
      color: var(--ink);
      background: radial-gradient(circle at 20% 0%, #fff9e6 0%, var(--bg) 60%);
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto 1fr;
    }
    header {
      border-bottom: 1px solid var(--line);
      padding: 16px 20px;
      display: flex;
      align-items: baseline;
      gap: 10px;
      flex-wrap: wrap;
      background: color-mix(in srgb, var(--panel) 92%, white);
    }
    .title {
      font-size: 16px;
      font-weight: 700;
      letter-spacing: 0.01em;
    }
    .meta {
      font-size: 12px;
      color: var(--muted);
    }
    main {
      display: grid;
      grid-template-columns: 1fr 320px;
      min-height: 0;
    }
    #graph {
      min-height: 72vh;
      border-right: 1px solid var(--line);
      background:
        linear-gradient(135deg, rgba(255,255,255,0.65), rgba(255,255,255,0.35)),
        repeating-linear-gradient(0deg, transparent 0, transparent 23px, rgba(0,0,0,0.015) 24px),
        repeating-linear-gradient(90deg, transparent 0, transparent 23px, rgba(0,0,0,0.015) 24px);
    }
    aside {
      padding: 14px;
      background: var(--panel);
      overflow: auto;
    }
    .block { margin-bottom: 16px; }
    .label {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      margin-bottom: 6px;
    }
    .value {
      font-size: 13px;
      line-height: 1.4;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .legend {
      display: grid;
      gap: 6px;
      font-size: 12px;
      color: var(--muted);
    }
    .node-list {
      max-height: 52vh;
      overflow: auto;
      border: 1px solid var(--line);
      background: #fff;
      padding: 8px;
    }
    .node-item {
      font-size: 12px;
      line-height: 1.35;
      padding: 4px 6px;
      border-radius: 4px;
      margin-bottom: 4px;
      background: #f8fafc;
      border-left: 3px solid #94a3b8;
      word-break: break-word;
    }
    .node-item.seed {
      border-left-color: var(--seed);
      background: #fff2ef;
    }
    .node-meta {
      color: var(--muted);
      font-size: 11px;
      margin-left: 6px;
    }
    .swatch {
      display: inline-block;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      margin-right: 6px;
      transform: translateY(1px);
    }
    @media (max-width: 980px) {
      main { grid-template-columns: 1fr; }
      #graph { border-right: none; border-bottom: 1px solid var(--line); min-height: 60vh; }
    }
  </style>
</head>
<body>
  <header>
    <div class="title">${payload.title}</div>
    <div class="meta">${payload.subtitle}</div>
    <div class="meta">generated: ${payload.generatedAt}</div>
  </header>
  <main>
    <div id="graph"></div>
    <aside>
      <div class="block">
        <div class="label">Selection</div>
        <div id="selection" class="value">Click a node or edge.</div>
      </div>
      <div class="block">
        <div class="label">Legend</div>
        <div class="legend">
          <div><span class="swatch" style="background: var(--seed)"></span>Seed node</div>
          <div><span class="swatch" style="background: var(--file)"></span>File node</div>
          <div><span class="swatch" style="background: var(--symbol)"></span>Symbol node</div>
          <div><span class="swatch" style="background: var(--unknown)"></span>Other node</div>
        </div>
      </div>
      <div class="block">
        <div class="label">Nodes</div>
        <div id="node-list" class="node-list"></div>
      </div>
    </aside>
  </main>

  <script>
    const nodes = ${serializedNodes};
    const edges = ${serializedEdges};

    const elements = [
      ...nodes.map((n) => ({ data: n })),
      ...edges.map((e) => ({ data: e })),
    ];

    const selection = document.getElementById('selection');
    const graphEl = document.getElementById('graph');
    const nodeListEl = document.getElementById('node-list');

    function setSelection(value) {
      selection.textContent = value;
    }

    function renderNodeList() {
      const maxItems = 220;
      const summary = document.createElement('div');
      summary.className = 'node-item';
      summary.textContent = 'showing ' + Math.min(nodes.length, maxItems) + ' / ' + nodes.length + ' nodes';
      nodeListEl.appendChild(summary);

      for (let i = 0; i < nodes.length && i < maxItems; i += 1) {
        const node = nodes[i];
        const item = document.createElement('div');
        item.className = 'node-item' + (node.isSeed === 1 ? ' seed' : '');
        const label = node.label || node.id;
        const kind = node.kind || 'unknown';
        item.innerHTML = '<strong>' + label + '</strong><span class=\"node-meta\">(' + kind + ')</span>';
        nodeListEl.appendChild(item);
      }
    }

    renderNodeList();

    if (typeof cytoscape !== 'function') {
      setSelection('Graph renderer failed to load (cytoscape unavailable).');
      graphEl.innerHTML = '<div style=\"padding:16px;color:#7f1d1d;font-size:13px;\">Unable to render graph because Cytoscape was not loaded.</div>';
    } else {
      const layout = edges.length === 0 || nodes.length > 260
        ? {
            name: 'grid',
            fit: true,
            padding: 26,
            avoidOverlap: true,
          }
        : {
            name: 'cose',
            animate: false,
            padding: 20,
            idealEdgeLength: 80,
            nodeOverlap: 18,
          };

      const cy = cytoscape({
        container: graphEl,
        elements,
        style: [
          {
            selector: 'node',
            style: {
              'label': 'data(label)',
              'font-size': 10,
              'text-wrap': 'wrap',
              'text-max-width': 180,
              'text-valign': 'center',
              'text-halign': 'center',
              'background-color': '#6b7280',
              'color': '#2a2f35',
              'width': 28,
              'height': 28,
              'border-width': 1,
              'border-color': '#f8fafc'
            }
          },
          { selector: 'node[kind = "file"]', style: { 'background-color': '#1f7a8c', 'shape': 'round-rectangle', 'width': 48, 'height': 28, 'color': '#0f172a' } },
          { selector: 'node[kind = "symbol"]', style: { 'background-color': '#8f5db7', 'shape': 'ellipse', 'width': 24, 'height': 24, 'color': '#1f2937' } },
          { selector: 'node[isSeed = 1]', style: { 'background-color': '#e24a33', 'border-width': 2, 'border-color': '#111827', 'z-index': 999 } },
          {
            selector: 'edge',
            style: {
              'curve-style': 'bezier',
              'width': 1.2,
              'line-color': '#94a3b8',
              'target-arrow-shape': 'triangle',
              'target-arrow-color': '#94a3b8',
              'arrow-scale': 0.7,
              'label': 'data(relation)',
              'font-size': 8,
              'color': '#475569',
              'text-background-color': '#ffffffb3',
              'text-background-opacity': 1,
              'text-background-padding': 2
            }
          }
        ],
        layout
      });

    cy.on('tap', 'node', (evt) => {
      const d = evt.target.data();
      const lines = [
        'type: node',
        'id: ' + d.id,
        'kind: ' + (d.kind || ''),
      ];
      if (d.path) lines.push('path: ' + d.path);
      if (d.symbol) lines.push('symbol: ' + d.symbol);
      if (d.symbolType) lines.push('symbolType: ' + d.symbolType);
      if (d.line) lines.push('line: ' + d.line);
      if (d.language) lines.push('language: ' + d.language);
      lines.push('seed: ' + (d.isSeed === 1 ? 'yes' : 'no'));
      setSelection(lines.join('\n'));
    });

    cy.on('tap', 'edge', (evt) => {
      const d = evt.target.data();
      const lines = [
        'type: edge',
        'id: ' + d.id,
        'relation: ' + (d.relation || ''),
        'source: ' + d.source,
        'target: ' + d.target,
      ];
      if (d.symbol) lines.push('symbol: ' + d.symbol);
      setSelection(lines.join('\n'));
    });

      cy.fit(undefined, 26);
      const minZoom = nodes.length > 260 ? 0.35 : 0.55;
      if (cy.zoom() < minZoom) {
        cy.zoom(minZoom);
        cy.center();
      }
    }
  </script>
</body>
</html>
`;
}

export async function runViz(options: VizOptions): Promise<VizSummary> {
  const graph = await loadGraph(options.rootDir);
  if (!graph) {
    throw new Error('repomap graph not found. run `repomap build` first.');
  }

  const relationFilters = options.relationFilters
    .map((item) => item.trim())
    .filter(Boolean);
  const allowedRelations = relationFilters.length > 0 ? new Set(relationFilters) : null;

  const { seedNodes, seedFiles } = resolveSeedNodes(graph, options.rootDir, options.targetFiles);
  if (seedNodes.length === 0) {
    throw new Error('no seed files found in graph. pass --target with indexed file paths.');
  }

  const selected = buildSubgraphNodeSet(
    graph,
    seedNodes,
    options.hops,
    options.maxNodes,
    allowedRelations,
  );
  const seeds = new Set(seedNodes);
  const nodes = buildVizNodes(graph, selected, seeds);
  const maxEdges = Math.max(options.maxNodes * 8, 100);
  const edges = buildVizEdges(graph, selected, maxEdges, allowedRelations);

  const outputPath = options.outputPath
    ? (path.isAbsolute(options.outputPath) ? options.outputPath : path.join(options.rootDir, options.outputPath))
    : path.join(options.rootDir, '.repomap', 'viz.html');

  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const title = `repomap graph view (${path.basename(options.rootDir)})`;
  const relationLabel = relationFilters.length > 0 ? relationFilters.join(',') : 'all';
  const subtitle = `seedFiles=${seedFiles.length} hops=${options.hops} relations=${relationLabel} nodes=${nodes.length} edges=${edges.length}`;
  const cytoscapeScript = await loadBundledCytoscapeScript();
  const html = htmlTemplate({
    title,
    subtitle,
    generatedAt: new Date().toISOString(),
    nodes,
    edges,
    cytoscapeScript,
  });

  await fs.writeFile(outputPath, html, 'utf8');
  logVerbose(options.verbose, `[viz] wrote ${outputPath}`);

  return {
    command: 'viz',
    outputPath,
    seedFiles,
    relationFilters,
    hops: options.hops,
    maxNodes: options.maxNodes,
    renderedNodes: nodes.length,
    renderedEdges: edges.length,
  };
}
