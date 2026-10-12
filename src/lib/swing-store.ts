import { Directory, File, Paths } from 'expo-file-system';

import { parseSwing, swingsToPrune, type Swing } from './swing-library';

/** The capture engine writes clips to <app files>/swings (Paths.document on both platforms). */
function swingsDir() {
  return new Directory(Paths.document, 'swings');
}

/** All saved swings, newest first. */
export function listSwings(): Swing[] {
  const dir = swingsDir();
  if (!dir.exists) return [];
  const files = dir.list().filter((f): f is File => f instanceof File);
  const names = new Set(files.map((f) => f.name));
  const swings: Swing[] = [];
  for (const f of files) {
    if (!f.name.endsWith('.mp4')) continue;
    const stem = f.name.slice(0, -'.mp4'.length);
    const sidecar = names.has(`${stem}.json`) ? new File(dir, `${stem}.json`) : null;
    let json: string | null = null;
    try {
      json = sidecar ? sidecar.textSync() : null;
    } catch {
      json = null;
    }
    const swing = parseSwing(f.name, dir.uri, json, names.has(`${stem}.jpg`), f.size);
    if (swing) swings.push(swing);
  }
  return swings.sort((a, b) => b.createdAt - a.createdAt);
}

export function getSwing(id: string): Swing | null {
  return listSwings().find((s) => s.id === id) ?? null;
}

/** Removes the clip and its thumbnail / sidecar. */
export function deleteSwing(id: string) {
  deleteSwings([id]);
}

/** Applies the auto-delete setting. Returns how many swings were removed. */
export function pruneOldSwings(days: number): number {
  const ids = swingsToPrune(listSwings(), days);
  deleteSwings(ids);
  return ids.length;
}

export function deleteSwings(ids: readonly string[]) {
  const dir = swingsDir();
  for (const id of ids) {
    for (const ext of ['mp4', 'jpg', 'json']) {
      const f = new File(dir, `${id}.${ext}`);
      if (f.exists) f.delete();
    }
  }
}
