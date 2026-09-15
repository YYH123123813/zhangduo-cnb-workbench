export class RequestGate {
  private sequence = 0;
  private active: number | null = null;
  private replaceableRead = false;

  get pending() { return this.active !== null; }
  begin(): number | null {
    if (this.pending) return null;
    return this.start(false);
  }
  beginReplacingRead(): number | null {
    if (this.pending && !this.replaceableRead) return null;
    return this.start(true);
  }
  private start(replaceableRead: boolean) {
    this.active = ++this.sequence;
    this.replaceableRead = replaceableRead;
    return this.active;
  }
  cancelReplacingRead(): boolean {
    if (!this.pending || !this.replaceableRead) return false;
    this.invalidate();
    return true;
  }
  isCurrent(ticket: number) { return this.active === ticket; }
  finish(ticket: number): boolean {
    if (!this.isCurrent(ticket)) return false;
    this.active = null;
    this.replaceableRead = false;
    return true;
  }
  // Detach late responses without claiming that an already sent write was canceled.
  invalidate() { this.active = null; this.replaceableRead = false; }
}
