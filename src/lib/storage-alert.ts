import { Alert } from 'react-native';

/** Shown when a swing's files couldn't be written or removed (usually a full phone). */
export const SAVE_FAILED = 'Couldn’t save. Phone storage may be full.';

export function alertSaveFailed() {
  Alert.alert('Couldn’t save', 'Phone storage may be full. Free up some space and try again.');
}

export function alertDeleteFailed() {
  Alert.alert('Couldn’t delete everything', 'Some files couldn’t be removed. Try again.');
}
