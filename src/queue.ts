/**
 * queue.ts — In-memory concurrent job queue with configurable concurrency.
 *
 * Jobs are processed in FIFO order. Each job has an AbortController for cancellation.
 * The queue stores the BunSubProcess reference for active jobs to enable SIGTERM/SIGKILL.
 */

import type { BunSubProcess, Job } from "./types";

export type JobProcessor = (job: Job) => Promise<void>;

export interface QueueStatus {
  active: number;
  pending: number;
}

export class JobQueue {
  private readonly concurrency: number;
  private readonly pending: Job[] = [];
  private readonly active = new Map<string, Job>();
  private processor: JobProcessor | null = null;

  constructor(concurrency: number) {
    this.concurrency = Math.max(1, concurrency);
  }

  /**
   * Set the job processor function. Must be called before enqueue.
   */
  setProcessor(fn: JobProcessor): void {
    this.processor = fn;
  }

  /**
   * Enqueue a new job. If a slot is available, processing starts immediately.
   * Returns the job ID.
   */
  enqueue(issueId: string, projectId: string): string {
    const job: Job = {
      id: crypto.randomUUID(),
      issueId,
      projectId,
      signal: new AbortController(),
    };
    this.pending.push(job);
    this.drain();
    return job.id;
  }

  /**
   * Find an active job by Plane issue ID.
   */
  findActiveByIssueId(issueId: string): Job | undefined {
    for (const job of this.active.values()) {
      if (job.issueId === issueId) return job;
    }
    return undefined;
  }

  /**
   * Find a pending job by Plane issue ID.
   */
  findPendingByIssueId(issueId: string): Job | undefined {
    return this.pending.find((j) => j.issueId === issueId);
  }

  /**
   * Check if an issue is already queued (active or pending).
   */
  hasIssue(issueId: string): boolean {
    return !!this.findActiveByIssueId(issueId) || !!this.findPendingByIssueId(issueId);
  }

  /**
   * Store the subprocess reference for an active job (called by worker after spawn).
   */
  setProcess(jobId: string, proc: BunSubProcess): void {
    const job = this.active.get(jobId);
    if (job) {
      job.process = proc;
    }
  }

  /**
   * Get the current queue status.
   */
  status(): QueueStatus {
    return {
      active: this.active.size,
      pending: this.pending.length,
    };
  }

  /**
   * Graceful shutdown: abort all active jobs and clear pending queue.
   * Sends SIGTERM to all active processes, waits 10s, then SIGKILL.
   */
  async killActive(): Promise<void> {
    // Clear pending queue
    this.pending.length = 0;

    // Abort all active jobs
    const killPromises: Promise<void>[] = [];

    for (const job of this.active.values()) {
      job.signal.abort();
      if (job.process) {
        killPromises.push(this.killProcess(job.process));
      }
    }

    await Promise.all(killPromises);
    this.active.clear();
  }

  /**
   * Cancel a specific job by job ID. Returns true if job was found and cancelled.
   */
  async cancelJob(jobId: string): Promise<boolean> {
    // Check pending first
    const pendingIdx = this.pending.findIndex((j) => j.id === jobId);
    if (pendingIdx !== -1) {
      const [job] = this.pending.splice(pendingIdx, 1);
      job.signal.abort();
      return true;
    }

    // Check active
    const job = this.active.get(jobId);
    if (job) {
      job.signal.abort();
      if (job.process) {
        await this.killProcess(job.process);
      }
      this.active.delete(jobId);
      this.drain();
      return true;
    }

    return false;
  }

  /**
   * Cancel a job by issue ID. Returns true if job was found and cancelled.
   */
  async cancelByIssueId(issueId: string): Promise<boolean> {
    // Check pending first
    const pendingIdx = this.pending.findIndex((j) => j.issueId === issueId);
    if (pendingIdx !== -1) {
      const [job] = this.pending.splice(pendingIdx, 1);
      job.signal.abort();
      return true;
    }

    // Check active
    const job = this.findActiveByIssueId(issueId);
    if (job) {
      job.signal.abort();
      if (job.process) {
        await this.killProcess(job.process);
      }
      this.active.delete(job.id);
      this.drain();
      return true;
    }

    return false;
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /**
   * Start processing jobs if slots are available.
   */
  private drain(): void {
    while (this.active.size < this.concurrency && this.pending.length > 0) {
      const job = this.pending.shift()!;
      this.active.set(job.id, job);
      this.processJob(job);
    }
  }

  /**
   * Process a single job and handle completion.
   */
  private async processJob(job: Job): Promise<void> {
    if (!this.processor) {
      console.error(`[queue] No processor set, dropping job ${job.id}`);
      this.active.delete(job.id);
      this.drain();
      return;
    }

    try {
      await this.processor(job);
    } catch (err) {
      console.error(`[queue] Job ${job.id} failed:`, err);
    } finally {
      this.active.delete(job.id);
      this.drain();
    }
  }

  /**
   * Kill a subprocess: SIGTERM → wait 10s → SIGKILL.
   */
  private async killProcess(proc: BunSubProcess): Promise<void> {
    proc.kill("SIGTERM");

    const killTimer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Process may have already exited
      }
    }, 10_000);

    try {
      await proc.exited;
    } finally {
      clearTimeout(killTimer);
    }
  }
}
