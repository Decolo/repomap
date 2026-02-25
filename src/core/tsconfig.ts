import * as fs from 'fs';
import * as path from 'path';

import ts from 'typescript';

import { logVerbose } from '../utils/log';
import { normalizeRepoPath } from '../utils/path';

export interface ModulePathResolver {
  resolve(sourceFile: string, moduleSpecifier: string): string[];
}

interface PathRule {
  pattern: string;
  hasWildcard: boolean;
  prefix: string;
  suffix: string;
  targets: string[];
}

function splitPattern(pattern: string): {
  hasWildcard: boolean;
  prefix: string;
  suffix: string;
} {
  const wildcard = pattern.indexOf('*');
  if (wildcard < 0) {
    return {
      hasWildcard: false,
      prefix: pattern,
      suffix: '',
    };
  }

  return {
    hasWildcard: true,
    prefix: pattern.slice(0, wildcard),
    suffix: pattern.slice(wildcard + 1),
  };
}

function computeWildcardValue(specifier: string, rule: PathRule): string | null {
  if (!rule.hasWildcard) {
    return specifier === rule.pattern ? '' : null;
  }

  if (!specifier.startsWith(rule.prefix) || !specifier.endsWith(rule.suffix)) {
    return null;
  }

  return specifier.slice(rule.prefix.length, specifier.length - rule.suffix.length);
}

function expandPathTarget(target: string, wildcardValue: string): string {
  if (!target.includes('*')) {
    return target;
  }
  return target.replace(/\*/g, wildcardValue);
}

function relPathFromAbs(rootDir: string, absPath: string): string {
  return normalizeRepoPath(path.relative(rootDir, absPath));
}

function chooseConfigPath(rootDir: string): string | null {
  const candidates = ['tsconfig.json', 'tsconfig.base.json'];
  for (const name of candidates) {
    const candidate = path.join(rootDir, name);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function parsePathRules(paths: Record<string, readonly string[]>): PathRule[] {
  const rules: PathRule[] = [];
  for (const [pattern, targets] of Object.entries(paths)) {
    const split = splitPattern(pattern);
    rules.push({
      pattern,
      hasWildcard: split.hasWildcard,
      prefix: split.prefix,
      suffix: split.suffix,
      targets: Array.from(targets),
    });
  }

  rules.sort((a, b) => {
    const aSpecificity = a.prefix.length + a.suffix.length;
    const bSpecificity = b.prefix.length + b.suffix.length;
    if (bSpecificity !== aSpecificity) {
      return bSpecificity - aSpecificity;
    }
    return a.pattern.localeCompare(b.pattern);
  });

  return rules;
}

export function loadModulePathResolver(rootDir: string, verbose: boolean): ModulePathResolver | null {
  const configPath = chooseConfigPath(rootDir);
  if (!configPath) {
    logVerbose(verbose, '[build] tsconfig not found. alias resolution disabled');
    return null;
  }

  const diagnostics: ts.Diagnostic[] = [];
  const host: ts.ParseConfigFileHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      diagnostics.push(diagnostic);
    },
  };

  const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    host,
  );

  if (!parsed) {
    logVerbose(verbose, `[build] failed to parse ${configPath}. alias resolution disabled`);
    return null;
  }

  if (diagnostics.length > 0) {
    logVerbose(verbose, `[build] ${configPath} produced ${diagnostics.length} config diagnostics`);
  }

  const options = parsed.options ?? {};
  const paths = (options.paths ?? {}) as Record<string, readonly string[]>;
  const rules = parsePathRules(paths);

  const rawPathsBase = (options as unknown as { pathsBasePath?: string }).pathsBasePath;
  const baseAbs = rawPathsBase
    ? path.resolve(rawPathsBase)
    : options.baseUrl
      ? path.resolve(options.baseUrl)
      : path.dirname(configPath);

  logVerbose(
    verbose,
    `[build] tsconfig resolver: ${path.basename(configPath)}, base=${relPathFromAbs(rootDir, baseAbs)}, rules=${rules.length}`,
  );

  return {
    resolve(_sourceFile: string, moduleSpecifier: string): string[] {
      if (moduleSpecifier.startsWith('.')) {
        return [];
      }

      const resolved = new Set<string>();

      for (const rule of rules) {
        const wildcardValue = computeWildcardValue(moduleSpecifier, rule);
        if (wildcardValue === null) {
          continue;
        }

        for (const target of rule.targets) {
          const expanded = expandPathTarget(target, wildcardValue);
          const abs = path.resolve(baseAbs, expanded);
          resolved.add(relPathFromAbs(rootDir, abs));
        }
      }

      if (options.baseUrl) {
        resolved.add(relPathFromAbs(rootDir, path.resolve(baseAbs, moduleSpecifier)));
      }

      return Array.from(resolved);
    },
  };
}
