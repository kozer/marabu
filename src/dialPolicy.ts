export class DialPolicy {
  private failedAttempts = new Map<string, number>();
  private lastAttempt = new Map<string, number>();

  constructor(private readonly logger: any) {}

  markSuccess(peer: string): void {
    this.failedAttempts.delete(peer);
    this.lastAttempt.set(peer, Date.now());
  }

  markFailure(peer: string): void {
    const attempts = (this.failedAttempts.get(peer) || 0) + 1;
    this.failedAttempts.set(peer, attempts);
    this.lastAttempt.set(peer, Date.now());
    this.logger.debug(`Peer ${peer} failed. Total attempts: ${attempts}`);
  }

  canDial(peer: string, now = Date.now()): boolean {
    const failures = this.failedAttempts.get(peer) || 0;
    const lastTime = this.lastAttempt.get(peer) || 0;

    if (failures === 0) {
      return true;
    }

    const cooldown = Math.pow(2, failures) * 60 * 1000;
    return now - lastTime >= cooldown;
  }
}
