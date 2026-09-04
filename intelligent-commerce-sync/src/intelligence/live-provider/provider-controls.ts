/**
 * Phase 5E: Local Provider Controls
 * Clock-based rate limiter, circuit breaker with probe concurrency locking,
 * and exact usage ledger with subtotal semantics.
 */

import type {
  Clock,
  CircuitState,
  LiveProviderUsageSnapshot,
} from "./types.js";

export class SystemClock implements Clock {
  nowMs(): number {
    return Date.now();
  }
}

export class RateLimiter {
  private timestamps: number[] = [];

  constructor(private readonly clock: Clock) {}

  checkAndReserve(windowMs: number, maxRequests: number): boolean {
    const now = this.clock.nowMs();
    const windowStart = now - windowMs;

    // Prune expired timestamps
    this.timestamps = this.timestamps.filter((ts) => ts >= windowStart);

    if (this.timestamps.length >= maxRequests) {
      return false;
    }

    this.timestamps.push(now);
    return true;
  }

  reset(): void {
    this.timestamps = [];
  }
}

export class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private failures = 0;
  private openedAtMs = 0;
  private halfOpenProbeInFlight = false;

  constructor(private readonly clock: Clock) {}

  getState(): CircuitState {
    return this.state;
  }

  getFailures(): number {
    return this.failures;
  }

  isProbeInFlight(): boolean {
    return this.halfOpenProbeInFlight;
  }

  canAttempt(cooldownMs: number): { allowed: boolean; isProbe: boolean } {
    const now = this.clock.nowMs();

    if (this.state === "CLOSED") {
      return { allowed: true, isProbe: false };
    }

    if (this.state === "OPEN") {
      if (now - this.openedAtMs >= cooldownMs) {
        this.state = "HALF_OPEN";
        this.halfOpenProbeInFlight = true;
        return { allowed: true, isProbe: true };
      }
      return { allowed: false, isProbe: false };
    }

    // HALF_OPEN
    if (this.halfOpenProbeInFlight) {
      return { allowed: false, isProbe: false };
    }

    this.halfOpenProbeInFlight = true;
    return { allowed: true, isProbe: true };
  }

  recordSuccess(): void {
    this.state = "CLOSED";
    this.failures = 0;
    this.halfOpenProbeInFlight = false;
  }

  recordHealthFailure(failureThreshold: number): void {
    const now = this.clock.nowMs();

    if (this.state === "HALF_OPEN") {
      this.state = "OPEN";
      this.openedAtMs = now;
      this.halfOpenProbeInFlight = false;
      return;
    }

    if (this.state === "CLOSED") {
      this.failures++;
      if (this.failures >= failureThreshold) {
        this.state = "OPEN";
        this.openedAtMs = now;
      }
    }
  }

  clearProbeFlag(): void {
    this.halfOpenProbeInFlight = false;
  }

  reset(): void {
    this.state = "CLOSED";
    this.failures = 0;
    this.openedAtMs = 0;
    this.halfOpenProbeInFlight = false;
  }
}

export class UsageLedger {
  private completeCalls = 0;
  private dryRunChecks = 0;
  private networkDispatches = 0;
  private successfulNetworkResponses = 0;
  private failedNetworkResponses = 0;
  private rateLimitBlocked = 0;
  private budgetBlocked = 0;
  private circuitBlocked = 0;
  private usageReportedRequests = 0;
  private usageMissingRequests = 0;
  private reportedInputTokens = 0;
  private reportedOutputTokens = 0;
  private reportedTotalTokens = 0;

  incrementCompleteCalls(): void {
    this.completeCalls++;
  }

  incrementDryRunChecks(): void {
    this.dryRunChecks++;
  }

  incrementNetworkDispatches(): void {
    this.networkDispatches++;
  }

  incrementSuccessfulNetworkResponses(): void {
    this.successfulNetworkResponses++;
  }

  incrementFailedNetworkResponses(): void {
    this.failedNetworkResponses++;
  }

  incrementRateLimitBlocked(): void {
    this.rateLimitBlocked++;
  }

  incrementBudgetBlocked(): void {
    this.budgetBlocked++;
  }

  incrementCircuitBlocked(): void {
    this.circuitBlocked++;
  }

  recordUsage(inputTokens: number, outputTokens: number, totalTokens: number): void {
    this.usageReportedRequests++;
    this.reportedInputTokens += inputTokens;
    this.reportedOutputTokens += outputTokens;
    this.reportedTotalTokens += totalTokens;
  }

  recordMissingUsage(): void {
    this.usageMissingRequests++;
  }

  getSnapshot(): LiveProviderUsageSnapshot {
    return Object.freeze({
      completeCalls: this.completeCalls,
      dryRunChecks: this.dryRunChecks,
      networkDispatches: this.networkDispatches,
      successfulNetworkResponses: this.successfulNetworkResponses,
      failedNetworkResponses: this.failedNetworkResponses,
      rateLimitBlocked: this.rateLimitBlocked,
      budgetBlocked: this.budgetBlocked,
      circuitBlocked: this.circuitBlocked,
      usageReportedRequests: this.usageReportedRequests,
      usageMissingRequests: this.usageMissingRequests,
      reportedInputTokens: this.reportedInputTokens,
      reportedOutputTokens: this.reportedOutputTokens,
      reportedTotalTokens: this.reportedTotalTokens,
    });
  }
}

export class ProviderControls {
  readonly rateLimiter: RateLimiter;
  readonly circuitBreaker: CircuitBreaker;
  readonly usageLedger: UsageLedger;

  constructor(clock: Clock) {
    this.rateLimiter = new RateLimiter(clock);
    this.circuitBreaker = new CircuitBreaker(clock);
    this.usageLedger = new UsageLedger();
  }

  getUsageSnapshot(): LiveProviderUsageSnapshot {
    return this.usageLedger.getSnapshot();
  }
}
