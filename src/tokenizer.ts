const TOKEN_RUN = /[\p{L}\p{N}]+/gu
const CJK_CHARACTER = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u

/**
 * Tokenizes normalized text deterministically. CJK-only runs are retained as a
 * token and, when longer than one code point, additionally produce overlapping
 * two-code-point grams. Mixed/non-CJK letter-number runs are emitted whole.
 */
export function tokenize(value: string): readonly string[] {
  const normalized = value.normalize('NFKC').toLowerCase()
  const tokens: string[] = []

  for (const match of normalized.matchAll(TOKEN_RUN)) {
    const run = match[0]
    tokens.push(run)
    const characters = Array.from(run)
    if (characters.length > 1 && characters.every((character) => CJK_CHARACTER.test(character))) {
      for (let index = 0; index + 1 < characters.length; index += 1) {
        tokens.push(`${characters[index]}${characters[index + 1]}`)
      }
    }
  }

  return tokens
}
