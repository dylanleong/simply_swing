import { Alert } from 'react-native';

/** Shown when a swing's files couldn't be written or removed (usually a full phone). */
export const SAVE_FAILED = 'Couldn’t save. Phone storage may be full.';

export function alertSaveFailed() {
  Alert.alert('Couldn’t save', 'Phone storage may be full. Free up some space and try again.');
}

/** The delete-failed message, naming how many swings were being deleted when that's known. */
export function deleteFailedMessage(count: number | null = null): string {
  if (count == null) return 'Some files couldn’t be removed. Try again.';
  if (count === 1) return 'The swing couldn’t be removed completely. Try again.';
  return `Some of the ${count} swings couldn’t be removed. Try again.`;
}

export function alertDeleteFailed(count: number | null = null) {
  Alert.alert('Couldn’t delete everything', deleteFailedMessage(count));
}
