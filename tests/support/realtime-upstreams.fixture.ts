import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { InternalTokenVerifier } from '@cadenway/nest-common';

export const organizationId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f';
export const otherOrganizationId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b99';
export const spaceId = '019a7000-1a2b-7c3d-8e4f-5a6b7c8d9e01';
export const listId = '019a7001-2b3c-7d4e-8f5a-6b7c8d9e0f12';
export const taskId = '019a7002-3c4d-7e5f-8a6b-7c8d9e0f1a23';
export const taskKey = 'CAD-482';

export interface TestSession {
  readonly sessionId: string;
  readonly sessionVersion: number;
  readonly userId: string;
  readonly organizationId: string;
  readonly memberId: string;
  readonly role: 'member';
  readonly sessionExpiresAt: string;
}

/** Signed internal HTTP boundaries with single-use synthetic tickets and mutable Task access. */
export class RealtimeUpstreams {
  // #region Properties
  private readonly tickets = new Map<string, TestSession>();
  private readonly allowed = new Set<string>();
  private readonly requests: string[] = [];
  private held?: { userId: string; entered: () => void; released: Promise<void> };
  private server?: Server;

  /** Address of the single disposable Identity and Task HTTP server. */
  public url = '';
  // #endregion

  // #region Constructor
  private constructor(
    private readonly identity: InternalTokenVerifier,
    private readonly task: InternalTokenVerifier,
  ) {}
  // #endregion

  // #region Methods
  /** Starts an HTTP server that verifies the gateway's ephemeral public signing key. */
  public static async start(privateJwk: string): Promise<RealtimeUpstreams> {
    const signingKey = JSON.parse(privateJwk) as {
      kty: 'OKP';
      crv: 'Ed25519';
      kid: string;
      x: string;
    };
    const publicKey = {
      kty: signingKey.kty,
      crv: signingKey.crv,
      kid: signingKey.kid,
      x: signingKey.x,
    };
    const trustedIssuers = { 'realtime-gateway': [publicKey] };
    const [identity, task] = await Promise.all([
      InternalTokenVerifier.create({ audience: 'identity-service', trustedIssuers }),
      InternalTokenVerifier.create({ audience: 'task-service', trustedIssuers }),
    ]);
    const fixture = new RealtimeUpstreams(identity, task);
    const server = createServer((request, response) => {
      void fixture.answer(request, response);
    });
    fixture.server = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    fixture.url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    return fixture;
  }

  /** Adds one credential and optionally permits the session to see the sample task. */
  public issue(token: string, session: TestSession, canRead: boolean): void {
    this.tickets.set(token, session);
    if (canRead) this.allowed.add(session.userId);
  }

  /** Suspends one user's next Task proof until the test releases the owning request. */
  public holdTask(userId: string): { entered: Promise<void>; release: () => void } {
    let release = (): void => undefined;
    let entered = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.held = { userId, entered, released };
    return { entered: started, release };
  }

  /** Shuts down the fake service after both gateway instances close. */
  public async close(): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
  }

  /** Counts authorized task lookups without retaining signed tokens. */
  public get taskChecks(): number {
    return this.requests.length;
  }

  private async answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const send = (status: number, body: object): void => {
      response.writeHead(status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      response.end(JSON.stringify(body));
    };
    try {
      const auth = request.headers.authorization ?? '';
      if (!auth.startsWith('Bearer ')) {
        send(401, {});
        return;
      }
      if (request.url === '/internal/v1/realtime/tickets/redemption') {
        const principal = await this.identity.verify(auth.slice(7));
        if (principal.actor.type !== 'system' || principal.organizationId !== null) {
          send(403, {});
          return;
        }
        let body = '';
        for await (const chunk of request) body += String(chunk);
        const { token } = JSON.parse(body) as { token: string };
        const session = this.tickets.get(token);
        this.tickets.delete(token);
        if (session === undefined) {
          send(404, {});
          return;
        }
        send(200, session);
        return;
      }
      const principal = await this.task.verify(auth.slice(7));
      if (principal.actor.type !== 'user' || principal.actor.id === null) {
        send(403, {});
        return;
      }
      this.requests.push(principal.actor.id);
      if (principal.organizationId !== organizationId || !this.allowed.has(principal.actor.id)) {
        send(404, {});
        return;
      }
      if (request.url === `/internal/v1/tasks/${taskKey}/access`) {
        if (this.held?.userId === principal.actor.id) {
          const hold = this.held;
          this.held = undefined;
          hold.entered();
          await hold.released;
        }
        send(200, { role: 'edit', spaceId, listId, taskId, taskKey });
        return;
      }
      if (request.url === `/internal/v1/lists/${listId}/access`) {
        send(200, { role: 'edit', spaceId, listId, taskKey: null });
        return;
      }
      send(404, {});
      return;
    } catch {
      send(401, {});
      return;
    }
  }
  // #endregion
}
