import { Directory, File, Paths } from 'expo-file-system';

import { DELETE_ORDER, isSwingId, planSwingDir, type SwingFileSet } from './swing-files';
import { parseSwing, swingsToPrune, type AngleFile, type Swing } from './swing-library';
import { parseNotes, type SwingNotes } from './swing-notes';

/*
 * Reads never throw (a missing or unreadable file reads as absent). Writes report failure by their
 * return value instead of throwing into a button handler: a full phone makes File.write throw.
 */

/** The capture engine writes clips to <app files>/swings (Paths.document on both platforms). */
function swingsDir() {
  return new Directory(Paths.document, 'swings');
}

function readText(file: File): string | null {
  try {
    return file.exists ? file.textSync() : null;
  } catch {
    return null;
  }
}

async function readTextAsync(file: File): Promise<string | null> {
  try {
    return file.exists ? await file.text() : null;
  } catch {
    return null;
  }
}

function exists(file: File): boolean {
  try {
    return file.exists;
  } catch {
    return false;
  }
}

function sizeOf(file: File): number | null {
  try {
    return file.size;
  } catch {
    return null;
  }
}

/** The files a swing is built from, read once; `readSwing` / `readSwingAsync` differ only in how. */
function buildSwing(dir: Directory, files: SwingFileSet, json: string | null, angleJson: string | null, notes: string | null) {
  const { id } = files;
  const angleFile: AngleFile | null = files.angleClip
    ? { sidecarJson: angleJson, sizeBytes: sizeOf(new File(dir, `${id}.b.mp4`)) }
    : null;
  return parseSwing(`${id}.mp4`, dir.uri, json, files.thumb, sizeOf(new File(dir, `${id}.mp4`)), angleFile, notes);
}

function readSwing(dir: Directory, files: SwingFileSet): Swing | null {
  const { id } = files;
  return buildSwing(
    dir,
    files,
    files.sidecar ? readText(new File(dir, `${id}.json`)) : null,
    files.angleClip && files.angleSidecar ? readText(new File(dir, `${id}.b.json`)) : null,
    files.notes ? readText(new File(dir, `${id}.user.json`)) : null
  );
}

/** Reads the sidecars off the JS thread (`File.text()`), for the library's long list. */
async function readSwingAsync(dir: Directory, files: SwingFileSet): Promise<Swing | null> {
  const { id } = files;
  const [json, angleJson, notes] = await Promise.all([
    files.sidecar ? readTextAsync(new File(dir, `${id}.json`)) : null,
    files.angleClip && files.angleSidecar ? readTextAsync(new File(dir, `${id}.b.json`)) : null,
    files.notes ? readTextAsync(new File(dir, `${id}.user.json`)) : null,
  ]);
  return buildSwing(dir, files, json, angleJson, notes);
}

function deleteFile(file: File): boolean {
  try {
    if (file.exists) file.delete();
    return true;
  } catch {
    return false;
  }
}

/*
 * The library is read on every visit to Swings, Settings and "compare with". Nothing changes between
 * visits unless the engine saved a clip (new files: the folder's modification time moves) or this
 * module wrote a sidecar (it drops the cache itself), so the parsed list is kept until then.
 */
let cache: { key: string; swings: Swing[] } | null = null;

/** Called after every write from this module; native writes always add files, which the key sees. */
function invalidateLibrary() {
  cache = null;
}

/** The folder's modification time plus its listing; null when the time can't be read (then nothing is cached). */
function libraryKey(dir: Directory, names: readonly string[]): string | null {
  try {
    const t = dir.info().modificationTime;
    return t == null ? null : `${t}|${names.join(',')}`;
  } catch {
    return null;
  }
}

/** The folder's listing and what to do with it, or null when the folder is missing / unreadable. */
function planLibrary(): { dir: Directory; names: string[]; key: string | null } | null {
  const dir = swingsDir();
  try {
    if (!dir.exists) return null;
    const names = dir
      .list()
      .filter((f): f is File => f instanceof File)
      .map((f) => f.name);
    return { dir, names, key: libraryKey(dir, names) };
  } catch {
    return null;
  }
}

function swingDirPlan(dir: Directory, names: readonly string[]) {
  const plan = planSwingDir(names, (name) => {
    try {
      return new File(dir, name).lastModified;
    } catch {
      return null;
    }
  });
  for (const name of plan.leftovers) deleteFile(new File(dir, name));
  return plan;
}

const newestFirst = (swings: Swing[]) => swings.sort((a, b) => b.createdAt - a.createdAt);

/** All saved swings, newest first. Cleans up leftovers of deleted swings and failed transfers on the way. */
export function listSwings(): Swing[] {
  const listing = planLibrary();
  if (!listing) return [];
  if (cache && listing.key != null && cache.key === listing.key) return cache.swings;
  const plan = swingDirPlan(listing.dir, listing.names);
  const swings: Swing[] = [];
  for (const files of plan.swings) {
    const swing = readSwing(listing.dir, files);
    if (swing) swings.push(swing);
  }
  newestFirst(swings);
  if (listing.key != null && plan.leftovers.length === 0) cache = { key: listing.key, swings };
  return swings;
}

/** How many swings' sidecars are read before giving the UI a turn. */
const ASYNC_BATCH = 8;

/**
 * `listSwings` for screens: the same list, with the sidecars read off the JS thread in batches so a
 * library of hundreds of swings doesn't freeze the tab while it opens. Same cache, same order.
 */
export async function listSwingsAsync(): Promise<Swing[]> {
  const listing = planLibrary();
  if (!listing) return [];
  if (cache && listing.key != null && cache.key === listing.key) return cache.swings;
  const plan = swingDirPlan(listing.dir, listing.names);
  const swings: Swing[] = [];
  for (let i = 0; i < plan.swings.length; i += ASYNC_BATCH) {
    const batch = await Promise.all(plan.swings.slice(i, i + ASYNC_BATCH).map((files) => readSwingAsync(listing.dir, files)));
    for (const swing of batch) if (swing) swings.push(swing);
  }
  newestFirst(swings);
  // Another read may have filled the cache meanwhile; the folder can't have changed if the key still matches.
  if (listing.key != null && plan.leftovers.length === 0 && libraryKey(listing.dir, listing.names) === listing.key) {
    cache = { key: listing.key, swings };
  }
  return swings;
}

/** One swing, reading only its own files; null if it doesn't exist (or [id] isn't a swing id, from a deep link). */
export function getSwing(id: string | undefined): Swing | null {
  if (!isSwingId(id)) return null;
  const dir = swingsDir();
  const has = (ext: string) => exists(new File(dir, `${id}.${ext}`));
  if (!has('mp4')) return null;
  return readSwing(dir, {
    id,
    sidecar: has('json'),
    thumb: has('jpg'),
    angleClip: has('b.mp4'),
    angleSidecar: has('b.json'),
    notes: has('user.json'),
  });
}

/** Saves the review screen's manual alignment of a swing's second angle. False if it couldn't be written. */
export function setAngleNudge(id: string, nudgeMs: number): boolean {
  const sidecar = new File(swingsDir(), `${id}.b.json`);
  const text = readText(sidecar);
  if (text == null) return true; // No angle: nothing to save.
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(text);
  } catch {
    return true; // Unreadable: the angle isn't shown anyway.
  }
  try {
    sidecar.write(JSON.stringify({ ...meta, nudgeMs }));
    invalidateLibrary();
    return true;
  } catch {
    return false;
  }
}

/** Merges [patch] into a swing's notes and returns the result, or null if it couldn't be written. */
export function updateSwingNotes(id: string, patch: Partial<SwingNotes>): SwingNotes | null {
  const file = new File(swingsDir(), `${id}.user.json`);
  const next = { ...parseNotes(readText(file)), ...patch };
  try {
    file.write(JSON.stringify(next));
    invalidateLibrary();
    return next;
  } catch {
    return null;
  }
}

/** Removes the clip, its second angle and their thumbnails / sidecars. False if anything was left behind. */
export function deleteSwing(id: string): boolean {
  return deleteSwings([id]);
}

export function deleteSwings(ids: readonly string[]): boolean {
  const dir = swingsDir();
  invalidateLibrary();
  let ok = true;
  for (const id of ids) {
    if (!isSwingId(id)) continue;
    // The clip last: if a delete fails part way, the swing is still listed and can be deleted again.
    for (const ext of DELETE_ORDER) {
      if (!deleteFile(new File(dir, `${id}.${ext}`))) ok = false;
    }
  }
  return ok;
}

/** Applies the auto-delete setting. False if some files couldn't be deleted. Never throws. */
export function pruneOldSwings(days: number): boolean {
  if (days <= 0) return true;
  return deleteSwings(swingsToPrune(listSwings(), days));
}

let prunedThisLaunch = false;

/** Auto-delete runs once per app launch (from Capture), not on every visit: it reads the whole library. */
export function pruneOldSwingsOnce(days: number) {
  if (prunedThisLaunch) return;
  prunedThisLaunch = true;
  pruneOldSwings(days);
}

/** The newest swing, without reading every swing's files (Capture's "last swing" button). */
export function latestSwing(): Swing | null {
  const dir = swingsDir();
  try {
    if (!dir.exists) return null;
    // Stems are the save time, so the newest is the biggest number.
    const ids = dir
      .list()
      .map((f) => /^(swing_\d{1,16})\.mp4$/.exec(f.name)?.[1])
      .filter(isSwingId)
      .sort((a, b) => Number(b.slice(6)) - Number(a.slice(6)));
    for (const id of ids.slice(0, 3)) {
      const swing = getSwing(id);
      // A clip still being written has no sidecar yet; skip it like the library does.
      if (swing && exists(new File(dir, `${id}.json`))) return swing;
    }
  } catch {
    // Fall through: no button is better than a crash.
  }
  return null;
}
