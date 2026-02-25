import * as fs from 'fs/promises';
import * as path from 'path';

import { ImportBinding, Tag, SupportedLanguage } from '../types';
import { SourceFile } from './files';

const Parser = require('tree-sitter');
const Python = require('tree-sitter-python');
const JavaScript = require('tree-sitter-javascript');
const TypeScript = require('tree-sitter-typescript');

type ParserInstance = InstanceType<typeof Parser>;
type QueryInstance = InstanceType<typeof Parser.Query>;

const LANGUAGE_CONFIG: Record<SupportedLanguage, { language: unknown; queryFile: string }> = {
  python: {
    language: Python,
    queryFile: 'tree-sitter-python-tags.scm',
  },
  javascript: {
    language: JavaScript,
    queryFile: 'tree-sitter-javascript-tags.scm',
  },
  typescript: {
    language: TypeScript.typescript,
    queryFile: 'tree-sitter-typescript-tags.scm',
  },
  tsx: {
    language: TypeScript.tsx,
    queryFile: 'tree-sitter-typescript-tags.scm',
  },
};

const parserCache = new Map<SupportedLanguage, ParserInstance>();
const queryCache = new Map<SupportedLanguage, QueryInstance>();
const queryFallbackWarned = new Set<SupportedLanguage>();

const FALLBACK_QUERIES: Partial<Record<SupportedLanguage, string>> = {
  javascript: `
(method_definition
  name: (property_identifier) @name.definition.method
) @definition.method

(class_declaration
  name: (identifier) @name.definition.class
) @definition.class

(function_declaration
  name: (identifier) @name.definition.function
) @definition.function

(generator_function_declaration
  name: (identifier) @name.definition.function
) @definition.function

(lexical_declaration
  (variable_declarator
    name: (identifier) @name.definition.function
    value: [(arrow_function) (function_expression) (generator_function)]
  )
) @definition.function

(variable_declaration
  (variable_declarator
    name: (identifier) @name.definition.function
    value: [(arrow_function) (function_expression) (generator_function)]
  )
) @definition.function

(
  (call_expression
    function: (identifier) @name.reference.call
  ) @reference.call
  (#not-match? @name.reference.call "^(require)$")
)

(call_expression
  function: (member_expression
    property: (property_identifier) @name.reference.call
  )
) @reference.call
`,
  typescript: `
(method_definition
  name: (property_identifier) @name.definition.method
) @definition.method

(class_declaration
  name: (type_identifier) @name.definition.class
) @definition.class

(function_declaration
  name: (identifier) @name.definition.function
) @definition.function

(generator_function_declaration
  name: (identifier) @name.definition.function
) @definition.function

(lexical_declaration
  (variable_declarator
    name: (identifier) @name.definition.function
    value: [(arrow_function) (function_expression) (generator_function)]
  )
) @definition.function

(variable_declaration
  (variable_declarator
    name: (identifier) @name.definition.function
    value: [(arrow_function) (function_expression) (generator_function)]
  )
) @definition.function

(
  (call_expression
    function: (identifier) @name.reference.call
  ) @reference.call
  (#not-match? @name.reference.call "^(require)$")
)

(call_expression
  function: (member_expression
    property: (property_identifier) @name.reference.call
  )
) @reference.call
`,
  tsx: `
(method_definition
  name: (property_identifier) @name.definition.method
) @definition.method

(class_declaration
  name: (type_identifier) @name.definition.class
) @definition.class

(function_declaration
  name: (identifier) @name.definition.function
) @definition.function

(generator_function_declaration
  name: (identifier) @name.definition.function
) @definition.function

(lexical_declaration
  (variable_declarator
    name: (identifier) @name.definition.function
    value: [(arrow_function) (function_expression) (generator_function)]
  )
) @definition.function

(variable_declaration
  (variable_declarator
    name: (identifier) @name.definition.function
    value: [(arrow_function) (function_expression) (generator_function)]
  )
) @definition.function

(
  (call_expression
    function: (identifier) @name.reference.call
  ) @reference.call
  (#not-match? @name.reference.call "^(require)$")
)

(call_expression
  function: (member_expression
    property: (property_identifier) @name.reference.call
  )
) @reference.call
`,
};

export interface ParsedFileArtifacts {
  tags: Tag[];
  imports: ImportBinding[];
}

function queryBaseDir(): string {
  return path.resolve(__dirname, '../../queries');
}

async function loadQuery(language: SupportedLanguage): Promise<QueryInstance> {
  const cached = queryCache.get(language);
  if (cached) {
    return cached;
  }

  const config = LANGUAGE_CONFIG[language];
  const queryPath = path.join(queryBaseDir(), config.queryFile);
  const queryString = await fs.readFile(queryPath, 'utf8');
  try {
    const query = new Parser.Query(config.language, queryString);
    queryCache.set(language, query);
    return query;
  } catch (error) {
    const fallback = FALLBACK_QUERIES[language];
    if (!fallback) {
      throw error;
    }

    if (!queryFallbackWarned.has(language)) {
      queryFallbackWarned.add(language);
      console.warn(
        `[repomap] failed to compile ${config.queryFile}; using built-in fallback query for ${language}`,
      );
    }

    const fallbackQuery = new Parser.Query(config.language, fallback);
    queryCache.set(language, fallbackQuery);
    return fallbackQuery;
  }
}

function parserFor(language: SupportedLanguage): ParserInstance {
  const cached = parserCache.get(language);
  if (cached) {
    return cached;
  }

  const parser = new Parser();
  parser.setLanguage(LANGUAGE_CONFIG[language].language);
  parserCache.set(language, parser);
  return parser;
}

function tagFromCapture(sourceFile: SourceFile, captureName: string, node: any): Tag | null {
  let kind: 'def' | 'ref';
  let type: string;

  if (captureName.startsWith('name.definition.')) {
    kind = 'def';
    type = captureName.replace('name.definition.', '');
  } else if (captureName.startsWith('name.reference.')) {
    kind = 'ref';
    type = captureName.replace('name.reference.', '');
  } else {
    return null;
  }

  const name = String(node.text ?? '').trim();
  if (!name) {
    return null;
  }

  return {
    relPath: sourceFile.relPath,
    absPath: sourceFile.absPath,
    name,
    kind,
    type,
    line: Number(node.startPosition?.row ?? 0) + 1,
  };
}

function textOf(node: any): string {
  return String(node?.text ?? '').trim();
}

function lineOf(node: any): number | undefined {
  const row = Number(node?.startPosition?.row);
  if (!Number.isFinite(row)) {
    return undefined;
  }
  return row + 1;
}

function extractModuleSpecifier(statementNode: any): string | null {
  for (let i = 0; i < statementNode.namedChildCount; i += 1) {
    const child = statementNode.namedChild(i);
    if (!child || child.type !== 'string') {
      continue;
    }
    const raw = textOf(child);
    if (raw.length < 2) {
      return null;
    }
    const first = raw[0];
    const last = raw[raw.length - 1];
    if ((first === '\'' || first === '"') && first === last) {
      return raw.slice(1, -1);
    }
    return raw;
  }
  return null;
}

function parseImportClauseBindings(
  clauseNode: any,
  moduleSpecifier: string,
  isTypeOnlyImport: boolean,
): ImportBinding[] {
  const bindings: ImportBinding[] = [];

  for (let i = 0; i < clauseNode.namedChildCount; i += 1) {
    const child = clauseNode.namedChild(i);
    if (!child) {
      continue;
    }

    if (child.type === 'identifier') {
      const localName = textOf(child);
      if (localName) {
        bindings.push({
          localName,
          importedName: 'default',
          moduleSpecifier,
          isTypeOnly: isTypeOnlyImport,
          sourceKind: 'import',
          line: lineOf(child),
        });
      }
      continue;
    }

    if (child.type === 'namespace_import') {
      const localNode = child.namedChild(0);
      const localName = textOf(localNode);
      if (localName) {
        bindings.push({
          localName,
          importedName: '*',
          moduleSpecifier,
          isTypeOnly: isTypeOnlyImport,
          sourceKind: 'import',
          line: lineOf(localNode ?? child),
        });
      }
      continue;
    }

    if (child.type !== 'named_imports') {
      continue;
    }

    for (let j = 0; j < child.namedChildCount; j += 1) {
      const specifier = child.namedChild(j);
      if (!specifier || specifier.type !== 'import_specifier') {
        continue;
      }

      const importedNode = specifier.childForFieldName('name') ?? specifier.namedChild(0);
      const aliasNode = specifier.childForFieldName('alias');
      const importedName = textOf(importedNode);
      const localName = textOf(aliasNode ?? importedNode);
      if (!importedName || !localName) {
        continue;
      }

      const isTypeOnly = isTypeOnlyImport || /\btype\b/.test(textOf(specifier));
      bindings.push({
        localName,
        importedName,
        moduleSpecifier,
        isTypeOnly,
        sourceKind: 'import',
        line: lineOf(specifier),
      });
    }
  }

  return bindings;
}

function extractImportBindings(language: SupportedLanguage, rootNode: any): ImportBinding[] {
  if (language === 'python') {
    return [];
  }

  const bindings: ImportBinding[] = [];

  for (let i = 0; i < rootNode.namedChildCount; i += 1) {
    const statement = rootNode.namedChild(i);
    if (!statement || statement.type !== 'import_statement') {
      continue;
    }

    const moduleSpecifier = extractModuleSpecifier(statement);
    if (!moduleSpecifier) {
      continue;
    }

    const clause = statement.childForFieldName('import') ?? statement.namedChild(0);
    if (!clause || clause.type === 'string') {
      // Side-effect import: `import './polyfill'`
      bindings.push({
        localName: `__side_effect__:${moduleSpecifier}`,
        importedName: '*',
        moduleSpecifier,
        isTypeOnly: false,
        sourceKind: 'import',
        line: lineOf(statement),
      });
      continue;
    }

    if (clause.type !== 'import_clause') {
      continue;
    }

    const isTypeOnlyImport = /^\s*import\s+type\b/.test(textOf(statement));
    bindings.push(...parseImportClauseBindings(clause, moduleSpecifier, isTypeOnlyImport));
  }

  return bindings;
}

export async function parseFileArtifacts(
  sourceFile: SourceFile,
  content: string,
): Promise<ParsedFileArtifacts> {
  const parser = parserFor(sourceFile.language);
  const query = await loadQuery(sourceFile.language);

  const tree = parser.parse(content);
  const matches = query.matches(tree.rootNode);

  const tags: Tag[] = [];
  for (const match of matches) {
    for (const capture of match.captures) {
      const tag = tagFromCapture(sourceFile, capture.name, capture.node);
      if (tag) {
        tags.push(tag);
      }
    }
  }

  const imports = extractImportBindings(sourceFile.language, tree.rootNode);
  return { tags, imports };
}

export async function parseTags(sourceFile: SourceFile, content: string): Promise<Tag[]> {
  const parsed = await parseFileArtifacts(sourceFile, content);
  return parsed.tags;
}
