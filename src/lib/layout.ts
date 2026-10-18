/**
 * Screen-size policy. Phones stay portrait (the golfer box and the one-handed controls assume it);
 * tablets, unfolded foldables and iPads rotate freely, since Android 16+ ignores a portrait lock on
 * screens 600 dp and wider and an iPad on a tripod is often mounted landscape.
 */

/** Android's own threshold for a "large screen": the smallest side in dp. */
export const LARGE_SCREEN_DP = 600;

/** Widest a list or settings column gets on a large screen; it's centred beyond this. */
export const MAX_CONTENT_WIDTH = 640;

/** Review and compare in landscape on a large screen: the dock sits in a column this wide. */
export const DOCK_COLUMN_WIDTH = 360;

export type Layout = {
  /** Tablet / unfolded foldable / iPad: rotation is allowed and screens may use a second column. */
  isLarge: boolean;
  isLandscape: boolean;
  width: number;
  height: number;
  /** Width for list and settings content (the whole width on phones). */
  contentWidth: number;
  /** Swing grid columns. */
  columns: number;
};

/** A large screen is one whose smaller side is at least 600 dp, whichever way it's held. */
export const isLargeScreen = (width: number, height: number) => Math.min(width, height) >= LARGE_SCREEN_DP;

export const contentWidthFor = (width: number) => Math.min(width, MAX_CONTENT_WIDTH);

/** Three columns on a phone, up to six as the screen widens (about 180 dp per tile). */
export const libraryColumns = (width: number) => Math.min(6, Math.max(3, Math.floor(width / 180)));

export function layoutFor(width: number, height: number): Layout {
  return {
    isLarge: isLargeScreen(width, height),
    isLandscape: width > height,
    width,
    height,
    contentWidth: contentWidthFor(width),
    columns: libraryColumns(width),
  };
}

/**
 * Where the camera picture sits inside the preview view: the native view letterboxes the stream
 * ("contain"), shown upright, so its shape follows the screen: a landscape sensor stream is a
 * portrait picture on a portrait screen and a landscape one on a landscape screen.
 */
export function previewAspect(format: { width: number; height: number } | null | undefined, landscape: boolean): number {
  const long = format ? Math.max(format.width, format.height) : 16;
  const short = format ? Math.min(format.width, format.height) : 9;
  return landscape ? long / short : short / long;
}
