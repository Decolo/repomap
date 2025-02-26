const Parser = require('tree-sitter');
const Python = require('tree-sitter-python');
import * as path from 'path';
import * as fs from 'fs';
import { MultiDirectedGraph } from 'graphology';
import { glob } from 'glob';
import pagerank from 'graphology-metrics/centrality/pagerank';

// 定义标签类型
interface Tag {
  relPath: string;     // 相对文件路径
  absPath: string;     // 绝对文件路径
  name: string;        // 标识符名称
  kind: 'def' | 'ref'; // 定义或引用
  line: number;        // 行号
  type: string;        // 具体类型(class/function/call等)
}

export class RepoMapper {
  private parser: typeof Parser;
  private graph: MultiDirectedGraph;
  private definitions: Map<string, Set<string>>; // name -> files
  private references: Map<string, string[]>;     // name -> files

  constructor() {
    // 初始化解析器
    this.parser = new Parser();
    this.parser.setLanguage(Python);
    
    // 初始化图和存储，添加 multi: true 选项
    this.graph = new MultiDirectedGraph();
    this.definitions = new Map();
    this.references = new Map();
  }

  private async loadQuery(language: string): Promise<string> {
    // 加载对应语言的查询文件
    const queryPath = path.join(__dirname, 'queries', `tree-sitter-${language}-tags.scm`);
    return fs.promises.readFile(queryPath, 'utf8');
  }

  private async parseFile(filePath: string): Promise<Tag[]> {
    const content = await fs.promises.readFile(filePath, 'utf8');
    const relPath = path.relative(process.cwd(), filePath);
    
    // 解析代码生成AST
    const tree = this.parser.parse(content);
    
    // 加载查询
    const queryString = await this.loadQuery('python');
    const query = new Parser.Query(Python, queryString);
    
    const tags: Tag[] = [];
    
    // 执行查询并收集结果
    const matches = query.matches(tree.rootNode);
    for (const match of matches) {
      for (const capture of match.captures) {
        const node = capture.node;
        const name = capture.name;
        
        // 解析标签类型
        let kind: 'def' | 'ref';
        let type: string;
        
        if (name.startsWith('name.definition.')) {
          kind = 'def';
          type = name.replace('name.definition.', '');
        } else if (name.startsWith('name.reference.')) {
          kind = 'ref';
          type = name.replace('name.reference.', '');
        } else {
          continue;
        }

        tags.push({
          relPath,
          absPath: filePath,
          name: node.text,
          kind,
          type,
          line: node.startPosition.row + 1
        });
      }
    }
    
    return tags;
  }

  public async buildDependencyGraph(files: string[]): Promise<void> {
    // 处理所有文件
    for (const file of files) {
      const tags = await this.parseFile(file);
      
      // 收集定义和引用
      for (const tag of tags) {
        if (tag.kind === 'def') {
          // 存储定义
          if (!this.definitions.has(tag.name)) {
            this.definitions.set(tag.name, new Set());
          }
          this.definitions.get(tag.name)!.add(tag.relPath);
          
          // 添加节点到图
          if (!this.graph.hasNode(tag.relPath)) {
            this.graph.addNode(tag.relPath);
          }
        } else {
          // 存储引用
          if (!this.references.has(tag.name)) {
            this.references.set(tag.name, []);
          }
          this.references.get(tag.name)!.push(tag.relPath);
        }
      }
    }

    // 构建依赖边
    for (const [name, refFiles] of this.references.entries()) {
      const defFiles = this.definitions.get(name);
      if (defFiles) {
        for (const refFile of refFiles) {
          for (const defFile of defFiles) {
            if (refFile !== defFile) {
              // 添加依赖边
              this.graph.addDirectedEdge(refFile, defFile, { name });
            }
          }
        }
      }
    }
  }

  public async analyzeRepository(rootDir: string, targetFile?: string): Promise<Array<{file: string, score: number, info: any}>> {
    // 获取所有Python文件
    const pythonFiles = await this.findPythonFiles(rootDir);
    
    // 构建依赖图
    await this.buildDependencyGraph(pythonFiles);

    this.printGraph();
    
    if (targetFile) {
      // 获取所有相关节点
      const relatedFiles = new Set<string>();
      debugger;
      
      // 获取该文件依赖的其他文件（出边）
      this.graph.outNeighbors(targetFile).forEach(neighbor => {
        relatedFiles.add(neighbor);
      });
      
      // 获取依赖该文件的其他文件（入边）
      this.graph.inNeighbors(targetFile).forEach(neighbor => {
        relatedFiles.add(neighbor);
      });

      // 添加目标文件本身
      // relatedFiles.add(targetFile);
      
      // 计算个性化 PageRank，调整参数格式
      const scores = pagerank(this.graph, {
        alpha: 0.85,
        personalization: this.getPersonalizationVector(targetFile, relatedFiles),
        maxIterations: 100,
        tolerance: 1e-6
      });

      debugger;

      // 返回排序后的相关文件及其信息
      return Array.from(relatedFiles)
        .map(file => ({
          file,
          score: scores[file],
          info: {
            outDegree: this.graph.outDegree(file),  // 该文件依赖的其他文件数
            inDegree: this.graph.inDegree(file),    // 依赖该文件的其他文件数
            outRefs: this.getOutgoingReferences(file),  // 该文件的外部引用
            inRefs: this.getIncomingReferences(file)    // 被其他文件引用的情况
          }
        }))
        .sort((a, b) => b.score - a.score);
    }
    
    return [];
  }

  // 为特定文件及其相关文件设置个性化向量
  private getPersonalizationVector(targetFile: string, relatedFiles: Set<string>) {
    const personalization = {};
    
    for (const node of this.graph.nodes()) {
      if (node === targetFile) {
        personalization[node] = 1.0;  // 目标文件最高权重
      } else if (relatedFiles.has(node)) {
        personalization[node] = 0.5;  // 相关文件较高权重
      } else {
        personalization[node] = 0.1;  // 其他文件基础权重
      }
    }
    
    return personalization;
  }

  // 获取文件的外部引用信息
  private getOutgoingReferences(file: string) {
    const refs = {};
    this.graph.outNeighbors(file).forEach(neighbor => {
      const edges = this.graph.outEdges(file, neighbor);
      refs[neighbor] = edges.map(edge => 
        this.graph.getEdgeAttribute(edge, 'name')
      );
    });
    return refs;
  }

  // 获取文件被引用的信息
  private getIncomingReferences(file: string) {
    const refs = {};
    this.graph.inNeighbors(file).forEach(neighbor => {
      const edges = this.graph.inEdges(file, neighbor);
      refs[neighbor] = edges.map(edge => 
        this.graph.getEdgeAttribute(edge, 'name')
      );
    });
    return refs;
  }

  private async findPythonFiles(rootDir: string): Promise<string[]> {
    const files = await glob('**/*.py', {
      cwd: rootDir,
      absolute: true,
      ignore: ['**/node_modules/**', '**/__pycache__/**', '**/.venv/**']
    });
    return files;
  }


  private printGraph(): void {
    console.log('\n=== 图结构 ===');
    
    // 打印所有节点
    console.log('\n节点列表:');
    this.graph.forEachNode(node => {
      console.log(`节点: ${node}`);
    });

    // 打印所有边
    console.log('\n边列表:');
    this.graph.forEachEdge((edge, attributes, source, target) => {
      const name = attributes.name || '未命名引用';
      console.log(`边: ${source} -> ${target} (${name})`);
    });

    // 打印每个节点的邻居关系
    console.log('\n节点依赖关系:');
    this.graph.forEachNode(node => {
      console.log(`\n节点 ${node}:`);
      
      // 输出边
      console.log('  依赖的文件:');
      this.graph.outNeighbors(node).forEach(neighbor => {
        const edges = this.graph.outEdges(node, neighbor);
        const references = edges
          .map(edge => this.graph.getEdgeAttribute(edge, 'name'))
          .join(', ');
        console.log(`    -> ${neighbor} (${references})`);
      });

      // 输入边
      console.log('  被依赖的文件:');
      this.graph.inNeighbors(node).forEach(neighbor => {
        const edges = this.graph.inEdges(node, neighbor);
        const references = edges
          .map(edge => this.graph.getEdgeAttribute(edge, 'name'))
          .join(', ');
        console.log(`    <- ${neighbor} (${references})`);
      });
    });

    // 打印一些基本统计信息
    console.log('\n图的统计信息:');
    console.log(`节点数量: ${this.graph.order}`);
    console.log(`边的数量: ${this.graph.size}`);
  }
}