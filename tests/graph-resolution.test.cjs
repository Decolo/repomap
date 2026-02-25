const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const CLI_PATH = path.resolve(__dirname, '..', 'dist', 'cli.js');

function writeProjectFile(rootDir, relPath, content) {
  const absPath = path.join(rootDir, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, 'utf8');
}

function runRepomap(rootDir, args) {
  execFileSync(process.execPath, [CLI_PATH, ...args], {
    cwd: rootDir,
    stdio: 'pipe',
    encoding: 'utf8',
  });
}

function buildGraph(rootDir) {
  runRepomap(rootDir, ['build', '--root', '.']);
  const graphPath = path.join(rootDir, '.repomap', 'graph.json');
  return JSON.parse(fs.readFileSync(graphPath, 'utf8'));
}

function getDependsEdges(graph, fromFile, toFile) {
  const source = `file:${fromFile}`;
  const target = `file:${toFile}`;
  return (graph.edges || []).filter((edge) => (
    edge.source === source
    && edge.target === target
    && edge.attributes
    && edge.attributes.relation === 'depends_on'
  ));
}

function mkTempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'repomap-test-'));
}

test('import binding disambiguates same-name symbols', () => {
  const rootDir = mkTempProject();

  writeProjectFile(rootDir, 'a.ts', 'export interface Config { a: number }\n');
  writeProjectFile(rootDir, 'b.ts', 'export interface Config { b: string }\n');
  writeProjectFile(
    rootDir,
    'c.ts',
    "import type { Config } from './a';\nconst value: Config = { a: 1 };\nexport { value };\n",
  );

  const graph = buildGraph(rootDir);
  const toA = getDependsEdges(graph, 'c.ts', 'a.ts');
  const toB = getDependsEdges(graph, 'c.ts', 'b.ts');

  assert.ok(toA.length > 0, 'expected c.ts to depend on a.ts');
  assert.equal(toB.length, 0, 'expected c.ts not to depend on b.ts');
  assert.ok(
    toA.some((edge) => edge.attributes.resolution === 'import'),
    'expected at least one symbol usage edge resolved via import',
  );
  assert.ok(
    toA.every((edge) => ['high', 'import_only'].includes(edge.attributes.confidence)),
    'expected high/import_only confidence for c.ts -> a.ts',
  );
});

test('tsconfig paths alias resolves to repository files', () => {
  const rootDir = mkTempProject();

  writeProjectFile(
    rootDir,
    'tsconfig.json',
    JSON.stringify(
      {
        compilerOptions: {
          baseUrl: '.',
          paths: {
            '@core/*': ['src/core/*'],
          },
        },
      },
      null,
      2,
    ) + '\n',
  );
  writeProjectFile(rootDir, 'src/core/config.ts', 'export interface Config { enabled: boolean }\n');
  writeProjectFile(
    rootDir,
    'src/feature/use.ts',
    "import type { Config } from '@core/config';\nconst cfg: Config = { enabled: true };\nexport { cfg };\n",
  );

  const graph = buildGraph(rootDir);
  const edges = getDependsEdges(graph, 'src/feature/use.ts', 'src/core/config.ts');

  assert.ok(edges.length > 0, 'expected alias import to produce dependency edge');
  assert.ok(edges.some((edge) => edge.attributes.resolution === 'import'));
  assert.ok(edges.some((edge) => edge.attributes.confidence === 'high'));
});

test('tsconfig baseUrl resolves non-relative imports', () => {
  const rootDir = mkTempProject();

  writeProjectFile(
    rootDir,
    'tsconfig.json',
    JSON.stringify(
      {
        compilerOptions: {
          baseUrl: '.',
        },
      },
      null,
      2,
    ) + '\n',
  );
  writeProjectFile(rootDir, 'src/lib/types.ts', 'export interface User { id: string }\n');
  writeProjectFile(
    rootDir,
    'src/app/main.ts',
    "import type { User } from 'src/lib/types';\nconst u: User = { id: '1' };\nexport { u };\n",
  );

  const graph = buildGraph(rootDir);
  const edges = getDependsEdges(graph, 'src/app/main.ts', 'src/lib/types.ts');

  assert.ok(edges.length > 0, 'expected baseUrl import to produce dependency edge');
  assert.ok(edges.some((edge) => edge.attributes.resolution === 'import'));
});

test('fallback name-match is used when no import binding exists', () => {
  const rootDir = mkTempProject();

  writeProjectFile(rootDir, 'defs.ts', 'export interface Config { a: number }\n');
  writeProjectFile(
    rootDir,
    'consumer.ts',
    'const value: Config = { a: 1 };\nexport { value };\n',
  );

  const graph = buildGraph(rootDir);
  const edges = getDependsEdges(graph, 'consumer.ts', 'defs.ts');

  assert.ok(edges.length > 0, 'expected fallback dependency edge');
  assert.ok(edges.some((edge) => edge.attributes.resolution === 'name_match'));
  assert.ok(edges.some((edge) => edge.attributes.confidence === 'fallback'));
});

test('unresolved import should not fallback-link to same-name symbol', () => {
  const rootDir = mkTempProject();

  writeProjectFile(rootDir, 'defs.ts', 'export interface Config { a: number }\n');
  writeProjectFile(
    rootDir,
    'consumer.ts',
    "import type { Config } from '@missing/config';\nconst value: Config = { a: 1 };\nexport { value };\n",
  );

  const graph = buildGraph(rootDir);
  const edges = getDependsEdges(graph, 'consumer.ts', 'defs.ts');

  assert.equal(
    edges.length,
    0,
    'expected no fallback dependency when unresolved import binding exists',
  );
});

test('tsconfig extends chain resolves alias paths', () => {
  const rootDir = mkTempProject();

  writeProjectFile(
    rootDir,
    'tsconfig.base.json',
    JSON.stringify(
      {
        compilerOptions: {
          baseUrl: '.',
          paths: {
            '@pkg/*': ['packages/*/src/index.ts'],
          },
        },
      },
      null,
      2,
    ) + '\n',
  );
  writeProjectFile(
    rootDir,
    'tsconfig.json',
    JSON.stringify(
      {
        extends: './tsconfig.base.json',
      },
      null,
      2,
    ) + '\n',
  );
  writeProjectFile(rootDir, 'packages/core/src/index.ts', 'export interface Config { enabled: boolean }\n');
  writeProjectFile(
    rootDir,
    'app.ts',
    "import type { Config } from '@pkg/core';\nconst cfg: Config = { enabled: true };\nexport { cfg };\n",
  );

  const graph = buildGraph(rootDir);
  const edges = getDependsEdges(graph, 'app.ts', 'packages/core/src/index.ts');

  assert.ok(edges.length > 0, 'expected extended tsconfig alias to resolve');
  assert.ok(edges.some((edge) => edge.attributes.resolution === 'import'));
  assert.ok(edges.some((edge) => edge.attributes.confidence === 'high'));
});

test('runtime call import still creates dependency edge', () => {
  const rootDir = mkTempProject();

  writeProjectFile(rootDir, 'lib.ts', 'export function sum(a:number,b:number){return a+b}\n');
  writeProjectFile(
    rootDir,
    'main.ts',
    "import { sum } from './lib';\nexport const x = sum(1,2);\n",
  );

  const graph = buildGraph(rootDir);
  const edges = getDependsEdges(graph, 'main.ts', 'lib.ts');

  assert.ok(edges.length > 0, 'expected runtime import usage to create dependency edge');
  assert.ok(
    edges.some((edge) => ['import', 'import_declaration'].includes(edge.attributes.resolution)),
    'expected import-based resolution on runtime usage',
  );
});

test('side-effect import creates dependency edge', () => {
  const rootDir = mkTempProject();

  writeProjectFile(rootDir, 'setup.ts', 'export const ready = true;\n');
  writeProjectFile(
    rootDir,
    'main.ts',
    "import './setup';\nexport const x = 1;\n",
  );

  const graph = buildGraph(rootDir);
  const edges = getDependsEdges(graph, 'main.ts', 'setup.ts');

  assert.ok(edges.length > 0, 'expected side-effect import to create dependency edge');
  assert.ok(edges.some((edge) => edge.attributes.resolution === 'import_declaration'));
});

test('default import creates dependency edge', () => {
  const rootDir = mkTempProject();

  writeProjectFile(rootDir, 'model.ts', 'export default class Model {}\n');
  writeProjectFile(
    rootDir,
    'main.ts',
    "import Model from './model';\nconst m = new Model();\nexport { m };\n",
  );

  const graph = buildGraph(rootDir);
  const edges = getDependsEdges(graph, 'main.ts', 'model.ts');

  assert.ok(edges.length > 0, 'expected default import to create dependency edge');
  assert.ok(
    edges.some((edge) => ['import', 'import_declaration'].includes(edge.attributes.resolution)),
    'expected import-based dependency for default import',
  );
});

test('namespace import creates dependency edge', () => {
  const rootDir = mkTempProject();

  writeProjectFile(rootDir, 'util.ts', 'export function run(){ return 1; }\n');
  writeProjectFile(
    rootDir,
    'main.ts',
    "import * as util from './util';\nexport const x = util.run();\n",
  );

  const graph = buildGraph(rootDir);
  const edges = getDependsEdges(graph, 'main.ts', 'util.ts');

  assert.ok(edges.length > 0, 'expected namespace import to create dependency edge');
  assert.ok(
    edges.some((edge) => ['import', 'import_declaration'].includes(edge.attributes.resolution)),
    'expected import-based dependency for namespace import',
  );
});

test.todo('re-export declarations (`export { X } from` / `export * from`) create depends_on edges');
test.todo('commonjs require() creates depends_on edges');
test.todo('nearest tsconfig (per-package) is used for alias resolution in monorepos');
