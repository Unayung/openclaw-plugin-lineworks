/**
 * Split text into LINE WORKS-safe chunks that:
 *   - stay under `limit` characters per chunk (default 2000, matching LINE
 *     WORKS's `content.text` length cap),
 *   - prefer cutting on newline boundaries when possible (no mid-sentence
 *     splits unless the limit leaves no choice).
 *
 * Returns `[text]` unchanged if already under the limit. Never returns empty
 * chunks; the final chunk can be shorter than the limit.
 */
export function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let end = Math.min(cursor + limit, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf("\n", end);
      if (nl > cursor + limit * 0.5) end = nl;
    }
    chunks.push(text.slice(cursor, end));
    cursor = end;
  }
  return chunks;
}

export const LINEWORKS_TEXT_CHUNK_LIMIT = 2000;
