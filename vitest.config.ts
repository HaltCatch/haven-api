import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/**/*.e2e.test.ts'],
    coverage: {
      provider: 'v8',
      include: [
        'src/config.ts',
        'src/storage/repository.ts',
        'src/storage/delete-model.ts',
        'src/candidates/persistence.ts',
        'src/candidates/repository.ts',
        'src/candidates/requests.ts',
        'src/candidates/fingerprint.ts',
      ],
      reporter: ['text', 'json-summary'],
      thresholds: { statements: 80, branches: 70, functions: 80, lines: 80 },
    },
  },
});
