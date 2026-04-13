import { z } from "zod";

export interface LatencySummary {
  count: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
  p50Ms: number;
  p90Ms: number;
  p99Ms: number;
}

export interface NumericSeriesSummary {
  count: number;
  min: number;
  max: number;
  avg: number;
  stddev: number;
}

export interface MetricsSnapshot {
  counters?: Record<string, number>;
  timings?: Record<string, number[]>;
}

const metricsSnapshotSchema = z.object({
  counters: z.record(z.string(), z.number()).optional(),
  timings: z.record(z.string(), z.array(z.number())).optional()
});

const adminMetricsResponseSchema = z.object({
  metrics: metricsSnapshotSchema.nullish()
});

const env = globalThis as {
  process?: {
    env?: Record<string, string | undefined>;
  };
};

export function envNumber(name: string, fallback: number): number {
  const value = env.process?.env?.[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function envString(name: string, fallback: string): string {
  return env.process?.env?.[name] ?? fallback;
}

export function envStringFirst(names: string[], fallback: string): string {
  for (const name of names) {
    const value = env.process?.env?.[name];
    if (value !== undefined) {
      return value;
    }
  }

  return fallback;
}

export function envNumberFirst(names: string[], fallback: number): number {
  for (const name of names) {
    const value = env.process?.env?.[name];
    if (!value) {
      continue;
    }

    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return fallback;
}

export function envOptionalStringFirst(names: string[]): string | undefined {
  for (const name of names) {
    const value = env.process?.env?.[name];
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

export function percentile(values: number[], ratio: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? 0;
}

export function summarizeLatencies(values: number[]): LatencySummary {
  if (values.length === 0) {
    return {
      count: 0,
      minMs: 0,
      maxMs: 0,
      avgMs: 0,
      p50Ms: 0,
      p90Ms: 0,
      p99Ms: 0
    };
  }

  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    count: values.length,
    minMs: Math.min(...values),
    maxMs: Math.max(...values),
    avgMs: total / values.length,
    p50Ms: percentile(values, 0.5),
    p90Ms: percentile(values, 0.9),
    p99Ms: percentile(values, 0.99)
  };
}

export function summarizeSeries(values: number[]): NumericSeriesSummary {
  if (values.length === 0) {
    return {
      count: 0,
      min: 0,
      max: 0,
      avg: 0,
      stddev: 0
    };
  }

  const total = values.reduce((sum, value) => sum + value, 0);
  const avg = total / values.length;
  const variance = values.reduce((sum, value) => sum + ((value - avg) ** 2), 0) / values.length;

  return {
    count: values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    avg,
    stddev: Math.sqrt(variance)
  };
}

export async function fetchAdminMetrics(baseUrl: string): Promise<MetricsSnapshot | null> {
  try {
    const response = await fetch(`${baseUrl}/__admin/metrics`);
    if (!response.ok) {
      return null;
    }

    return parseAdminMetricsResponse(await response.json());
  } catch {
    return null;
  }
}

export function parseAdminMetricsResponse(value: unknown): MetricsSnapshot | null {
  const result = adminMetricsResponseSchema.safeParse(value);
  if (!result.success) {
    return null;
  }

  return result.data.metrics ?? null;
}

export function parseJsonText(value: string): unknown | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export function parseErrorPayload(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  return parseJsonText(message) ?? message;
}

export function diffMetricsSnapshot(
  before: MetricsSnapshot | null,
  after: MetricsSnapshot | null
): MetricsSnapshot | null {
  if (!before || !after) {
    return null;
  }

  const counterNames = new Set([
    ...Object.keys(before.counters ?? {}),
    ...Object.keys(after.counters ?? {})
  ]);
  const timingNames = new Set([
    ...Object.keys(before.timings ?? {}),
    ...Object.keys(after.timings ?? {})
  ]);

  return {
    counters: Object.fromEntries(
      Array.from(counterNames).map((name) => [
        name,
        (after.counters?.[name] ?? 0) - (before.counters?.[name] ?? 0)
      ])
    ),
    timings: Object.fromEntries(
      Array.from(timingNames).map((name) => [
        name,
        (after.timings?.[name] ?? []).slice((before.timings?.[name] ?? []).length)
      ])
    )
  };
}

export function incCounter(bucket: Record<string, number>, key: string, value = 1): void {
  bucket[key] = (bucket[key] ?? 0) + value;
}
