/**
 * Which files in the swings folder belong to which swing, and which are leftovers to clean up.
 * Pure (names and ages in, a plan out) so it's testable without the file system.
 *
 * Per swing `swing_<epochMs>`:
 * - `.mp4` the clip, `.json` the engine's sidecar (written after the clip), `.jpg` the thumbnail
 * - `.b.mp4` + `.b.json` the second angle (`.b.mp4.part` while it arrives)
 * - `.user.json` the golfer's notes
 */

/** Every file a swing can have, as written after the stem. Longest first, so `.b.json` isn't read as `.json`. */
export const SWING_FILE_EXTENSIONS = ['b.mp4.part', 'user.json', 'b.mp4', 'b.json', 'mp4', 'json', 'jpg'] as const;
export type SwingFileExtension = (typeof SWING_FILE_EXTENSIONS)[number];

/** Files untouched for this long aren't being written any more. */
export const LEFTOVER_AGE_MS = 60_000;

const SWING_ID = /^swing_\d{1,16}$/;
const SWING_FILE = /^(swing_\d{1,16})\.(b\.mp4\.part|user\.json|b\.mp4|b\.json|mp4|json|jpg)$/;

/** A route or file id that can only name a swing in the swings folder (never a path). */
export const isSwingId = (id: unknown): id is string => typeof id === 'string' && SWING_ID.test(id);

/** What's on disk for one listed swing. */
export type SwingFileSet = {
  id: string;
  sidecar: boolean;
  thumb: boolean;
  /** `.b.mp4` (an angle without a `.b.json` can't be lined up, but still counts for storage). */
  angleClip: boolean;
  angleSidecar: boolean;
  notes: boolean;
};

export type SwingDirPlan = {
  swings: SwingFileSet[];
  /** File names to delete: pieces of a swing whose clip is gone, and transfers that never finished. */
  leftovers: string[];
};

/**
 * Pairs the folder's file names into swings.
 * - A clip with no sidecar that's still fresh is being written: not listed yet.
 * - A clip with no sidecar that's older is a half-written clip (the app died mid-save). It's listed,
 *   dated from its name, so it can be deleted.
 * - Anything left of a swing whose clip is gone (an angle, a thumbnail, notes) and a `.part` transfer
 *   that stopped is a leftover once it's stale.
 * Names that aren't swing files are ignored.
 * [modifiedAt] is only asked for files whose fate depends on their age.
 */
export function planSwingDir(
  names: readonly string[],
  modifiedAt: (name: string) => number | null,
  now = Date.now()
): SwingDirPlan {
  const groups = new Map<string, Set<SwingFileExtension>>();
  for (const name of names) {
    const match = SWING_FILE.exec(name);
    if (!match) continue;
    const [, id, ext] = match;
    const group = groups.get(id) ?? new Set<SwingFileExtension>();
    group.add(ext as SwingFileExtension);
    groups.set(id, group);
  }

  // Unknown age (unreadable) counts as stale: better listed or cleaned than hidden for ever.
  const stale = (name: string) => {
    const t = modifiedAt(name);
    return t == null || now - t >= LEFTOVER_AGE_MS;
  };

  const swings: SwingFileSet[] = [];
  const leftovers: string[] = [];
  for (const [id, exts] of groups) {
    const part = `${id}.b.mp4.part`;
    if (!exts.has('mp4')) {
      for (const ext of exts) {
        const name = `${id}.${ext}`;
        if (stale(name)) leftovers.push(name);
      }
      continue;
    }
    if (exts.has('b.mp4.part') && stale(part)) leftovers.push(part);
    if (!exts.has('json') && !stale(`${id}.mp4`)) continue;
    swings.push({
      id,
      sidecar: exts.has('json'),
      thumb: exts.has('jpg'),
      angleClip: exts.has('b.mp4'),
      angleSidecar: exts.has('b.json'),
      notes: exts.has('user.json'),
    });
  }
  return { swings, leftovers };
}
