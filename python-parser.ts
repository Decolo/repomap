
import { RepoMapper } from './repomap';



class PythonAnalyzer {
  private repoMapper: RepoMapper;

  constructor() {
    this.repoMapper = new RepoMapper();
  }

  public async analyzeRepository(rootDir: string): Promise<void> {
    try {
      // // 获取所有Python文件
      // const pythonFiles = await this.findPythonFiles(rootDir);
      // console.log(`Found ${pythonFiles.length} Python files`);
      // // 构建依赖图
      // await this.repoMapper.buildDependencyGraph(pythonFiles);

      
      // 计算并打印分析结果
      const result = await this.repoMapper.analyzeRepository(rootDir, 'test_repo/calculator/scientific.py');

      console.log('该文件依赖的文件', result);
      
    } catch (error) {
      console.error('Error analyzing repository:', error);
      throw error;
    }
  }
}

// 使用示例
async function main() {
  const analyzer = new PythonAnalyzer();
  await analyzer.analyzeRepository('./test_repo');
}

if (require.main === module) {
  main().catch(console.error);
}

export { PythonAnalyzer }; 