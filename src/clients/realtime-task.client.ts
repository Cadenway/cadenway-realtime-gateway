import type { RealtimeSession } from '@cadenway/contracts/types/internal/identity-service';
import {
  CheckListAccessInternalParams,
  CheckListAccessInternalResponse,
  CheckTaskAccessInternalParams,
  CheckTaskAccessInternalResponse,
  ResolveNotificationSubjectsInternalBody,
  ResolveNotificationSubjectsInternalResponse,
} from '@cadenway/contracts/validators/internal/task-service';
import {
  MAX_CALL_TIMEOUT_MS,
  type InternalHttpClient,
  type InternalRequestInit,
} from '@cadenway/nest-common';

import { bindInternalFetch, readInternalJson } from '../infrastructure/http/internal-json.js';
import { getTaskServiceInternalRoutes } from './generated/task-service.js';

const unavailable = 'Task room authorization is unavailable.';

/** The authority and remaining lease of a verified Identity session. */
export type RealtimeAccessSession = Pick<RealtimeSession, 'organizationId' | 'userId' | 'role'> &
  Readonly<{ expiresAt: number }>;

/** Current placement of a visible list in the session's organization. */
export type RealtimeListProof = Readonly<{
  organizationId: string;
  spaceId: string;
  listId: string;
}>;

/** Current placement and stable room identity of a visible task. */
export type RealtimeTaskProof = RealtimeListProof & Readonly<{ taskId: string; taskKey: string }>;

/** A Notification resource reference whose visibility Task decides for one account. */
export type RealtimeNotificationSubject =
  | Readonly<{ kind: 'task-id'; taskId: string }>
  | Readonly<{ kind: 'task-key'; taskKey: string }>
  | Readonly<{ kind: 'list'; listId: string }>
  | Readonly<{ kind: 'space'; spaceId: string }>;

/** Binds session authority, lease and caller cancellation to the signed call. */
function taskRequest(
  session: RealtimeAccessSession,
  signal?: AbortSignal,
): InternalRequestInit | null {
  signal?.throwIfAborted();
  const remainingMs = session.expiresAt - Date.now();
  if (!Number.isSafeInteger(remainingMs) || remainingMs <= 0) return null;
  return {
    claims: {
      organizationId: session.organizationId,
      actor: { type: 'user', id: session.userId },
      role: session.role,
    },
    streamTimeoutMs: Math.min(remainingMs, MAX_CALL_TIMEOUT_MS),
    signal,
  };
}

/** Asks Task for current room authorization using the established socket session. */
export class RealtimeTaskClient {
  // #region Properties
  /** Generated routes bound to the signed Task transport. */
  private readonly routes: ReturnType<typeof getTaskServiceInternalRoutes>;
  // #endregion

  // #region Constructor
  /** Receives the internal HTTP client scoped to Task. */
  public constructor(http: InternalHttpClient) {
    this.routes = getTaskServiceInternalRoutes(bindInternalFetch(http));
  }
  // #endregion

  // #region Methods
  /** Resolves the selected list or conceals a missing or inaccessible list. */
  public async list(
    session: RealtimeAccessSession,
    listId: string,
    signal?: AbortSignal,
  ): Promise<RealtimeListProof | null> {
    const selector = CheckListAccessInternalParams.safeParse({ listId });
    const options = taskRequest(session, signal);
    if (!selector.success || options === null) return null;

    const requestedId = selector.data.listId.toLowerCase();
    const response = await readInternalJson(
      this.routes.checkListAccessInternal(requestedId, options),
      unavailable,
    );
    signal?.throwIfAborted();
    if (response === null || session.expiresAt <= Date.now()) return null;

    const proof = CheckListAccessInternalResponse.safeParse(response.data);
    if (!proof.success) throw new Error(unavailable);
    if (
      proof.data.listId.toLowerCase() !== requestedId ||
      proof.data.taskKey !== null ||
      proof.data.taskId !== undefined
    ) {
      return null;
    }
    return {
      organizationId: session.organizationId,
      listId: requestedId,
      spaceId: proof.data.spaceId.toLowerCase(),
    };
  }

  /** Resolves the selected task and refuses older producers that omit the stable task ID. */
  public async task(
    session: RealtimeAccessSession,
    taskKey: string,
    signal?: AbortSignal,
  ): Promise<RealtimeTaskProof | null> {
    const selector = CheckTaskAccessInternalParams.safeParse({ taskKey });
    const options = taskRequest(session, signal);
    if (!selector.success || options === null) return null;

    const response = await readInternalJson(
      this.routes.checkTaskAccessInternal(selector.data.taskKey, options),
      unavailable,
    );
    signal?.throwIfAborted();
    if (response === null || session.expiresAt <= Date.now()) return null;

    const proof = CheckTaskAccessInternalResponse.safeParse(response.data);
    if (!proof.success) throw new Error(unavailable);
    if (proof.data.taskKey !== taskKey || proof.data.taskId === undefined) return null;
    return {
      organizationId: session.organizationId,
      listId: proof.data.listId.toLowerCase(),
      spaceId: proof.data.spaceId.toLowerCase(),
      taskKey,
      taskId: proof.data.taskId.toLowerCase(),
    };
  }

  /**
   * Asks Task whether the subject is currently visible to the session's account. Visibility only:
   * Realtime never requests display data. A missing active membership answers false; an
   * unavailable or malformed decision throws so the caller can retry the fact.
   */
  public async subject(
    session: RealtimeAccessSession,
    subject: RealtimeNotificationSubject,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const lookup = ResolveNotificationSubjectsInternalBody.safeParse({ subjects: [{ subject }] });
    const options = taskRequest(session, signal);
    if (!lookup.success || options === null) return false;

    const response = await readInternalJson(
      this.routes.resolveNotificationSubjectsInternal(lookup.data, options),
      unavailable,
    );
    signal?.throwIfAborted();
    if (response === null || session.expiresAt <= Date.now()) return false;

    const decision = ResolveNotificationSubjectsInternalResponse.safeParse(response.data);
    if (!decision.success || decision.data.results.length !== 1) throw new Error(unavailable);
    const [result] = decision.data.results;
    if (result === undefined || 'display' in result) throw new Error(unavailable);
    return result.visible;
  }
  // #endregion
}
