import type { PrismaClient } from "@prisma/client";
import type { SyncExecutionQueue } from "../queue/sync-queue.js";
import { sanitizeErrorMessage } from "../queue/error-sanitizer.js";
import { StaleProcessingRecoveryService } from "./recovery.js";
import { DurableDispatchScheduler } from "./scheduler.js";
import { RuntimeHealthService, type HealthProbeOverrides } from "./health.js";
import { resolveRuntimeConfig, validateRuntimeConfig } from "./config.js";
import type {
  RuntimeConfig,
  RuntimeClock,
  MaintenanceCycleResult,
  RecoveryServiceOptions,
  SchedulerServiceOptions,
} from "./types.js";

export interface RuntimeMaintenanceServiceOptions {
  config?: RuntimeConfig | undefined;
  clock?: RuntimeClock | undefined;
  redisUrl?: string | undefined;
  probes?: HealthProbeOverrides | undefined;
  cycleRunner?: (() => Promise<MaintenanceCycleResult | void>) | undefined;
  timerScheduler?: {
    setInterval: (handler: () => void, ms: number) => NodeJS.Timeout | number;
    clearInterval: (handle: NodeJS.Timeout | number) => void;
  } | undefined;
}

export class RuntimeMaintenanceService {
  readonly recoveryService: StaleProcessingRecoveryService;
  readonly schedulerService: DurableDispatchScheduler;
  readonly healthService: RuntimeHealthService;
  private readonly config: RuntimeConfig;
  private readonly cycleRunner: (() => Promise<MaintenanceCycleResult | void>) | undefined;
  private readonly timerScheduler: {
    setInterval: (handler: () => void, ms: number) => NodeJS.Timeout | number;
    clearInterval: (handle: NodeJS.Timeout | number) => void;
  } | undefined;

  private timer: NodeJS.Timeout | number | null = null;
  private isCycleRunning = false;
  private isStopping = false;
  private inFlightCyclePromise: Promise<void> | null = null;
  private skippedTicksCount = 0;
  private lastCycleError: string | null = null;

  constructor(
    prisma: PrismaClient,
    syncQueue: SyncExecutionQueue,
    options?: RuntimeMaintenanceServiceOptions
  ) {
    this.config = options?.config !== undefined ? validateRuntimeConfig(options.config) : resolveRuntimeConfig();
    const clock = options?.clock;
    this.cycleRunner = options?.cycleRunner;
    this.timerScheduler = options?.timerScheduler;

    this.recoveryService = new StaleProcessingRecoveryService(prisma, syncQueue, {
      config: this.config,
      ...(clock !== undefined ? { clock } : {}),
    });

    this.schedulerService = new DurableDispatchScheduler(prisma, syncQueue, {
      config: this.config,
    });

    this.healthService = new RuntimeHealthService(prisma, syncQueue, {
      config: this.config,
      ...(clock !== undefined ? { clock } : {}),
      ...(options?.redisUrl !== undefined ? { redisUrl: options.redisUrl } : {}),
      ...(options?.probes !== undefined ? { probes: options.probes } : {}),
    });
  }

  async executeCycle(options?: {
    recoveryOptions?: RecoveryServiceOptions | undefined;
    schedulerOptions?: SchedulerServiceOptions | undefined;
  }): Promise<MaintenanceCycleResult> {
    // 1. Recover stale PROCESSING jobs
    const recovery = await this.recoveryService.recoverStaleJobs(options?.recoveryOptions);

    // 2. Dispatch PENDING jobs
    const dispatch = await this.schedulerService.dispatchPendingJobs(options?.schedulerOptions);

    // 3. Inspect runtime health
    const health = await this.healthService.getHealthSnapshot();

    return {
      recovery,
      dispatch,
      health,
    };
  }

  async runCycleTick(): Promise<void> {
    if (this.isCycleRunning || this.isStopping) {
      this.skippedTicksCount++;
      return;
    }

    this.isCycleRunning = true;
    this.inFlightCyclePromise = (async () => {
      try {
        if (this.cycleRunner) {
          await this.cycleRunner();
        } else {
          await this.executeCycle();
        }
      } catch (err: unknown) {
        // Catch all errors: zero unhandled promise rejections
        this.lastCycleError = sanitizeErrorMessage(err);
      } finally {
        this.isCycleRunning = false;
        this.inFlightCyclePromise = null;
      }
    })();

    await this.inFlightCyclePromise;
  }

  start(): boolean {
    if (this.timer !== null || this.isStopping) {
      return false; // Idempotent start or shutdown in progress
    }

    const scheduleFn = this.timerScheduler?.setInterval ?? setInterval;
    this.timer = scheduleFn(async () => {
      await this.runCycleTick();
    }, this.config.maintenanceIntervalMs);

    // Ensure timer does not prevent clean process exit
    if (this.timer && typeof this.timer === "object" && "unref" in this.timer && typeof this.timer.unref === "function") {
      this.timer.unref();
    }
    return true;
  }

  async stop(): Promise<void> {
    this.isStopping = true;

    if (this.timer !== null) {
      if (this.timerScheduler) {
        this.timerScheduler.clearInterval(this.timer);
      } else {
        clearInterval(this.timer);
      }
      this.timer = null;
    }

    // Await any in-flight cycle before completing stop
    if (this.inFlightCyclePromise !== null) {
      try {
        await this.inFlightCyclePromise;
      } catch {
        // Already handled inside cycle tick
      }
    }

    this.isStopping = false;
    this.isCycleRunning = false;
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }

  get isExecutingCycle(): boolean {
    return this.isCycleRunning;
  }

  get skippedTicks(): number {
    return this.skippedTicksCount;
  }

  get lastError(): string | null {
    return this.lastCycleError;
  }
}
