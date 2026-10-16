import { useCallback, useEffect, useRef, useState } from 'react';

import { isPairingCode, type CaptureSettings } from '@/lib/capture-settings';
import { loadCaptureSettings, saveCaptureSettings } from '@/lib/capture-settings-store';
import SwingCapture, { type PeerInfo, type PeerStatusEvent } from '../../modules/swing-capture';

/** Link errors the pairing sheet shows itself, so the Capture screen doesn't repeat them. */
export const PAIRING_ERROR_CODES = ['E_PEER_ADDRESS', 'E_PEER_CONNECT', 'E_PEER_VERSION', 'E_PEER_PERMISSION', 'E_PEER_CODE'];

/** A camera phone (found, or a typed address) waiting for the user to type the code it shows. */
export type CodeRequest = { target: string; name: string | null };

const save = (patch: Partial<Pick<CaptureSettings, 'secondCamera' | 'lastCameraName' | 'lastCameraCode'>>) =>
  saveCaptureSettings({ ...loadCaptureSettings(), ...patch });

/**
 * Main phone side of two-phone capture. While "second camera" is on (a saved setting), the engine
 * searches for camera phones, and the one connected last time is reconnected as soon as it shows up,
 * with the pairing code saved when it was first connected.
 * The link lives in the native engine, so it keeps running when this screen isn't focused.
 */
export function useMainPeerLink() {
  const [enabled, setEnabled] = useState(() => loadCaptureSettings().secondCamera);
  const [status, setStatus] = useState<PeerStatusEvent | null>(null);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  /** What the user asked to connect to, until it connects or fails. */
  const [connecting, setConnecting] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  /** Asking for the code of the camera phone the user picked. */
  const [codeRequest, setCodeRequest] = useState<CodeRequest | null>(null);
  const statusRef = useRef(status);
  /** The last connection attempt, so a wrong code can ask again and a right one is remembered. */
  const attemptRef = useRef<(CodeRequest & { code: string }) | null>(null);

  const dial = useCallback((target: string, name: string | null, code: string) => {
    attemptRef.current = { target, name, code };
    SwingCapture.connectPeer(target, code);
  }, []);

  useEffect(() => {
    const subs = [
      SwingCapture.addListener('onPeerStatus', (s) => {
        statusRef.current = s;
        setStatus(s);
        if (s.role === 'main' && s.state === 'connected') {
          setConnecting(null);
          setConnectError(null);
          setCodeRequest(null);
          const code = attemptRef.current?.code;
          if (s.peerName) save({ lastCameraName: s.peerName, ...(code ? { lastCameraCode: code } : {}) });
        }
      }),
      SwingCapture.addListener('onError', (e) => {
        if (!PAIRING_ERROR_CODES.includes(e.code)) return;
        setConnecting(null);
        setConnectError(e.message);
        if (e.code === 'E_PEER_CODE') {
          // The saved code is wrong (or was never right): forget it and ask again.
          save({ lastCameraCode: null });
          const attempt = attemptRef.current;
          if (attempt) setCodeRequest({ target: attempt.target, name: attempt.name });
        }
      }),
      SwingCapture.addListener('onPeersFound', ({ peers: found }) => {
        setPeers(found);
        const { lastCameraName, lastCameraCode } = loadCaptureSettings();
        const known = lastCameraName ? found.find((p) => p.name === lastCameraName) : undefined;
        if (known && isPairingCode(lastCameraCode) && statusRef.current?.state !== 'connected') {
          dial(known.id, known.name, lastCameraCode);
        }
      }),
    ];
    return () => subs.forEach((s) => s.remove());
  }, [dial]);

  /** Capture regained focus: back to the main role if this phone was a camera in the meantime. */
  const resume = useCallback(() => {
    if (loadCaptureSettings().secondCamera) SwingCapture.startMainLink();
  }, []);

  const turnOn = () => {
    save({ secondCamera: true });
    setEnabled(true);
    SwingCapture.startMainLink();
  };

  const connect = (target: string, name: string | null, code: string) => {
    if (!enabled) turnOn();
    setCodeRequest(null);
    setConnecting(target);
    setConnectError(null);
    dial(target, name, code);
  };

  /** The user picked a camera phone (or typed its address): connect, asking for its code unless it's saved. */
  const pick = (target: string, name: string | null = null) => {
    const { lastCameraName, lastCameraCode } = loadCaptureSettings();
    if (name != null && name === lastCameraName && isPairingCode(lastCameraCode)) {
      connect(target, name, lastCameraCode);
      return;
    }
    setConnectError(null);
    setCodeRequest({ target, name });
  };

  /** The code typed for the phone being asked about. */
  const submitCode = (code: string) => {
    if (!codeRequest || !isPairingCode(code)) return;
    connect(codeRequest.target, codeRequest.name, code);
  };

  const cancelCode = () => setCodeRequest(null);

  /** Off, and forget the last camera and its code so it isn't reconnected automatically. */
  const turnOff = () => {
    save({ secondCamera: false, lastCameraName: null, lastCameraCode: null });
    attemptRef.current = null;
    setEnabled(false);
    setPeers([]);
    setConnecting(null);
    setConnectError(null);
    setCodeRequest(null);
    SwingCapture.stopPeerLink();
  };

  const connected = enabled && status?.role === 'main' && status.state === 'connected';
  return {
    enabled,
    status: status?.role === 'main' ? status : null,
    peers,
    connected,
    connecting: connected ? null : connecting,
    connectError,
    codeRequest: connected ? null : codeRequest,
    resume,
    turnOn,
    pick,
    submitCode,
    cancelCode,
    turnOff,
  };
}
