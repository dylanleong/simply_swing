import { useEvent } from 'expo';
import { useVideoPlayer, type VideoPlayer } from 'expo-video';
import { useEffect, useState } from 'react';

import { CLIP_BUFFER_OPTIONS } from '@/lib/clip-playback';
import { linkDriftSec, linkedTimeSec, type Link } from '@/lib/multicam';

export const SPEEDS = [
  { rate: 1, label: '1×' },
  { rate: 0.5, label: '½' },
  { rate: 0.25, label: '¼' },
  { rate: 0.125, label: '⅛' },
] as const;

export const DEFAULT_RATE = 0.25;
/** How often the second clip is checked against the first while playing. */
const SYNC_TICK_MS = 200;

/** The players are mutable native objects; React Compiler only objects to mutating them inline. */
function setPlaybackRate(player: VideoPlayer, rate: number) {
  player.playbackRate = rate;
}

/** Exact seek (expo-video's `currentTime` is frame accurate; `seekBy` may snap to keyframes). */
function seekTo(player: VideoPlayer, seconds: number) {
  player.currentTime = Math.max(0, seconds);
}

/**
 * Two looping, muted slow-motion players where the second follows the first through [link] (a
 * swing's second angle, or another swing to compare with). Without a second clip it's one player.
 */
export function useLinkedPlayers(uriA: string, uriB: string | null, link: Link | null) {
  const [rate, setRate] = useState<number>(DEFAULT_RATE);
  /** Where the first clip is, seconds: from the player while playing, from our seeks while paused. */
  const [position, setPosition] = useState(0);
  const setup = (p: VideoPlayer) => {
    p.bufferOptions = CLIP_BUFFER_OPTIONS;
    p.timeUpdateEventInterval = 1 / 30;
    p.loop = true;
    p.muted = true;
    p.playbackRate = DEFAULT_RATE;
    p.play();
  };
  const player = useVideoPlayer(uriA, setup);
  const playerB = useVideoPlayer(uriB, setup);
  const { isPlaying } = useEvent(player, 'playingChange', { isPlaying: player.playing });

  useEffect(() => {
    const sub = player.addListener('timeUpdate', (e) => setPosition(e.currentTime));
    return () => sub.remove();
  }, [player]);

  // Two native players drift apart while playing (and loop at slightly different moments); keep the
  // second within a frame of where the first says it should be.
  useEffect(() => {
    if (!link || !isPlaying) return;
    const timer = setInterval(() => {
      const fix = linkDriftSec(player.currentTime, playerB.currentTime, link);
      if (fix !== 0) seekTo(playerB, playerB.currentTime + fix);
      if (!playerB.playing) playerB.play();
    }, SYNC_TICK_MS);
    return () => clearInterval(timer);
  }, [link, isPlaying, player, playerB]);

  const pause = () => {
    player.pause();
    playerB.pause();
  };

  /** Pauses both and shows the first clip at [t] (and the second at the matching moment). */
  const showAt = (t: number, withLink: Link | null = link) => {
    pause();
    seekTo(player, t);
    setPosition(Math.max(0, t));
    if (withLink) seekTo(playerB, linkedTimeSec(t, withLink));
  };

  const togglePlay = () => {
    if (isPlaying) {
      pause();
      return;
    }
    if (link) seekTo(playerB, linkedTimeSec(player.currentTime, link));
    player.play();
    if (link) playerB.play();
  };

  const step = (frames: number, fps: number | null) => showAt(player.currentTime + frames / (fps ?? 120));

  const changeRate = (r: number) => {
    setRate(r);
    setPlaybackRate(player, r);
    setPlaybackRate(playerB, r);
  };

  return { player, playerB, isPlaying, rate, position, pause, showAt, togglePlay, step, changeRate };
}
