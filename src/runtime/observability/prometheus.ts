import type { MetricsSnapshot } from "./metrics.ts";

interface TimingSummary {
  count: number;
  sum: number;
  min: number;
  max: number;
  avg: number;
  p50: number;
  p90: number;
  p99: number;
}

function sanitizeMetricName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? 0;
}

function summarizeTimings(values: number[]): TimingSummary {
  if (values.length === 0) {
    return {
      count: 0,
      sum: 0,
      min: 0,
      max: 0,
      avg: 0,
      p50: 0,
      p90: 0,
      p99: 0
    };
  }

  const sum = values.reduce((total, value) => total + value, 0);
  return {
    count: values.length,
    sum,
    min: Math.min(...values),
    max: Math.max(...values),
    avg: sum / values.length,
    p50: percentile(values, 0.5),
    p90: percentile(values, 0.9),
    p99: percentile(values, 0.99)
  };
}

export function renderPrometheusMetrics(
  snapshot: MetricsSnapshot,
  options: {
    prefix?: string;
  } = {}
): string {
  const prefix = sanitizeMetricName(options.prefix ?? "hardess");
  const lines: string[] = [];

  for (const [name, value] of Object.entries(snapshot.counters)) {
    const metricName = `${prefix}_${sanitizeMetricName(name)}_total`;
    lines.push(`# HELP ${metricName} Hardess counter ${name}`);
    lines.push(`# TYPE ${metricName} counter`);
    lines.push(`${metricName} ${value}`);
  }

  for (const [name, values] of Object.entries(snapshot.timings)) {
    const metricBase = `${prefix}_${sanitizeMetricName(name)}`;
    const summary = summarizeTimings(values);
    lines.push(`# HELP ${metricBase}_milliseconds Hardess timing summary for ${name}`);
    lines.push(`# TYPE ${metricBase}_milliseconds summary`);
    lines.push(`${metricBase}_milliseconds_count ${summary.count}`);
    lines.push(`${metricBase}_milliseconds_sum ${summary.sum}`);
    lines.push(`${metricBase}_milliseconds{stat="min"} ${summary.min}`);
    lines.push(`${metricBase}_milliseconds{stat="max"} ${summary.max}`);
    lines.push(`${metricBase}_milliseconds{stat="avg"} ${summary.avg}`);
    lines.push(`${metricBase}_milliseconds{stat="p50"} ${summary.p50}`);
    lines.push(`${metricBase}_milliseconds{stat="p90"} ${summary.p90}`);
    lines.push(`${metricBase}_milliseconds{stat="p99"} ${summary.p99}`);
  }

  return `${lines.join("\n")}\n`;
}
