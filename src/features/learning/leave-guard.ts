import { useEffect, useRef } from 'react';
import type { LeaveGuard, RegisterLeaveGuard } from '../../contracts/navigation';

function stateOf(guard: LeaveGuard): ReturnType<LeaveGuard['getState']> {
  try {
    const state = guard.getState();
    return state === 'clean' || state === 'dirty' ? state : 'blocked';
  } catch { return 'blocked'; }
}

// Panels aggregate locally so the shared router receives one learning owner.
export class LearningLeaveGroup {
  private guards = new Map<symbol, LeaveGuard>();
  readonly register: RegisterLeaveGuard = (guard) => {
    const key = Symbol(); this.guards.set(key, guard);
    return () => { this.guards.delete(key); };
  };
  readonly getState: LeaveGuard['getState'] = () => {
    let state: ReturnType<LeaveGuard['getState']> = 'clean';
    for (const guard of this.guards.values()) {
      const current = stateOf(guard);
      if (current === 'blocked') return 'blocked';
      if (current === 'dirty') state = 'dirty';
    }
    return state;
  };
  readonly onBlocked = () => {
    for (const guard of this.guards.values()) if (stateOf(guard) === 'blocked') guard.onBlocked?.();
  };
}

export function useLearningLeaveGuard(register: RegisterLeaveGuard | undefined, getState: LeaveGuard['getState'], onBlocked?: () => void) {
  const latest = useRef({ getState, onBlocked }); latest.current = { getState, onBlocked };
  useEffect(() => register?.({ owner: 'learning', getState: () => latest.current.getState(), onBlocked: () => latest.current.onBlocked?.() }), [register]);
}
