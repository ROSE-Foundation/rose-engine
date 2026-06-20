// Faithful async on-chain confirmation transport (Story 9.1, FR-28, NFR-9). The production-faithful
// counterpart to the paper INSTANT in-process auto-confirm (`rose-note/src/paper/paper-mode.ts`,
// `api/src/paper-position-service.ts`): instead of synthesizing the confirmed event and driving the
// commit point IMMEDIATELY, the faithful wrappers hand this transport a job `{ txHash, confirm }`; the
// transport SCHEDULES the SAME `confirmFrom…Event` commit point after a configurable LATENCY, and can
// INJECT a failure that drives the REAL Epic-5 saga COMPENSATION path (SUBMITTED → FAILED → COMPENSATED)
// instead of confirming. The flow therefore stays `pending` until the delayed commit point (no optimistic
// success), then flips `confirmed`; or, on an injected failure, ends `failed` with NO ledger effect ever
// applied (the commit point never runs) — whole-or-nothing by construction.
//
// The transport invents NO new compensation: it reuses the existing `OutboxSaga.fail` / `.compensate`.
// The scheduler is a substitutable seam (NFR-8): production binds `setTimeout`; tests bind a manual
// scheduler so the delayed commit point is driven DETERMINISTICALLY (no real waiting). SECURITY: in-
// process only, NO network, NO secret — it shapes confirmation TIMING/SUCCESS over the paper transport.
import { OutboxSaga } from '@rose/chain';
import { findByTxHash, type RoseDb } from '@rose/ledger';
import type { FaithfulConfirmationSettingsStore } from './confirmation-settings.js';

/** A scheduled task. Returns void (production `setTimeout`) or a Promise (awaited by the manual scheduler). */
export type ScheduledTask = () => void | Promise<void>;

/** The scheduler seam: run `task` after `delayMs`. Substitutable (NFR-8) — real vs deterministic test. */
export interface Scheduler {
  schedule(delayMs: number, task: ScheduledTask): void;
}

/**
 * The production scheduler: a `setTimeout` (unref'd so a pending confirmation never keeps the process
 * alive on shutdown). Fire-and-forget — a task that returns a rejected promise is the transport's
 * concern (its `run` wrapper catches), so this never sees an unhandled rejection.
 */
export const realScheduler: Scheduler = {
  schedule(delayMs: number, task: ScheduledTask): void {
    const handle = setTimeout(() => {
      void task();
    }, delayMs);
    if (typeof handle.unref === 'function') {
      handle.unref();
    }
  },
};

/** A deterministic test scheduler: records tasks (with their delay) and runs them on demand. */
export interface ManualScheduler extends Scheduler {
  /** Number of tasks queued and not yet run. */
  readonly pending: number;
  /** Run every queued task in FIFO order, awaiting each (incl. tasks enqueued while running). */
  runAll(): Promise<void>;
}

/** Builds a manual scheduler — the test seam that drives the delayed commit point with no real wait. */
export function makeManualScheduler(): ManualScheduler {
  const queue: ScheduledTask[] = [];
  return {
    schedule(_delayMs: number, task: ScheduledTask): void {
      queue.push(task);
    },
    get pending(): number {
      return queue.length;
    },
    async runAll(): Promise<void> {
      while (queue.length > 0) {
        const task = queue.shift();
        if (task) {
          await task();
        }
      }
    },
  };
}

/** A unit of work the transport schedules: confirm the commit point for `txHash` (success path). */
export interface ConfirmationJob {
  /** The submitted tx hash whose confirmed event the wrapper reconstructed. */
  readonly txHash: string;
  /** Drives the SAME `confirmFrom…Event` commit point the paper wrapper drives instantly. */
  confirm(): Promise<void>;
}

/** Injected dependencies for the transport. Builds its own saga over the SAME db for compensation. */
export interface FaithfulConfirmationTransportDeps {
  readonly db: RoseDb;
  readonly scheduler: Scheduler;
  readonly settings: FaithfulConfirmationSettingsStore;
  /** Injected randomness for the failure-rate dice (default `Math.random`) — deterministic in tests. */
  readonly random?: () => number;
}

/**
 * The faithful confirmation transport. Each freshly-submitted write hands it a `ConfirmationJob`; it
 * reads the current latency/failure settings, DECIDES (at schedule time, once per flow) whether to
 * inject a failure, and schedules a task that — after the latency — either drives the success commit
 * point (`job.confirm()`) or compensates the flow via the existing saga. Tasks are fire-and-forget;
 * their bodies catch + warn so a confirmation error never escapes into the timer (mirrors the
 * watcher-facing "confirm never throws" contract of Epic 5).
 */
export class FaithfulConfirmationTransport {
  private readonly db: RoseDb;
  private readonly scheduler: Scheduler;
  private readonly settings: FaithfulConfirmationSettingsStore;
  private readonly saga: OutboxSaga;
  private readonly random: () => number;

  constructor(deps: FaithfulConfirmationTransportDeps) {
    this.db = deps.db;
    this.scheduler = deps.scheduler;
    this.settings = deps.settings;
    // Reuse the EXISTING saga compensation (NFR-8/NFR-9): a saga over the same db; `fail`/`compensate`
    // key on the outbox row id, so this shares the lifecycle with the services' own sagas.
    this.saga = new OutboxSaga({ db: deps.db });
    this.random = deps.random ?? Math.random;
  }

  /**
   * Schedules the delayed commit point for a submitted flow. Reads the latency + failure decision NOW
   * (consuming any `failNext` one-shot), then schedules a single task after `latencyMs`. NO optimistic
   * success: nothing is confirmed synchronously here — the caller returns its PENDING view unchanged.
   */
  scheduleConfirmation(job: ConfirmationJob): void {
    const { latencyMs, failureRate } = this.settings.get();
    const shouldFail = this.settings.consumeFailNext() || this.random() < failureRate;
    this.scheduler.schedule(latencyMs, () => this.run(job, shouldFail));
  }

  /** Runs the scheduled decision: confirm (success) or compensate (injected failure). Never throws. */
  private async run(job: ConfirmationJob, shouldFail: boolean): Promise<void> {
    try {
      if (shouldFail) {
        await this.compensate(job.txHash);
      } else {
        await job.confirm();
      }
    } catch (error) {
      console.warn('[faithful] scheduled confirmation task failed — left for reconcile (5.6)', {
        txHash: job.txHash,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Drives the EXISTING saga compensation for an injected mock-watcher failure: looks up the SUBMITTED
   * outbox row by tx hash and flips SUBMITTED → FAILED → COMPENSATED. The commit-point ledger effect is
   * NEVER applied (it only runs in `confirm`), so there is no orphaned position and no unbalanced ledger
   * — the flow ends `failed` with no half-applied state (FR-28, NFR-9).
   */
  private async compensate(txHash: string): Promise<void> {
    const row = await findByTxHash(this.db, txHash);
    if (row === null) {
      console.warn(
        '[faithful] injected failure: no outbox row matches tx hash — nothing to compensate',
        {
          txHash,
        },
      );
      return;
    }
    if (row.status !== 'SUBMITTED') {
      // Already terminal (e.g. a re-delivered failure, or confirmed by another path): no-op, not an error.
      console.warn(
        '[faithful] injected failure: outbox row is not SUBMITTED — skipping compensation',
        {
          outboxId: row.id,
          status: row.status,
          txHash,
        },
      );
      return;
    }
    await this.saga.fail(row.id, 'faithful: injected mock-watcher tx failure (FR-28)');
    await this.saga.compensate(row.id);
    console.info(
      '[faithful] injected failure compensated — no ledger effect applied (whole-or-nothing)',
      {
        outboxId: row.id,
        txHash,
      },
    );
  }
}
