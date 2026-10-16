#!/usr/bin/env python3
"""Fake SimpleSwing peer for testing two-phone capture with one phone (dev tool).

Speaks the PeerLink protocol (modules/swing-capture/android/.../PeerProtocol.kt) over TCP, so the
phone can be tested in either role through an adb port tunnel:

  Phone as MAIN, this script as the camera phone:
    adb reverse tcp:47800 tcp:47800
    adb exec-out run-as app.simpleswing cat files/swings/<some swing>.mp4 > /tmp/angle.mp4
    scripts/multicam-peer.py camera --clip /tmp/angle.mp4
    then on the phone: Capture → + Cam → address 127.0.0.1, code 123456 (or --code)

  Phone as CAMERA, this script as the main phone:
    adb forward tcp:47800 tcp:47800
    scripts/multicam-peer.py main --host 127.0.0.1 --code <code on the phone> --trigger-every 10 --out /tmp/angles

The camera role prints how far in the future each requested window ends on its own clock: about
1.5 s for an impact (minus the link delay) means clock sync and window conversion work. Our clock
is time.monotonic; the offset to the phone's is whatever ClockSync measures.
"""

import argparse
import json
import os
import socket
import struct
import threading
import time

VERSION = 2
PORT = 47800
CHUNK = 64 * 1024
HELLO, PING, PONG, STATE, TRIGGER, REJECT, CLIP, DATA, DONE, BYE = range(1, 11)


def now_us() -> int:
    return time.monotonic_ns() // 1000


class Link:
    def __init__(self, sock: socket.socket):
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self.sock = sock
        self.lock = threading.Lock()

    def send(self, kind: int, payload) -> None:
        body = payload if isinstance(payload, (bytes, bytearray)) else json.dumps(payload).encode()
        with self.lock:
            self.sock.sendall(struct.pack('>BI', kind, len(body)) + body)

    def _exact(self, n: int) -> bytes:
        buf = bytearray()
        while len(buf) < n:
            part = self.sock.recv(n - len(buf))
            if not part:
                raise EOFError
            buf += part
        return bytes(buf)

    def read(self):
        kind, length = struct.unpack('>BI', self._exact(5))
        body = self._exact(length)
        return kind, (body if kind == DATA else json.loads(body or b'{}'))


def run_camera(args) -> None:
    clip = open(args.clip, 'rb').read() if args.clip else None
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(('0.0.0.0', args.port))
    server.listen(1)
    print(f'camera: listening on {args.port}' + ('' if clip else ' (no --clip: triggers will be rejected)'))
    while True:
        conn, addr = server.accept()
        print(f'camera: main phone connected from {addr}')
        link = Link(conn)
        try:
            # Like the real camera phone: nothing until the main phone's HELLO carries our code.
            kind, m = link.read()
            if kind != HELLO or m.get('role') != 'main' or m.get('code') != args.code:
                print(f'camera: refused pairing (code {m.get("code") if kind == HELLO else None!r})')
                link.send(REJECT, dict(id='', reason='code'))
                conn.close()
                continue
            print(f'camera: paired with {m.get("name")} ({m.get("platform")}, v{m.get("v")})')
            link.send(HELLO, dict(v=VERSION, role='camera', name='Fake camera', platform='script', fps=120, view=args.view))
            link.send(STATE, dict(state='armed'))
            while True:
                kind, m = link.read()
                received = now_us()
                if kind == PING:
                    link.send(PONG, dict(t1=m['t1'], t2=received, t3=now_us()))
                    if m.get('syncUs') is not None and args.verbose:
                        print(f'camera: main reports sync ±{m["syncUs"] / 1000:.1f} ms')
                elif kind == TRIGGER:
                    ends_in = (m['endUs'] - received) / 1000
                    anchor_in = (m['anchorUs'] - received) / 1000
                    print(f'camera: TRIGGER {m["id"]}: window ends in {ends_in:.0f} ms, anchor {anchor_in:.0f} ms from now, '
                          f'length {(m["endUs"] - m["startUs"]) / 1000:.0f} ms')
                    if clip is None:
                        link.send(REJECT, dict(id=m['id'], reason='busy'))
                        continue
                    threading.Thread(target=send_clip, args=(link, m, clip), daemon=True).start()
                elif kind == STATE:
                    print(f'camera: main is {m["state"]}')
                elif kind == HELLO:
                    print(f'camera: hello from {m.get("name")} ({m.get("platform")}, v{m.get("v")})')
                elif kind == BYE:
                    break
        except (EOFError, ConnectionError) as e:
            print(f'camera: link closed ({e or "eof"})')
        conn.close()


def send_clip(link: Link, trig: dict, clip: bytes) -> None:
    # Like the real engine: wait for the window to end, then send. The sample clip stands in for it.
    time.sleep(max(0, (trig['endUs'] - now_us()) / 1e6) + 0.3)
    anchor_offset_ms = (trig['anchorUs'] - trig['startUs']) / 1000
    duration_ms = (trig['endUs'] - trig['startUs']) / 1000
    link.send(CLIP, dict(id=trig['id'], fps=120, durationMs=duration_ms, anchorOffsetMs=anchor_offset_ms, size=len(clip)))
    for i in range(0, len(clip), CHUNK):
        link.send(DATA, clip[i:i + CHUNK])
    link.send(DONE, dict(id=trig['id']))
    print(f'camera: sent {len(clip) // 1024} KB for {trig["id"]}')


def run_main(args) -> None:
    sock = socket.create_connection((args.host, args.port), timeout=5)
    sock.settimeout(None)
    link = Link(sock)
    link.send(HELLO, dict(v=VERSION, role='main', name='Fake main', platform='script', fps=120, view='', code=args.code))
    link.send(STATE, dict(state='armed'))
    samples = []  # (rtt, offset)
    best = {}

    def pinger():
        while True:
            err = best.get('err')
            link.send(PING, dict(t1=now_us(), **({'syncUs': err} if err is not None else {})))
            time.sleep(1)

    def triggerer():
        n = 0
        while True:
            time.sleep(args.trigger_every)
            if 'offset' not in best:
                print('main: no sync yet, skipping trigger')
                continue
            n += 1
            t = now_us()
            off = best['offset']
            clip_id = f'swing_{int(time.time() * 1000)}'
            link.send(TRIGGER, dict(id=clip_id, startUs=t - 3_000_000 + off, endUs=t + 1_500_000 + off, anchorUs=t + off))
            print(f'main: TRIGGER {clip_id} (#{n}) sync ±{best["err"] / 1000:.2f} ms')

    threading.Thread(target=pinger, daemon=True).start()
    if args.trigger_every > 0:
        threading.Thread(target=triggerer, daemon=True).start()
    os.makedirs(args.out, exist_ok=True)
    incoming = None
    while True:
        kind, m = link.read()
        received = now_us()
        if kind == PONG:
            rtt = (received - m['t1']) - (m['t3'] - m['t2'])
            offset = ((m['t2'] - m['t1']) + (m['t3'] - received)) // 2
            samples.append((rtt, offset))
            del samples[:-20]
            rtt_best, off_best = min(samples)
            best.update(offset=off_best, err=rtt_best // 2)
            if args.verbose:
                print(f'main: rtt {rtt / 1000:.2f} ms, best ±{rtt_best / 2000:.2f} ms')
        elif kind == HELLO:
            print(f'main: camera is {m.get("name")} ({m.get("platform")}, {m.get("fps")} fps, view {m.get("view")})')
        elif kind == STATE:
            print(f'main: camera is {m["state"]}')
        elif kind == REJECT and m['id'] == '':
            print(f'main: camera refused pairing: {m["reason"]}')
            return
        elif kind == REJECT:
            print(f'main: camera missed {m["id"]}: {m["reason"]}')
        elif kind == CLIP:
            incoming = dict(meta=m, data=bytearray(), started=time.monotonic())
        elif kind == DATA and incoming is not None:
            incoming['data'] += m
        elif kind == DONE and incoming is not None:
            meta, data = incoming['meta'], incoming['data']
            path = os.path.join(args.out, f'{meta["id"]}.b.mp4')
            with open(path, 'wb') as f:
                f.write(data)
            secs = time.monotonic() - incoming['started']
            ok = 'OK' if len(data) == meta['size'] else f'SIZE MISMATCH ({len(data)} != {meta["size"]})'
            print(f'main: got {path}: {len(data) // 1024} KB in {secs:.1f} s, {meta["fps"]} fps, '
                  f'{meta["durationMs"]:.0f} ms, anchor at {meta["anchorOffsetMs"]:.0f} ms — {ok}')
            incoming = None
        elif kind == BYE:
            print('main: camera left')
            return


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest='role', required=True)
    cam = sub.add_parser('camera', help='act as the camera phone (the phone is main)')
    cam.add_argument('--clip', help='MP4 to send back for every trigger')
    cam.add_argument('--view', default='faceOn', choices=['dtl', 'faceOn'])
    cam.add_argument('--code', default='123456', help='pairing code the main phone must send')
    mn = sub.add_parser('main', help='act as the main phone (the phone is the camera)')
    mn.add_argument('--host', default='127.0.0.1')
    mn.add_argument('--code', required=True, help='the pairing code the camera phone shows')
    mn.add_argument('--trigger-every', type=float, default=10, help='seconds between triggers (0 = never)')
    mn.add_argument('--out', default='/tmp/simpleswing-angles')
    for sp in (cam, mn):
        sp.add_argument('--port', type=int, default=PORT)
        sp.add_argument('-v', '--verbose', action='store_true')
    args = p.parse_args()
    try:
        (run_camera if args.role == 'camera' else run_main)(args)
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
