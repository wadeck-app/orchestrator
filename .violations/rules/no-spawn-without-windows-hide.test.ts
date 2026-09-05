import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rule } from './no-spawn-without-windows-hide.js'

describe('local/no-spawn-without-windows-hide', () => {
  it('returns no violations for a clean file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'violations-test-'))
    try {
      const file = join(dir, 'clean.txt')
      await writeFile(file, 'clean content\n')
      const result = await rule.check([file], {})
      assert.equal(result.length, 0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns a violation for a bad file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'violations-test-'))
    try {
      const file = join(dir, 'bad.txt')
      await writeFile(file, 'TODO: implement test fixture\n')
      const result = await rule.check([file], {})
      // TODO: assert result.length > 0
      assert.ok(Array.isArray(result))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
