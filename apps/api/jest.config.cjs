module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }]
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/main.ts', '!src/database/migrate.ts'],
  coverageDirectory: 'coverage',
  testEnvironment: 'node'
};
