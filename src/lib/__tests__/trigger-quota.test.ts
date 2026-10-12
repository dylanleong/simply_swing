import {
  FREE_AUTO_TRIGGERS_PER_SESSION,
  SESSION_IDLE_TIMEOUT_MS,
  canAutoTrigger,
  currentSession,
  recordCapture,
  remainingAutoTriggers,
} from '../trigger-quota';

const T0 = 1_700_000_000_000;
let nextId = 0;
const newId = () => `s${++nextId}`;

describe('trigger quota', () => {
  beforeEach(() => {
    nextId = 0;
  });

  it('starts a fresh session with the full free quota', () => {
    const s = currentSession(null, T0, newId);
    expect(s).toEqual({ id: 's1', startedAt: T0, lastActivityAt: T0, autoTriggersUsed: 0 });
    expect(remainingAutoTriggers(s, false)).toBe(FREE_AUTO_TRIGGERS_PER_SESSION);
  });

  it('blocks auto triggers once the free quota is used, but never manual ones', () => {
    let s = currentSession(null, T0, newId);
    s = recordCapture(s, 'impact', T0 + 1);
    s = recordCapture(s, 'watch', T0 + 2);
    s = recordCapture(s, 'manual', T0 + 3);
    s = recordCapture(s, 'volumeKey', T0 + 4);
    expect(canAutoTrigger(s, false)).toBe(true);
    s = recordCapture(s, 'impact', T0 + 5);
    expect(remainingAutoTriggers(s, false)).toBe(0);
    expect(canAutoTrigger(s, false)).toBe(false);
  });

  it('gives Pro users unlimited auto triggers', () => {
    let s = currentSession(null, T0, newId);
    for (let i = 0; i < 10; i++) s = recordCapture(s, 'impact', T0 + i);
    expect(canAutoTrigger(s, true)).toBe(true);
  });

  it('keeps the session while active and resets the quota after the idle timeout', () => {
    let s = currentSession(null, T0, newId);
    for (let i = 0; i < 3; i++) s = recordCapture(s, 'impact', T0 + i);

    const lastActivity = s.lastActivityAt;
    expect(currentSession(s, lastActivity + SESSION_IDLE_TIMEOUT_MS - 1, newId)).toBe(s);

    const next = currentSession(s, lastActivity + SESSION_IDLE_TIMEOUT_MS, newId);
    expect(next.id).toBe('s2');
    expect(canAutoTrigger(next, false)).toBe(true);
  });
});
