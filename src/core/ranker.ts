import { MultiDirectedGraph } from 'graphology';
import pagerank from 'graphology-metrics/centrality/pagerank';

import { FileRecord, RankedFile } from '../types';
import { getFileNodeId, getFilePathFromNode, isFileNode } from './graph';

const SCORE_WEIGHTS = {
  ppr: 0.45,
  risk: 0.25,
  boundaryImpact: 0.15,
  testGap: 0.1,
  freshness: 0.05,
} as const;

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

function normalize(values: number[]): number[] {
  if (values.length === 0) {
    return [];
  }
  const maxValue = Math.max(...values);
  const minValue = Math.min(...values);
  if (maxValue === minValue) {
    return values.map(() => 0.5);
  }
  return values.map((value) => (value - minValue) / (maxValue - minValue));
}

function fileRisk(file: string): number {
  const lower = file.toLowerCase();
  if (/(auth|permission|acl|policy|security)/.test(lower)) {
    return 1;
  }
  if (/(payment|billing|invoice|money|wallet)/.test(lower)) {
    return 0.95;
  }
  if (/(migration|schema|db|database|sql|model)/.test(lower)) {
    return 0.85;
  }
  if (/(api|route|controller|handler)/.test(lower)) {
    return 0.7;
  }
  if (/(test|spec)/.test(lower)) {
    return 0.25;
  }
  return 0.45;
}

function fileBoundaryImpact(graph: MultiDirectedGraph, nodeId: string): number {
  const neighbors = new Set<string>();
  graph.forEachOutNeighbor(nodeId, (neighbor) => {
    if (isFileNode(neighbor)) {
      neighbors.add(neighbor);
    }
  });
  graph.forEachInNeighbor(nodeId, (neighbor) => {
    if (isFileNode(neighbor)) {
      neighbors.add(neighbor);
    }
  });
  return clamp(neighbors.size / 12);
}

function hasTestCoverage(graph: MultiDirectedGraph, nodeId: string): boolean {
  let covered = false;
  graph.forEachInEdge(nodeId, (_edge, attrs, source) => {
    if (covered) {
      return;
    }
    const relation = String((attrs as Record<string, unknown>).relation ?? '');
    if (relation === 'test_covers' && isFileNode(source)) {
      covered = true;
    }
  });
  return covered;
}

function fileTestGap(graph: MultiDirectedGraph, nodeId: string, file: string): number {
  const lower = file.toLowerCase();
  if (/(test|spec)/.test(lower)) {
    return 0.2;
  }
  if (hasTestCoverage(graph, nodeId)) {
    return 0.1;
  }
  return 0.9;
}

function fileFreshness(record: FileRecord | undefined): number {
  if (!record) {
    return 0;
  }
  const parsedAt = Date.parse(record.lastParsedAt);
  if (Number.isNaN(parsedAt)) {
    return 0.4;
  }
  const ageMs = Date.now() - parsedAt;
  const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
  return clamp(1 - ageMs / oneWeekMs);
}

function reasonsFor(features: RankedFile['features']): string[] {
  const reasons: string[] = [];
  if (features.ppr >= 0.7) {
    reasons.push('high-graph-relevance');
  }
  if (features.risk >= 0.8) {
    reasons.push('high-risk-path');
  }
  if (features.boundaryImpact >= 0.6) {
    reasons.push('cross-module-impact');
  }
  if (features.testGap >= 0.7) {
    reasons.push('test-gap-suspected');
  }
  if (features.freshness <= 0.3) {
    reasons.push('stale-index-signal');
  }
  if (reasons.length === 0) {
    reasons.push('baseline-score');
  }
  return reasons;
}

export function rankFiles(
  graph: MultiDirectedGraph,
  records: Record<string, FileRecord>,
  seedFiles: string[],
  topK: number,
): RankedFile[] {
  const fileNodes: Array<{ nodeId: string; file: string }> = [];
  graph.forEachNode((nodeId) => {
    if (!isFileNode(nodeId)) {
      return;
    }
    const file = getFilePathFromNode(graph, nodeId);
    if (!file) {
      return;
    }
    fileNodes.push({ nodeId, file });
  });

  if (fileNodes.length === 0) {
    return [];
  }

  const seedNodeIds = new Set(seedFiles.map((file) => getFileNodeId(file)));
  const hasSeeds = seedNodeIds.size > 0;

  const personalization: Record<string, number> = {};
  graph.forEachNode((nodeId) => {
    personalization[nodeId] = hasSeeds && seedNodeIds.has(nodeId) ? 1 : 0.01;
  });

  // graphology-metrics type definitions do not expose personalization,
  // but runtime supports passing it.
  const pagerankOptions: any = {
    alpha: 0.85,
    maxIterations: 100,
    tolerance: 1e-6,
  };
  if (hasSeeds) {
    pagerankOptions.personalization = personalization;
  }

  const pprScores = pagerank(graph, pagerankOptions) as Record<string, number>;

  const rawPpr = fileNodes.map((item) => pprScores[item.nodeId] ?? 0);
  const normalizedPpr = normalize(rawPpr);

  const ranked = fileNodes.map((item, index): RankedFile => {
    const risk = fileRisk(item.file);
    const boundaryImpact = fileBoundaryImpact(graph, item.nodeId);
    const testGap = fileTestGap(graph, item.nodeId, item.file);
    const freshness = fileFreshness(records[item.file]);
    const ppr = normalizedPpr[index] ?? 0;

    const score =
      SCORE_WEIGHTS.ppr * ppr +
      SCORE_WEIGHTS.risk * risk +
      SCORE_WEIGHTS.boundaryImpact * boundaryImpact +
      SCORE_WEIGHTS.testGap * testGap +
      SCORE_WEIGHTS.freshness * freshness;

    const features = { ppr, risk, boundaryImpact, testGap, freshness };

    return {
      file: item.file,
      score,
      features,
      reasons: reasonsFor(features),
    };
  });

  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, topK);
}
