import type { Config } from '@jest/types';

const config: Config.InitialOptions = {
  // 指定测试环境
  preset: 'ts-jest',
  testEnvironment: 'node',
  
  // 指定测试文件的匹配模式
  testMatch: [
    '**/__tests__/**/*.test.ts',
    '**/__tests__/**/*.spec.ts',
    '**/tests/**/*.test.ts',
    '**/tests/**/*.spec.ts'
  ],
  
  // 指定需要转换的文件
  transform: {
    '^.+\\.tsx?$': 'ts-jest'
  },
  
  // 指定覆盖率收集
  collectCoverage: true,
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'clover'],
  
  // 指定需要收集覆盖率的文件
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/__tests__/**'
  ],
  
  // 指定覆盖率阈值
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80
    }
  },
  
  // 设置测试超时时间（毫秒）
  testTimeout: 10000,
  
  // 在执行测试之前要运行的代码
  setupFiles: ['dotenv/config'],
  
  // 显示详细的测试输出
  verbose: true
};

export default config;
