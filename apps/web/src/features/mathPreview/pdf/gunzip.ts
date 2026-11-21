/** Past this much text a SyncTeX file belongs to a document too large to preview from (the KaTeX drawing stays). */
export const MAX_SYNCTEX_TEXT = 50 * 1024 * 1024;

/** The gzipped bytes as text, or a throw past `max` characters or on bytes that are not gzip. */
export async function gunzipText(bytes: ArrayBuffer | Uint8Array, max = MAX_SYNCTEX_TEXT): Promise<string> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new Error('SyncTeX file too large');
    }
    parts.push(decoder.decode(value, { stream: true }));
  }
  parts.push(decoder.decode());
  return parts.join('');
}
