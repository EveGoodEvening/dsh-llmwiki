const TOKEN_RUN = /[\p{L}\p{N}]+/gu
const CJK_CHARACTER = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u

/**
 * Tokenizes normalized text deterministically. CJK-only runs are retained as a
 * token and, when longer than one code point, additionally produce overlapping
 * two-code-point grams. Mixed/non-CJK letter-number runs are emitted whole.
 */
export function tokenize(value: string): readonly string[] {
  const tokens: string[] = []
  visitNormalizedTokenSpans(value.normalize('NFKC').toLowerCase(), (term) => { tokens.push(term) })
  return tokens
}

/** Visits existing tokens in normalized text; offsets are UTF-16 slice boundaries. */
export function visitNormalizedTokenSpans(text: string, visit: (term: string, start: number, end: number) => void): void {
  for (const match of text.matchAll(TOKEN_RUN)) {
    const run = match[0]
    const start = match.index
    visit(run, start, start + run.length)
    const characters = Array.from(run)
    if (characters.length > 1 && characters.every((character) => CJK_CHARACTER.test(character))) {
      let offset = start
      for (let index = 0; index + 1 < characters.length; index += 1) {
        const gram = `${characters[index]}${characters[index + 1]}`
        visit(gram, offset, offset + gram.length)
        offset += characters[index]!.length
      }
    }
  }
}
