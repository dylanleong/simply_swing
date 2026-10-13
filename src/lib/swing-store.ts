import { Directory, File, Paths } from 'expo-file-system';

import { parseSwing, swingsToPrune, type AngleFile, type Swing } from './swing-library';

/** The capture engine writes clips to <app files>/swings (Paths.document on both platforms). */
function swingsDir() {
  return new Directory(Paths.document, 'swings');
}

function readText(file: File): string | null {
  try {
    return file.textSync();
  } catch {
    return null;
  }
}

function readAngle(dir: Directory, stem: string): AngleFile {
  const sidecar = new File(dir, `${stem}.b.json`);
  return {
    sidecarJson: sidecar.exists ? readText(sidecar) : null,
    sizeBytes: new File(dir, `${stem}.b.mp4`).size,
  };
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
    const json = sidecar ? readText(sidecar) : null;
    const angleFile = names.has(`${stem}.b.mp4`) ? readAngle(dir, stem) : null;
    const swing = parseSwing(f.name, dir.uri, json, names.has(`${stem}.jpg`), f.size, angleFile);
    if (swing) swings.push(swing);
  }
  return swings.sort((a, b) => b.createdAt - a.createdAt);
}

export function getSwing(id: string): Swing | null {
  return listSwings().find((s) => s.id === id) ?? null;
}

/** Saves the review screen's manual alignment of a swing's second angle. */
export function setAngleNudge(id: string, nudgeMs: number) {
  const sidecar = new File(swingsDir(), `${id}.b.json`);
  if (!sidecar.exists) return;
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(sidecar.textSync());
  } catch {
    return; // Unreadable: the angle isn't shown anyway.
  }
  sidecar.write(JSON.stringify({ ...meta, nudgeMs }));
}

/** Removes the clip, its second angle and their thumbnails / sidecars. */
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
    for (const ext of ['mp4', 'jpg', 'json', 'b.mp4', 'b.json']) {
      const f = new File(dir, `${id}.${ext}`);
      if (f.exists) f.delete();
    }
  }
}
