import type { AppRoute, HandoffOperationPin, LeaveGuard, PinHandoffOperation, PinHandoffOperationResult, RegisterLeaveGuard } from '../contracts/navigation';

const parameters: Record<AppRoute['page'], readonly string[]> = {
  conversation: ['chatId'], intelligence: [],
  capture: ['conversationId', 'taskId', 'approvalId'], handoff: ['conversationId', 'candidateId', 'draftId', 'changeSetId', 'operationHash', 'source'],
  retrieval: ['taskId', 'nodeId', 'revision', 'queryId', 'recoveryId'], learning: ['taskId', 'nodeId', 'revision', 'queryId', 'useId', 'evidenceId', 'recoveryId'],
  governance: ['nodeId', 'revision', 'changeSetId', 'planId', 'approvalId', 'draftId', 'useId', 'evidenceId', 'taskId'], workspace: [], invalid: [],
};
const invalid = (): AppRoute => ({ page: 'invalid', params: {} });
export function parseRoute(hash: string): AppRoute {
  if (!hash || hash === '#') return { page: 'retrieval', params: {} };
  if (hash.length > 2000 || !hash.startsWith('#')) return invalid();
  const [page, query = '', ...rest] = hash.slice(1).split('?');
  if (!page || !Object.hasOwn(parameters, page) || rest.length) return invalid();
  const name = page as AppRoute['page'];
  try {
    decodeURIComponent(query);
    const params: Record<string, string> = {};
    for (const [key, value] of new URLSearchParams(query)) {
      if (!parameters[name].includes(key) || Object.hasOwn(params, key) || !value || value.length > 160 || /[\u0000-\u0020\u007f]/.test(value)) return invalid();
      if (key === 'revision' && !/^(?:[a-f0-9]{40}|[a-f0-9]{64}|fixture-[a-zA-Z0-9._:-]+)$/.test(value)) return invalid();
      if (key === 'source' && !['manual', 'candidate'].includes(value)) return invalid();
      if (key === 'operationHash' && !/^[a-f0-9]{64}$/.test(value)) return invalid();
      if (key === 'recoveryId' && !/^[a-f0-9]{64}$/.test(value)) return invalid();
      params[key] = value;
    }
    return { page: name, params };
  } catch { return invalid(); }
}
export function routeHash(route: AppRoute): string {
  const query = new URLSearchParams(Object.entries(route.params).sort(([a], [b]) => a.localeCompare(b))).toString();
  return `#${route.page}${query ? `?${query}` : ''}`;
}

export class HashNavigation {
  private route: AppRoute;
  private guards = new Set<LeaveGuard>();
  private listeners = new Set<() => void>();
  constructor(hash: string, private readonly host: { write: (hash: string, replace: boolean) => void; confirmDiscard: () => boolean }) { this.route = parseRoute(hash); }
  getSnapshot = (): AppRoute => this.route;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  registerLeaveGuard: RegisterLeaveGuard = (guard) => { this.guards.add(guard); return () => { this.guards.delete(guard); }; };
  pinHandoffOperation: PinHandoffOperation = (address: HandoffOperationPin): PinHandoffOperationResult => {
    const current = this.route;
    if (current.page !== 'handoff') return { ok: false, reason: 'wrong_page', route: current };
    if (![address.conversationId, address.draftId, address.changeSetId].every((value) => /^[^\u0000-\u0020\u007f]{1,160}$/.test(value))
      || !/^[a-f0-9]{64}$/.test(address.operationHash)) return { ok: false, reason: 'invalid_address', route: current };
    if (current.params.conversationId && current.params.conversationId !== address.conversationId) return { ok: false, reason: 'conversation_mismatch', route: current };
    for (const key of ['draftId', 'changeSetId', 'source', 'operationHash'] as const) {
      if (current.params[key] && current.params[key] !== address[key]) return { ok: false, reason: 'operation_mismatch', route: current };
    }
    const next = parseRoute(routeHash({ page: 'handoff', params: {
      ...current.params,
      conversationId: address.conversationId,
      draftId: address.draftId,
      changeSetId: address.changeSetId,
      source: address.source,
      operationHash: address.operationHash,
    } }));
    if (next.page !== 'handoff') return { ok: false, reason: 'invalid_address', route: current };
    const hash = routeHash(next);
    if (hash !== routeHash(current)) {
      this.host.write(hash, true);
      this.route = next;
      this.listeners.forEach((listener) => listener());
    }
    return { ok: true, route: next, hash, history: 'replace', preservedPage: true };
  };
  private states() {
    return [...this.guards].filter((guard) => guard.owner === this.route.page).map((guard) => {
      let state: ReturnType<LeaveGuard['getState']> = 'blocked';
      try { const value = guard.getState(); if (['clean', 'dirty', 'blocked'].includes(value)) state = value; } catch { /* Unreadable operation state cannot authorize unloading. */ }
      return { guard, state };
    });
  }
  shouldWarnBeforeUnload = () => this.states().some(({ state }) => state !== 'clean');
  navigate(hash: string, alreadyChanged = false): boolean {
    const next = parseRoute(hash), currentHash = routeHash(this.route), nextHash = routeHash(next);
    if (nextHash === currentHash) { if (alreadyChanged && hash !== currentHash) this.host.write(currentHash, true); return true; }
    const allowed = () => {
      const blocked = this.states().filter(({ state }) => state === 'blocked');
      for (const { guard } of blocked) { try { guard.onBlocked?.(); } catch { /* Notification failure does not release a guard. */ } }
      return blocked.length === 0;
    };
    if (!allowed() || (this.states().some(({ state }) => state === 'dirty') && !this.host.confirmDiscard()) || !allowed()) {
      if (alreadyChanged) this.host.write(currentHash, true);
      return false;
    }
    this.host.write(nextHash, alreadyChanged);
    this.route = next;
    this.listeners.forEach((listener) => listener());
    return true;
  }
}

export function bindHashNavigation(navigation: HashNavigation, win: Window, doc: Document): () => void {
  const changed = () => { navigation.navigate(win.location.hash, true); };
  const click = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute('download') || (anchor.target && anchor.target !== '_self')) return;
    const url = new URL(anchor.href, win.location.href);
    if (url.origin !== win.location.origin || url.pathname !== win.location.pathname || url.search !== win.location.search || !url.hash) return;
    if (doc.getElementById(url.hash.slice(1))) return;
    event.preventDefault(); navigation.navigate(url.hash);
  };
  const unload = (event: BeforeUnloadEvent) => { if (navigation.shouldWarnBeforeUnload()) { event.preventDefault(); event.returnValue = ''; } };
  doc.addEventListener('click', click); win.addEventListener('hashchange', changed); win.addEventListener('popstate', changed); win.addEventListener('beforeunload', unload);
  return () => { doc.removeEventListener('click', click); win.removeEventListener('hashchange', changed); win.removeEventListener('popstate', changed); win.removeEventListener('beforeunload', unload); };
}
