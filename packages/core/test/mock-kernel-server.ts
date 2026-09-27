// The mock kernel over real HTTP, for the client and feed tests: a random port >= 10000 on
// 127.0.0.1, the offer stream as real server-sent events, and switches to inject faults.

import { type IncomingMessage, createServer, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

import { KernelFixture, STREAM_HEADERS, connectedEvent, streamEvent } from './fixtures/kernel/mock-kernel.js';

export type Fault =
  /** answer with this status (and optional headers/body) */
  | { status: number; headers?: Record<string, string>; body?: string }
  /** accept the request and never answer */
  | 'hang'
  /** close the connection without an answer */
  | 'drop';

export interface MockKernelServer {
  url: string;
  port: number;
  fixture: KernelFixture;
  /** The path of every request received, faults included. */
  log: string[];
  /** A fault for the next `times` requests whose path starts with `path`. */
  fault(path: string, fault: Fault, times?: number): void;
  /** Open stream connections. */
  streams: Set<ServerResponse>;
  /** Send an event to every open stream. */
  broadcast(event: Record<string, unknown>): void;
  /** Send the keep-alive comment to every open stream. */
  heartbeat(): void;
  /** Stop answering: every connection is refused until `resume`. */
  stop(): Promise<void>;
  resume(): Promise<void>;
  close(): Promise<void>;
}

async function listenRandom(server: Server): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const port = 10_000 + Math.floor(Math.random() * 50_000);
    const ok = await new Promise<boolean>((resolve) => {
      const onError = () => resolve(false);
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', onError);
        resolve(true);
      });
    });
    if (ok) return port;
  }
  throw new Error('no free port found');
}

export async function startMockKernel(fixture = new KernelFixture()): Promise<MockKernelServer> {
  const faults: Array<{ path: string; fault: Fault; times: number }> = [];
  const log: string[] = [];
  const streams = new Set<ServerResponse>();
  const sockets = new Set<Socket>();
  let server!: Server;
  let port = 0;

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const target = req.url ?? '/';
    const path = target.split('?', 1)[0]!;
    log.push(path);
    const i = faults.findIndex((f) => path.startsWith(f.path) && f.times > 0);
    if (i !== -1) {
      const f = faults[i]!;
      f.times--;
      if (f.fault === 'hang') return;
      if (f.fault === 'drop') {
        req.socket.destroy();
        return;
      }
      res.writeHead(f.fault.status, { 'access-control-allow-origin': '*', ...f.fault.headers });
      res.end(f.fault.body ?? JSON.stringify({ error: 'FAULT' }));
      return;
    }
    if (path === '/v1/offers/stream') {
      fixture.requests.push({ path, query: new URLSearchParams() });
      res.writeHead(200, STREAM_HEADERS);
      res.write(connectedEvent());
      streams.add(res);
      res.on('close', () => streams.delete(res));
      return;
    }
    const r = fixture.respond(target);
    res.writeHead(r.status, r.headers);
    res.end(r.body);
  };

  const make = () => {
    const s = createServer(handler);
    s.on('connection', (sock) => {
      sockets.add(sock);
      sock.on('close', () => sockets.delete(sock));
    });
    return s;
  };

  server = make();
  port = await listenRandom(server);

  const closeServer = () =>
    new Promise<void>((resolve) => {
      for (const s of streams) s.destroy();
      streams.clear();
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    });

  return {
    url: `http://127.0.0.1:${port}`,
    get port() {
      return port;
    },
    fixture,
    log,
    streams,
    fault(path, fault, times = 1) {
      faults.push({ path, fault, times });
    },
    broadcast(event) {
      for (const s of streams) s.write(streamEvent(event));
    },
    heartbeat() {
      for (const s of streams) s.write(': heartbeat\n\n');
    },
    stop: closeServer,
    async resume() {
      server = make();
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve());
      });
    },
    close: closeServer,
  };
}
