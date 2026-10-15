import Ionicons from '@expo/vector-icons/Ionicons';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';

/** `ion:<name>` (Ionicons) or `mci:<name>` (Material Community Icons), both bundled with Expo. */
export type IconName =
  | `ion:${keyof typeof Ionicons.glyphMap}`
  | `mci:${keyof typeof MaterialCommunityIcons.glyphMap}`;

export function Icon({ name, size = 22, color }: { name: IconName; size?: number; color: string }) {
  const [set, glyph] = name.split(':') as ['ion' | 'mci', string];
  return set === 'ion' ? (
    <Ionicons name={glyph as keyof typeof Ionicons.glyphMap} size={size} color={color} />
  ) : (
    <MaterialCommunityIcons name={glyph as keyof typeof MaterialCommunityIcons.glyphMap} size={size} color={color} />
  );
}
