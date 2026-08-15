import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // The mock PostHog server binds a real port. Serialising the files keeps
    // two suites from racing for it, which is cheaper than plumbing a port
    // allocator through every test.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
})
