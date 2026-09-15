import { useLayoutEffect, type ReactNode } from 'react';
import type { WorkspaceSession } from '../contracts/session';
import { bindIntelligenceSession } from './api-client';
import { sessionKey } from './transient-retrieval';

export function SessionRequestBoundary({ session, children }: { session: WorkspaceSession; children: ReactNode }) {
  const identity = sessionKey(session);
  // Bind before child request effects; ordinary same-identity rechecks preserve drafts and in-flight reads.
  useLayoutEffect(() => bindIntelligenceSession(session), [identity]);
  return children;
}
