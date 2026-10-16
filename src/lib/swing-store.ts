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

function readSwing(dir: Directory, files: SwingFileSet): Swing | null {
  const { id } = files;
  const clip = new File(dir, `${id}.mp4`);
  const json = files.sidecar ? readText(new File(dir, `${id}.json`)) : null;
  const angleFile: AngleFile | null = files.angleClip
    ? {
        sidecarJson: files.angleSidecar ? readText(new File(dir, `${id}.b.json`)) : null,
        sizeBytes: sizeOf(new File(dir, `${id}.b.mp4`)),
      }
    : null;
  const notes = files.notes ? readText(new File(dir, `${id}.user.json`)) : null;
  return parseSwing(`${id}.mp4`, dir.uri, json, files.thumb, sizeOf(clip), angleFile, notes);
}

function deleteFile(file: File): boolean {
  try {
    if (file.exists) file.delete();
    return true;
  } catch {
    return false;
  }
}

/** All saved swings, newest first. Cleans up leftovers of deleted swings and failed transfers on the way. */
export function listSwings(): Swing[] {
  const dir = swingsDir();
  let names: string[];
  try {
    if (!dir.exists) return [];
    names = dir
      .list()
      .filter((f): f is File => f instanceof File)
      .map((f) => f.name);
  } catch {
    return [];
  }
  const plan = planSwingDir(names, (name) => {
    try {
      return new File(dir, name).lastModified;
    } catch {
      return null;
    }
  });
  for (const name of plan.leftovers) deleteFile(new File(dir, name));
  const swings: Swing[] = [];
  for (const files of plan.swings) {
    const swing = readSwing(dir, files);
    if (swing) swings.push(swing);
  }
  return swings.sort((a, b) => b.createdAt - a.createdAt);
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
