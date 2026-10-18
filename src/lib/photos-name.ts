import { Platform } from 'react-native';

/** What the phone calls the place saved videos go: "Photos" on iOS, "gallery" on Android. */
export const PHOTOS: string = Platform.select({ ios: 'Photos', default: 'gallery' });

/** The menu row: "Save to Photos" / "Save to gallery". */
export const SAVE_TO_PHOTOS = `Save to ${PHOTOS}`;
