export class DialPolicy {
  private failedAttempts = new Map<string, number>();
  private lastAttempt = new Map<string, number>();
  private blacklist = new Map<string, { until: number; reason: string }>();

  constructor(private readonly logger: any) {}

  markSuccess(peer: string): void {
    this.failedAttempts.delete(peer);
    this.lastAttempt.set(peer, Date.now());
    this.blacklist.delete(peer);
  }

  markFailure(peer: string): void {
    const attempts = (this.failedAttempts.get(peer) || 0) + 1;
    this.failedAttempts.set(peer, attempts);
    this.lastAttempt.set(peer, Date.now());
    this.logger.debug(`Peer ${peer} failed. Total attempts: ${attempts}`);
  }

  blacklistPeer(peer: string, ttlMs: number, reason: string): void {
    const until = Date.now() + ttlMs;
    this.blacklist.set(peer, { until, reason });
    this.logger.warn(
      `Blacklisted peer ${peer} for ${ttlMs}ms. Reason: ${reason}`,
    );
  }

  isBlacklisted(peer: string, now = Date.now()): boolean {
    const entry = this.blacklist.get(peer);
    if (!entry) {
      return false;
    }

    if (entry.until <= now) {
      this.blacklist.delete(peer);
      return false;
    }

    return true;
  }

  canDial(peer: string, now = Date.now()): boolean {
    if (this.isBlacklisted(peer, now)) {
      return false;
    }

    const failures = this.failedAttempts.get(peer) || 0;
    const lastTime = this.lastAttempt.get(peer) || 0;

    if (failures === 0) {
      return true;
    }

    const cooldown = Math.pow(2, failures) * 60 * 1000;
    return now - lastTime >= cooldown;
  }
}
