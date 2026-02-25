export const REPOMAP_DIR = '.repomap';
export const STATE_FILE = '.repomap/state.json';
export const GRAPH_FILE = '.repomap/graph.json';

export const DEFAULT_IGNORES = [
  '**/.git/**',
  '**/.repomap/**',
  '**/node_modules/**',
  '**/__pycache__/**',
  '**/.venv/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
];

export const DEFAULT_MAX_WORKERS = 4;
export const DEFAULT_TOP_K = 20;
export const DEFAULT_VIZ_HOPS = 2;
export const DEFAULT_VIZ_MAX_NODES = 220;

export const SUPPORTED_EXTENSIONS: Record<string, 'python' | 'javascript' | 'typescript' | 'tsx'> = {
  '.py': 'python',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
};
