import { createHash } from 'node:crypto'
import { lstat, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { atomicWriteFile } from '../src/atomic.ts'
import { LlmWikiError } from '../src/errors.ts'
import { sourceId } from '../src/ids.ts'
import {
  decodeUtf8,
  encodeUtf8,
  parsePageMarkdown,
  renderPageMarkdown,
  splitMarkdownSections,
} from '../src/markdown.ts'

const roots = new Set<string>()
const SOURCE_A = sourceId('1'.repeat(64))
const SOURCE_B = sourceId('2'.repeat(64))
const metadata = {
  title: 'A title: "quoted" # literal',
  summary: 'Unicode café 中文: # evidence',
  sources: [SOURCE_A, SOURCE_B],
} as const

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-llmwiki-c03-'))
  roots.add(root)
  return root
}
function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function siblingTemps(target: string): Promise<readonly string[]> {
  const names = await readdir(dirname(target))
  return names.filter((name) => name.includes(`.${basename(target)}.tmp-`))
}


afterEach(async () => {
  const pending = [...roots]
  roots.clear()
  await Promise.all(pending.map(async (root) => rm(root, { recursive: true, force: true })))
  await Promise.all(pending.map(async (root) => expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' })))
})

describe('UTF-8 and canonical Markdown', () => {
  it('round-trips canonical output twice byte-for-byte', () => {
    const first = renderPageMarkdown(metadata, 'Intro\r\n\r\n## Evidence\r\nBody')
    const parsedFirst = parsePageMarkdown(first)
    const second = renderPageMarkdown(parsedFirst.metadata, parsedFirst.body)
    const parsedSecond = parsePageMarkdown(second)
    const third = renderPageMarkdown(parsedSecond.metadata, parsedSecond.body)

    expect(encodeUtf8(second)).toEqual(encodeUtf8(first))
    expect(encodeUtf8(third)).toEqual(encodeUtf8(first))
    expect(first).toBe(
      `---\ntitle: "A title: \\"quoted\\" # literal"\nsummary: "Unicode café 中文: # evidence"\nsources:\n  - "${SOURCE_A}"\n  - "${SOURCE_B}"\n---\n\nIntro\n\n## Evidence\nBody\n`,
    )
    expect(parsedFirst.bodyStartLine).toBe(9)
  })

  it('encodes Unicode exactly and rejects malformed UTF-8', () => {
    const text = 'ASCII café 中文 🧪'
    expect(decodeUtf8(encodeUtf8(text))).toBe(text)
    expect(() => decodeUtf8(Uint8Array.from([0xc3, 0x28]))).toThrowError(
      expect.objectContaining({ code: 'INVALID_PAGE' }),
    )
  })

  it.each([
    ['title', 'U+2028', '\u2028'],
    ['title', 'U+2029', '\u2029'],
    ['summary', 'U+2028', '\u2028'],
    ['summary', 'U+2029', '\u2029'],
  ] as const)('rejects %s containing %s during render and parse', (field, _label, separator) => {
    expect(() => renderPageMarkdown({ ...metadata, [field]: `before${separator}after` }, 'body')).toThrowError(
      expect.objectContaining({ code: 'INVALID_PAGE' }),
    )

    const title = field === 'title' ? `before${separator}after` : 'valid title'
    const summary = field === 'summary' ? `before${separator}after` : 'valid summary'
    const markdown = `---\ntitle: ${JSON.stringify(title)}\nsummary: ${JSON.stringify(summary)}\nsources:\n  - "${SOURCE_A}"\n---\n\nbody\n`
    expect(() => parsePageMarkdown(markdown)).toThrowError(expect.objectContaining({ code: 'INVALID_PAGE' }))
  })

  it('sorts evidence IDs, rejects duplicates, and normalizes only line endings/final newline', () => {
    const rendered = renderPageMarkdown({ ...metadata, sources: [SOURCE_B, SOURCE_A] }, '  body  \r\n\r\n')
    expect(rendered).toContain(`  - "${SOURCE_A}"\n  - "${SOURCE_B}"`)
    expect(rendered.endsWith('\n')).toBe(true)
    expect(parsePageMarkdown(rendered).body).toBe('  body  \n')
    expect(() => renderPageMarkdown({ ...metadata, sources: [SOURCE_A, SOURCE_A] }, 'body')).toThrowError(
      expect.objectContaining({ code: 'INVALID_PAGE' }),
    )
  })

  it('preserves relative links and body bytes across the UTF-8 size boundary', () => {
    const body = '[local](../other-page.md#part) and [external](https://example.test/a:b#c)\n' + '界'.repeat(32)
    const rendered = renderPageMarkdown(metadata, body)
    const parsed = parsePageMarkdown(rendered)
    expect(parsed.body).toBe(`${body}\n`)
    expect(encodeUtf8(parsed.body)).toHaveLength(encodeUtf8(body).length + 1)
  })

  it.each([
    ['missing opener', 'title: "x"\n---\n\nbody\n'],
    ['missing closer', '---\ntitle: "x"\n'],
    ['unknown key', `---\ntitle: "x"\nsummary: "y"\nunknown: "z"\nsources:\n  - "${SOURCE_A}"\n---\n\nbody\n`],
    ['duplicate key', `---\ntitle: "x"\ntitle: "y"\nsummary: "z"\nsources:\n  - "${SOURCE_A}"\n---\n\nbody\n`],
    ['missing key', `---\ntitle: "x"\nsources:\n  - "${SOURCE_A}"\n---\n\nbody\n`],
    ['blank scalar', `---\ntitle: "  "\nsummary: "y"\nsources:\n  - "${SOURCE_A}"\n---\n\nbody\n`],
    ['plain scalar', `---\ntitle: x\nsummary: "y"\nsources:\n  - "${SOURCE_A}"\n---\n\nbody\n`],
    ['alias', `---\ntitle: *name\nsummary: "y"\nsources:\n  - "${SOURCE_A}"\n---\n\nbody\n`],
    ['anchor', `---\ntitle: &name "x"\nsummary: "y"\nsources:\n  - "${SOURCE_A}"\n---\n\nbody\n`],
    ['tag', `---\ntitle: !!str "x"\nsummary: "y"\nsources:\n  - "${SOURCE_A}"\n---\n\nbody\n`],
    ['literal multiline', `---\ntitle: |\n  x\nsummary: "y"\nsources:\n  - "${SOURCE_A}"\n---\n\nbody\n`],
    ['folded multiline', `---\ntitle: >\n  x\nsummary: "y"\nsources:\n  - "${SOURCE_A}"\n---\n\nbody\n`],
    ['flow list', `---\ntitle: "x"\nsummary: "y"\nsources: ["${SOURCE_A}"]\n---\n\nbody\n`],
    ['malformed list', `---\ntitle: "x"\nsummary: "y"\nsources:\n - "${SOURCE_A}"\n---\n\nbody\n`],
    ['invalid source', '---\ntitle: "x"\nsummary: "y"\nsources:\n  - "bad"\n---\n\nbody\n'],
    ['duplicate source', `---\ntitle: "x"\nsummary: "y"\nsources:\n  - "${SOURCE_A}"\n  - "${SOURCE_A}"\n---\n\nbody\n`],
    ['unsorted sources', `---\ntitle: "x"\nsummary: "y"\nsources:\n  - "${SOURCE_B}"\n  - "${SOURCE_A}"\n---\n\nbody\n`],
    ['blank frontmatter line', `---\ntitle: "x"\n\nsummary: "y"\nsources:\n  - "${SOURCE_A}"\n---\n\nbody\n`],
    ['no separator blank', `---\ntitle: "x"\nsummary: "y"\nsources:\n  - "${SOURCE_A}"\n---\nbody\n`],
    ['empty body', `---\ntitle: "x"\nsummary: "y"\nsources:\n  - "${SOURCE_A}"\n---\n\n \n`],
  ])('rejects unsupported or malformed frontmatter: %s', (_name, markdown) => {
    expect(() => parsePageMarkdown(markdown)).toThrowError(expect.objectContaining({ code: 'INVALID_PAGE' }))
  })

  it('handles exact source fixture byte variations without changing them', async () => {
    const [sourceA, sourceB] = await Promise.all([
      readFile(new URL('./fixtures/corpus/source-a.txt', import.meta.url)),
      readFile(new URL('./fixtures/corpus/source-b.txt', import.meta.url)),
    ])
    expect(decodeUtf8(sourceA)).toContain('ASCII')
    expect(decodeUtf8(sourceA)).toContain('中文')
    expect(sourceA.at(-1)).toBe(0x0a)
    expect(sourceB.at(-1)).not.toBe(0x0a)
    expect(Buffer.from(encodeUtf8(decodeUtf8(sourceA)))).toEqual(sourceA)
    expect(Buffer.from(encodeUtf8(decodeUtf8(sourceB)))).toEqual(sourceB)
  })
})

describe('ATX sections', () => {
  it('tracks hierarchy, repeated headings, preamble, fences, and exact lines', () => {
    const sections = splitMarkdownSections(
      'Preamble\n\n# One\nalpha\n## Child\nbeta\n```md\n# not heading\n```\n## Child\ngamma\n# Two\ndelta\n',
      8,
    )
    expect(sections).toEqual([
      { headingTrail: [], startLine: 8, text: 'Preamble' },
      { headingTrail: ['One'], startLine: 10, text: 'alpha' },
      { headingTrail: ['One', 'Child'], startLine: 12, text: 'beta\n```md\n# not heading\n```' },
      { headingTrail: ['One', 'Child'], startLine: 17, text: 'gamma' },
      { headingTrail: ['Two'], startLine: 19, text: 'delta' },
    ])
  })

  it('supports tilde fences and closing ATX hashes without treating body hashes as headings', () => {
    expect(splitMarkdownSections('# Title ###\n~~~\n## code\n~~~\ntext')).toEqual([
      { headingTrail: ['Title'], startLine: 1, text: '~~~\n## code\n~~~\ntext' },
    ])
  })

  it('replaces an H3 ancestor when an H2 follows it', () => {
    expect(splitMarkdownSections('### Deep\ndeep body\n## Parent\nparent body', 20)).toEqual([
      { headingTrail: ['Deep'], startLine: 20, text: 'deep body' },
      { headingTrail: ['Parent'], startLine: 22, text: 'parent body' },
    ])
  })

  it('retains the H2 ancestor when H4 is followed by H3, with fences and exact lines', () => {
    expect(splitMarkdownSections('## Parent\nparent\n#### Deep\n```md\n### fenced\n```\ndeep\n### Sibling\nsibling', 30)).toEqual([
      { headingTrail: ['Parent'], startLine: 30, text: 'parent' },
      { headingTrail: ['Parent', 'Deep'], startLine: 32, text: '```md\n### fenced\n```\ndeep' },
      { headingTrail: ['Parent', 'Sibling'], startLine: 37, text: 'sibling' },
    ])
  })
})

describe('atomic replacement', () => {
  it('commits complete bytes and leaves no sibling temporary file', async () => {
    const root = await temporaryRoot()
    const target = join(root, 'page.md')
    const oldBytes = encodeUtf8('old\n')
    const newBytes = encodeUtf8(renderPageMarkdown(metadata, '# Complete\nbody'))
    await writeFile(target, oldBytes)
    await atomicWriteFile(target, newBytes)
    expect(await readFile(target)).toEqual(Buffer.from(newBytes))
    expect(await siblingTemps(target)).toEqual([])
  })

  it('preserves the previous hash and cleans up after rename failure', async () => {
    const root = await temporaryRoot()
    const target = join(root, 'page.md')
    const oldBytes = encodeUtf8('old bytes\n')
    await writeFile(target, oldBytes)
    await expect(atomicWriteFile(target, encodeUtf8('new bytes\n'), {
      operations: { rename: () => Promise.reject(new Error('injected rename failure')) },
    })).rejects.toThrow('injected rename failure')
    expect(hash(await readFile(target))).toBe(hash(oldBytes))
    expect(await siblingTemps(target)).toEqual([])
  })

  it('preserves the previous hash and cleans up after write failure', async () => {
    const root = await temporaryRoot()
    const target = join(root, 'page.md')
    const oldBytes = encodeUtf8('old bytes\n')
    await writeFile(target, oldBytes)
    const realOpen = open
    await expect(atomicWriteFile(target, encodeUtf8('new bytes\n'), {
      operations: {
        open: async (path, flags, mode) => {
          const handle = await realOpen(path, flags, mode)
          return Object.assign(handle, {
            writeFile: () => Promise.reject(new Error('injected write failure')),
          })
        },
      },
    })).rejects.toThrow('injected write failure')
    expect(hash(await readFile(target))).toBe(hash(oldBytes))
    expect(await siblingTemps(target)).toEqual([])
  })

  it('syncs written bytes before rename and tolerates unsupported file durability sync', async () => {
    const root = await temporaryRoot()
    const target = join(root, 'page.md')
    const events: string[] = []
    const realOpen = open

    await atomicWriteFile(target, encodeUtf8('durable\n'), {
      operations: {
        open: async (path, flags, mode) => {
          const handle = await realOpen(path, flags, mode)
          if (typeof flags === 'string') {
            const write = handle.writeFile.bind(handle)
            const close = handle.close.bind(handle)
            return Object.assign(handle, {
              writeFile: async (bytes: Uint8Array) => { events.push('write'); await write(bytes) },
              sync: () => { events.push('sync'); return Promise.reject(Object.assign(new Error('unsupported sync'), { code: 'EINVAL' })) },
              close: async () => { events.push('close'); await close() },
            })
          }
          return handle
        },
        rename: async (from, to) => { events.push('rename'); await rename(from, to) },
      },
    })

    expect(events).toEqual(['write', 'sync', 'close', 'rename'])
    expect(await readFile(target, 'utf8')).toBe('durable\n')
    expect(await siblingTemps(target)).toEqual([])
  })

  it('keeps the primary sync failure when cleanup operations also fail', async () => {
    const root = await temporaryRoot()
    const target = join(root, 'page.md')
    await writeFile(target, 'previous\n')
    const realOpen = open

    await expect(atomicWriteFile(target, encodeUtf8('replacement\n'), {
      operations: {
        open: async (path, flags, mode) => {
          const handle = await realOpen(path, flags, mode)
          if (typeof flags !== 'string') return handle
          const close = handle.close.bind(handle)
          return Object.assign(handle, {
            sync: () => Promise.reject(new Error('primary sync failure')),
            close: async () => { await close(); throw new Error('cleanup close failure') },
          })
        },
        unlink: async (path) => { await rm(path); throw new Error('cleanup unlink failure') },
      },
    })).rejects.toThrow('primary sync failure')

    expect(await readFile(target, 'utf8')).toBe('previous\n')
    expect(await siblingTemps(target)).toEqual([])
  })

  it('keeps a committed replacement when directory sync cannot be opened', async () => {
    const root = await temporaryRoot()
    const target = join(root, 'page.md')
    const realOpen = open

    await atomicWriteFile(target, encodeUtf8('committed\n'), {
      operations: {
        open: (path, flags, mode) => typeof flags === 'number'
          ? Promise.reject(Object.assign(new Error('directory sync unavailable'), { code: 'EPERM' }))
          : realOpen(path, flags, mode),
      },
    })

    expect(await readFile(target, 'utf8')).toBe('committed\n')
    expect(await siblingTemps(target)).toEqual([])
  })

  it('preserves the previous target and removes the temp on a mid-operation abort', async () => {
    const root = await temporaryRoot()
    const target = join(root, 'page.md')
    const oldBytes = encodeUtf8('old bytes\n')
    await writeFile(target, oldBytes)
    let checks = 0
    const signal = { get aborted() { checks += 1; return checks >= 3 } } as AbortSignal
    await expect(atomicWriteFile(target, encodeUtf8('new bytes\n'), { signal })).rejects.toMatchObject({ code: 'ABORTED' })
    expect(hash(await readFile(target))).toBe(hash(oldBytes))
    expect(await siblingTemps(target)).toEqual([])
  })

  it('does not report a late abort after rename has committed', async () => {
    const root = await temporaryRoot()
    const target = join(root, 'page.md')
    const controller = new AbortController()
    await writeFile(target, 'old')
    await atomicWriteFile(target, encodeUtf8('complete\n'), {
      signal: controller.signal,
      operations: {
        rename: async (from, to) => {
          await rename(from, to)
          controller.abort()
        },
      },
    })
    expect(await readFile(target, 'utf8')).toBe('complete\n')
    expect(await siblingTemps(target)).toEqual([])
  })

  it('does not create a temp when path validation fails', async () => {
    const root = await temporaryRoot()
    const target = join(root, 'page.md')
    const oldBytes = encodeUtf8('old bytes\n')
    await writeFile(target, oldBytes)
    await expect(atomicWriteFile(target, encodeUtf8('new bytes\n'), {
      assertSafe: () => Promise.reject(new LlmWikiError('UNSAFE_FILESYSTEM', 'injected unsafe path')),
    })).rejects.toMatchObject({ code: 'UNSAFE_FILESYSTEM' })
    expect(hash(await readFile(target))).toBe(hash(oldBytes))
    expect(await siblingTemps(target)).toEqual([])
  })

  it('maps a pre-aborted write to the stable domain error without creating files', async () => {
    const root = await temporaryRoot()
    const target = join(root, 'page.md')
    const controller = new AbortController()
    controller.abort()
    await expect(atomicWriteFile(target, encodeUtf8('never'), { signal: controller.signal })).rejects.toBeInstanceOf(
      LlmWikiError,
    )
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await siblingTemps(target)).toEqual([])
  })
})
