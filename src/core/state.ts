import * as fs from 'fs/promises';
import * as path from 'path';

import { MultiDirectedGraph } from 'graphology';

import { GRAPH_FILE, REPOMAP_DIR, STATE_FILE } from './constants';
import { RepoMapState } from '../types';

async function ensureStorage(rootDir: string): Promise<void> {
  await fs.mkdir(path.join(rootDir, REPOMAP_DIR), { recursive: true });
}

export async function loadState(rootDir: string): Promise<RepoMapState | null> {
  const filePath = path.join(rootDir, STATE_FILE);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as RepoMapState;
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function saveState(rootDir: string, state: RepoMapState): Promise<void> {
  await ensureStorage(rootDir);
  const filePath = path.join(rootDir, STATE_FILE);
  await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export async function loadGraph(rootDir: string): Promise<MultiDirectedGraph | null> {
  const filePath = path.join(rootDir, GRAPH_FILE);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const serialized = JSON.parse(raw);
    const graph = new MultiDirectedGraph();
    graph.import(serialized);
    return graph;
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function saveGraph(rootDir: string, graph: MultiDirectedGraph): Promise<void> {
  await ensureStorage(rootDir);
  const filePath = path.join(rootDir, GRAPH_FILE);
  const serialized = graph.export();
  await fs.writeFile(filePath, `${JSON.stringify(serialized, null, 2)}\n`, 'utf8');
}
