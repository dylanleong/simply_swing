import { HELP_TOPICS, helpTopic } from '../help-topics';

describe('help topics', () => {
  it('have unique ids and real content', () => {
    expect(new Set(HELP_TOPICS.map((t) => t.id)).size).toBe(HELP_TOPICS.length);
    for (const t of HELP_TOPICS) {
      expect(t.sections.length).toBeGreaterThan(0);
      for (const s of t.sections) expect(s.body.length).toBeGreaterThan(40);
    }
  });

  it('finds a linked topic and ignores unknown ones', () => {
    expect(helpTopic('reading')?.title).toBe('Reading your swing');
    expect(helpTopic('nope')).toBeUndefined();
    expect(helpTopic(undefined)).toBeUndefined();
  });
});
