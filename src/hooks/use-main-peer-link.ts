import { useCallback, useEffect, useRef, useState } from 'react';

import { loadCaptureSettings, saveCaptureSettings } from '@/lib/capture-settings-store';
import SwingCapture, { type PeerInfo, type PeerStatusEvent } from '../../modules/swing-capture';

/**
 * Main phone side of two-phone capture. While "second camera" is on (a saved setting), the engine
 * searches for camera phones, and the one connected last time is reconnected as soon as it shows up.
 * The link lives in the native engine, so it keeps running when this screen isn't focused.
 */
export function useMainPeerLink() {
  const [enabled, setEnabled] = useState(() => loadCaptureSettings().secondCamera);
  const [status, setStatus] = useState<PeerStatusEvent | null>(null);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const statusRef = useRef(status);

  const save = (patch: { secondCamera?: boolean; lastCameraName?: string | null }) =>
    saveCaptureSettings({ ...loadCaptureSettings(), ...patch });

  useEffect(() => {
    const subs = [
      SwingCapture.addListener('onPeerStatus', (s) => {
        statusRef.current = s;
        setStatus(s);
        if (s.role === 'main' && s.state === 'connected' && s.peerName) save({ lastCameraName: s.peerName });
      }),
      SwingCapture.addListener('onPeersFound', ({ peers: found }) => {
        setPeers(found);
        const last = loadCaptureSettings().lastCameraName;
        const known = last ? found.find((p) => p.name === last) : undefined;
        if (known && statusRef.current?.state !== 'connected') SwingCapture.connectPeer(known.id);
      }),
    ];
    return () => subs.forEach((s) => s.remove());
  }, []);

  /** Capture regained focus: back to the main role if this phone was a camera in the meantime. */
  const resume = useCallback(() => {
    if (loadCaptureSettings().secondCamera) SwingCapture.startMainLink();
  }, []);

  const turnOn = () => {
    save({ secondCamera: true });
    setEnabled(true);
    SwingCapture.startMainLink();
  };

  const connect = (idOrAddress: string) => {
    if (!enabled) turnOn();
    SwingCapture.connectPeer(idOrAddress);
  };

  /** Off, and forget the last camera so it isn't reconnected automatically. */
  const turnOff = () => {
    save({ secondCamera: false, lastCameraName: null });
    setEnabled(false);
    setPeers([]);
    SwingCapture.stopPeerLink();
  };

  const connected = enabled && status?.role === 'main' && status.state === 'connected';
  return { enabled, status: status?.role === 'main' ? status : null, peers, connected, resume, turnOn, connect, turnOff };
}
