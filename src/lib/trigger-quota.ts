import { AUTO_TRIGGER_SOURCES, type TriggerSource } from '../../modules/swing-capture/src/SwingCapture.types';

/** Free tier: automatic (impact / watch) triggers allowed per range session. */
export const FREE_AUTO_TRIGGERS_PER_SESSION = 3;

/** A range session ends after this much inactivity; the next capture starts a new one. */
export const SESSION_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export type RangeSession = {
  id: string;
  startedAt: number;
  lastActivityAt: number;
  autoTriggersUsed: number;
};

export function isAutoTrigger(source: TriggerSource): boolean {
  return AUTO_TRIGGER_SOURCES.includes(source);
}

/** Returns the active session at `now`, starting a new one if there is none or it has gone idle. */
export function currentSession(
  session: RangeSession | null,
  now: number,
  newId: () => string
): RangeSession {
  if (session && now - session.lastActivityAt < SESSION_IDLE_TIMEOUT_MS) {
    return session;
  }
  return { id: newId(), startedAt: now, lastActivityAt: now, autoTriggersUsed: 0 };
}

export function remainingAutoTriggers(session: RangeSession, isPro: boolean): number {
  if (isPro) return Infinity;
  return Math.max(0, FREE_AUTO_TRIGGERS_PER_SESSION - session.autoTriggersUsed);
}

export function canAutoTrigger(session: RangeSession, isPro: boolean): boolean {
  return remainingAutoTriggers(session, isPro) > 0;
}

/** Records a completed capture. Manual and volume-key captures never consume quota. */
export function recordCapture(
  session: RangeSession,
  source: TriggerSource,
  now: number
): RangeSession {
  return {
    ...session,
    lastActivityAt: now,
    autoTriggersUsed: session.autoTriggersUsed + (isAutoTrigger(source) ? 1 : 0),
  };
}
