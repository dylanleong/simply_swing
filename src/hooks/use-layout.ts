import { useWindowDimensions } from 'react-native';

import { layoutFor, type Layout } from '@/lib/layout';

/** The window's size class and orientation, live (updates on rotation and when a foldable opens). */
export function useLayout(): Layout {
  const { width, height } = useWindowDimensions();
  return layoutFor(width, height);
}
