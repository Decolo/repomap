export type TagKind = 'def' | 'ref';

export interface Tag {
  relPath: string;
  absPath: string;
  name: string;
  kind: TagKind;
  line: number;
  type: string;
}

export interface ImportBinding {
  localName: string;
  importedName: string;
  moduleSpecifier: string;
  isTypeOnly: boolean;
  sourceKind: 'import' | 're_export';
  line?: number;
}

export type SupportedLanguage = 'python' | 'javascript' | 'typescript' | 'tsx';

export interface FileRecord {
  hash: string;
  language: SupportedLanguage;
  tags: Tag[];
  imports: ImportBinding[];
  lastParsedAt: string;
}

export interface RepoMapState {
  version: number;
  generatedAt: string;
  repoRoot: string;
  files: Record<string, FileRecord>;
}

export interface BuildOptions {
  rootDir: string;
  maxWorkers: number;
  ignore: string[];
  verbose: boolean;
}

export interface UpdateOptions extends BuildOptions {
  diffRange?: string;
}

export interface RankedFile {
  file: string;
  score: number;
  features: {
    ppr: number;
    risk: number;
    boundaryImpact: number;
    testGap: number;
    freshness: number;
  };
  reasons: string[];
}

export interface ContextOptions {
  rootDir: string;
  topK: number;
  diffRange?: string;
  targetFiles: string[];
  outputPath?: string;
  verbose: boolean;
}

export interface ContextBundle {
  metadata: {
    generatedAt: string;
    rootDir: string;
    diffRange?: string;
    topK: number;
    seedFiles: string[];
    totalRankedFiles: number;
  };
  primary: RankedFile[];
  causal: RankedFile[];
  contract: RankedFile[];
  guardrail: RankedFile[];
}
