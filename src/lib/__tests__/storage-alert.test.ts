import { deleteFailedMessage } from '../storage-alert';

describe('deleteFailedMessage', () => {
  it('names the count when it is known', () => {
    expect(deleteFailedMessage()).toBe('Some files couldn’t be removed. Try again.');
    expect(deleteFailedMessage(1)).toBe('The swing couldn’t be removed completely. Try again.');
    expect(deleteFailedMessage(12)).toBe('Some of the 12 swings couldn’t be removed. Try again.');
  });
});
