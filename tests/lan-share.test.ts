import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createShareServer, resolveSafe, listDir, countFiles, randomToken } from '../src/lan-share-core.js'

let dir: string
let server: ReturnType<typeof createShareServer>
let port: number
let token: string
let base: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-lan-share-test-'))
  writeFileSync(join(dir, 'hello.txt'), 'hello world')
  mkdirSync(join(dir, 'sub'))
  writeFileSync(join(dir, 'sub', 'data.json'), '{"a":1}')
  writeFileSync(join(dir, '.env'), 'SECRET=1')
  writeFileSync(join(dir, 'secret.key'), 'key-material')

  token = randomToken()
  server = createShareServer({ root: dir, port: 0, token })
  await new Promise<void>((r) => server.server.listen(0, '127.0.0.1', r))
  port = (server.server.address() as { port: number }).port
  base = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await new Promise<void>((r) => server.server.close(() => r()))
  rmSync(dir, { recursive: true, force: true })
})

function req(path: string, init?: RequestInit) {
  return fetch(base + path, init)
}

describe('resolveSafe', () => {
  it('allows paths inside root', () => {
    expect(resolveSafe(dir, 'sub/data.json')).toBe(join(dir, 'sub', 'data.json'))
  })
  it('rejects escaping paths', () => {
    expect(() => resolveSafe(dir, '../evil.txt')).toThrow()
    expect(() => resolveSafe(dir, 'C:\\evil.txt')).toThrow()
    expect(() => resolveSafe(dir, '/abs/other.txt')).toThrow()
  })
})

describe('token gate', () => {
  it('rejects API calls without token', async () => {
    const r = await req('/api/list')
    expect(r.status).toBe(401)
  })
  it('rejects wrong token', async () => {
    const r = await req('/api/list?token=wrong')
    expect(r.status).toBe(401)
  })
  it('accepts correct token via query', async () => {
    const r = await req(`/api/list?token=${token}`)
    expect(r.status).toBe(200)
  })
  it('accepts correct token via header', async () => {
    const r = await req('/api/list', { headers: { 'X-Token': token } })
    expect(r.status).toBe(200)
  })
  it('serves auth page on root without token', async () => {
    const r = await req('/')
    expect(r.status).toBe(401)
    expect(await r.text()).toContain('访问令牌')
  })
})

describe('list & download', () => {
  it('lists files hiding sensitive ones', async () => {
    const r = await req(`/api/list?token=${token}`)
    const data = (await r.json()) as { entries: { name: string; type: string }[] }
    const names = data.entries.map((e) => e.name)
    expect(names).toContain('hello.txt')
    expect(names).toContain('sub')
    expect(names).not.toContain('.env')
    expect(names).not.toContain('secret.key')
  })

  it('lists subdirectories', async () => {
    const r = await req(`/api/list?path=sub&token=${token}`)
    const data = (await r.json()) as { entries: { name: string }[] }
    expect(data.entries.map((e) => e.name)).toContain('data.json')
  })

  it('downloads file content', async () => {
    const r = await req(`/api/download?path=hello.txt&token=${token}`)
    expect(r.status).toBe(200)
    expect(await r.text()).toBe('hello world')
  })

  it('rejects download escaping root', async () => {
    const r = await req(`/api/download?path=../outside.txt&token=${token}`)
    expect(r.status).toBe(400)
  })
})

describe('read-write mode', () => {
  it('uploads a file', async () => {
    const r = await req(`/api/upload?path=uploaded.txt&token=${token}`, {
      method: 'POST',
      body: 'uploaded-content',
    })
    expect(r.status).toBe(200)
    expect(readFileSync(join(dir, 'uploaded.txt'), 'utf8')).toBe('uploaded-content')
  })

  it('uploads into subdirectory', async () => {
    const r = await req(`/api/upload?path=sub/new.txt&token=${token}`, {
      method: 'POST',
      body: 'nested',
    })
    expect(r.status).toBe(200)
    expect(readFileSync(join(dir, 'sub', 'new.txt'), 'utf8')).toBe('nested')
  })

  it('rejects upload escaping root', async () => {
    const r = await req(`/api/upload?path=../../evil.txt&token=${token}`, {
      method: 'POST',
      body: 'x',
    })
    expect(r.status).toBe(400)
  })

  it('deletes a file', async () => {
    const r = await req(`/api/delete?path=uploaded.txt&token=${token}`, { method: 'DELETE' })
    expect(r.status).toBe(200)
    const r2 = await req(`/api/list?token=${token}`)
    const data = (await r2.json()) as { entries: { name: string }[] }
    expect(data.entries.map((e) => e.name)).not.toContain('uploaded.txt')
  })

  it('moves a file', async () => {
    const r = await req(`/api/move?from=sub/new.txt&to=sub/moved.txt&token=${token}`, { method: 'POST' })
    expect(r.status).toBe(200)
    expect(readFileSync(join(dir, 'sub', 'moved.txt'), 'utf8')).toBe('nested')
  })
})

describe('read-only mode', () => {
  it('rejects upload in read-only server', async () => {
    const ro = createShareServer({ root: dir, port: 0, token, readOnly: true })
    await new Promise<void>((r) => ro.server.listen(0, '127.0.0.1', r))
    const roPort = (ro.server.address() as { port: number }).port
    try {
      const r = await fetch(`http://127.0.0.1:${roPort}/api/upload?path=x.txt&token=${token}`, {
        method: 'POST',
        body: 'x',
      })
      expect(r.status).toBe(400)
      expect(await r.text()).toContain('只读')
    } finally {
      await new Promise<void>((r) => ro.server.close(() => r()))
    }
  })

  it('rejects delete in read-only server', async () => {
    const ro = createShareServer({ root: dir, port: 0, token, readOnly: true })
    await new Promise<void>((r) => ro.server.listen(0, '127.0.0.1', r))
    const roPort = (ro.server.address() as { port: number }).port
    try {
      const r = await fetch(`http://127.0.0.1:${roPort}/api/delete?path=hello.txt&token=${token}`, {
        method: 'DELETE',
      })
      expect(r.status).toBe(400)
    } finally {
      await new Promise<void>((r) => ro.server.close(() => r()))
    }
  })
})

describe('helpers', () => {
  it('listDir returns dirs first sorted', () => {
    const entries = listDir(dir, '.', true)
    expect(entries[0]!.type).toBe('dir')
  })
  it('countFiles counts within depth', () => {
    const c = countFiles(dir, true)
    expect(c.files).toBeGreaterThanOrEqual(2)
    expect(c.dirs).toBeGreaterThanOrEqual(1)
  })
})
