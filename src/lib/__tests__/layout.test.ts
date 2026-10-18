import { contentWidthFor, isLargeScreen, layoutFor, libraryColumns, previewAspect } from '../layout';

describe('isLargeScreen', () => {
  it('is false for phones either way up', () => {
    expect(isLargeScreen(412, 915)).toBe(false);
    expect(isLargeScreen(915, 412)).toBe(false);
  });

  it('is true for tablets and unfolded foldables', () => {
    expect(isLargeScreen(1024, 1366)).toBe(true);
    expect(isLargeScreen(840, 700)).toBe(true);
    expect(isLargeScreen(600, 960)).toBe(true);
  });
});

describe('libraryColumns', () => {
  it('keeps three on phones and grows with the width', () => {
    expect(libraryColumns(360)).toBe(3);
    expect(libraryColumns(412)).toBe(3);
    expect(libraryColumns(820)).toBe(4);
    expect(libraryColumns(1024)).toBe(5);
    expect(libraryColumns(1366)).toBe(6);
    expect(libraryColumns(2000)).toBe(6);
  });
});

describe('contentWidthFor', () => {
  it('uses the whole phone width and caps on a tablet', () => {
    expect(contentWidthFor(412)).toBe(412);
    expect(contentWidthFor(1024)).toBe(640);
  });
});

describe('layoutFor', () => {
  it('describes an iPad held landscape', () => {
    expect(layoutFor(1366, 1024)).toEqual({
      isLarge: true,
      isLandscape: true,
      width: 1366,
      height: 1024,
      contentWidth: 640,
      columns: 6,
    });
  });

  it('describes a phone', () => {
    expect(layoutFor(412, 915)).toMatchObject({ isLarge: false, isLandscape: false, contentWidth: 412, columns: 3 });
  });
});

describe('previewAspect', () => {
  const format = { width: 1920, height: 1080 };

  it('is portrait on a portrait screen and landscape on a landscape one', () => {
    expect(previewAspect(format, false)).toBeCloseTo(9 / 16);
    expect(previewAspect(format, true)).toBeCloseTo(16 / 9);
  });

  it('assumes 16:9 before the camera reports a format', () => {
    expect(previewAspect(null, false)).toBeCloseTo(9 / 16);
    expect(previewAspect(undefined, true)).toBeCloseTo(16 / 9);
  });
});
