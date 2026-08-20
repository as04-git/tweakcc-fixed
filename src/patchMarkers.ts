/**
 * Leaf module (no imports) so both the pristine-bundle resolver and the backup
 * path can ask "has tweakcc already written to this?" without an import cycle
 * through `config` or `utils`.
 */
import { createReadStream } from 'node:fs';

/**
 * Every tweakcc splice leaves at least one of these markers. A binary or cli.js
 * carrying them is patched, not pristine.
 */
export const PATCH_MARKERS = ['__tweakcc', 'tweakcc v'];

export const looksPatched = (content: string): boolean =>
  PATCH_MARKERS.some(marker => content.includes(marker));

const MAX_MARKER_LENGTH = Math.max(...PATCH_MARKERS.map(m => m.length));

/**
 * `looksPatched` for a file on disk, without reading it into memory.
 *
 * A native install is 300-750 MB, so the backup path cannot buffer it just to
 * answer this. The markers are ASCII and Bun stores the JS payload as Latin-1
 * bytes, so a byte-wise `latin1` scan finds them wherever they sit in the
 * bundle. Chunks overlap by one marker length so a marker straddling a chunk
 * boundary is still seen.
 *
 * Returns false when the file cannot be read: the caller decides what an
 * unreadable candidate means, and this must never report "patched" on an IO
 * error.
 */
export const fileLooksPatched = async (filePath: string): Promise<boolean> => {
  return new Promise(resolve => {
    let stream;
    try {
      stream = createReadStream(filePath, {
        encoding: 'latin1',
        highWaterMark: 8 << 20,
      });
    } catch {
      resolve(false);
      return;
    }
    let carry = '';
    let found = false;
    const finish = (result: boolean): void => {
      if (found) return;
      found = true;
      stream.destroy();
      resolve(result);
    };
    stream.on('data', chunk => {
      const window = carry + (chunk as string);
      if (looksPatched(window)) {
        finish(true);
        return;
      }
      carry = window.slice(-(MAX_MARKER_LENGTH - 1));
    });
    stream.on('error', () => finish(false));
    stream.on('close', () => finish(false));
    stream.on('end', () => finish(false));
  });
};
