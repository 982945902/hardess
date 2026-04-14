export interface Metrics {
  increment(name: string, value?: number): void;
  timing(name: string, valueMs: number): void;
}

export interface MetricsSnapshot {
  counters: Record<string, number>;
  timings: Record<string, number[]>;
  timingCounts: Record<string, number>;
}

export interface MetricsSnapshotProvider extends Metrics {
  snapshot(): MetricsSnapshot;
}

export class NoopMetrics implements Metrics {
  increment(_name: string, _value = 1): void {}

  timing(_name: string, _valueMs: number): void {}
}

export class InMemoryMetrics implements MetricsSnapshotProvider {
  private readonly counters = new Map<string, number>();
  private readonly timingsByName = new Map<string, number[]>();

  increment(name: string, value = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + value);
  }

  timing(name: string, valueMs: number): void {
    const values = this.timingsByName.get(name) ?? [];
    values.push(valueMs);
    this.timingsByName.set(name, values);
  }

  counter(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  timings(name: string): number[] {
    return [...(this.timingsByName.get(name) ?? [])];
  }

  snapshot(): MetricsSnapshot {
    return {
      counters: Object.fromEntries(this.counters),
      timings: Object.fromEntries(
        Array.from(this.timingsByName.entries()).map(([name, values]) => [name, [...values]])
      ),
      timingCounts: Object.fromEntries(
        Array.from(this.timingsByName.entries()).map(([name, values]) => [name, values.length])
      )
    };
  }

  reset(): void {
    this.counters.clear();
    this.timingsByName.clear();
  }
}

export class WindowedMetrics implements MetricsSnapshotProvider {
  private readonly counters = new Map<string, number>();
  private readonly timingsByName = new Map<string, number[]>();
  private readonly timingCounts = new Map<string, number>();

  constructor(private readonly maxTimingsPerMetric = 1024) {}

  increment(name: string, value = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + value);
  }

  timing(name: string, valueMs: number): void {
    const values = this.timingsByName.get(name) ?? [];
    values.push(valueMs);
    this.timingCounts.set(name, (this.timingCounts.get(name) ?? 0) + 1);
    if (values.length > this.maxTimingsPerMetric) {
      values.splice(0, values.length - this.maxTimingsPerMetric);
    }
    this.timingsByName.set(name, values);
  }

  snapshot(): MetricsSnapshot {
    return {
      counters: Object.fromEntries(this.counters),
      timings: Object.fromEntries(
        Array.from(this.timingsByName.entries()).map(([name, values]) => [name, [...values]])
      ),
      timingCounts: Object.fromEntries(this.timingCounts)
    };
  }
}

export class CompositeMetrics implements Metrics {
  constructor(private readonly sinks: Metrics[]) {}

  increment(name: string, value = 1): void {
    for (const sink of this.sinks) {
      sink.increment(name, value);
    }
  }

  timing(name: string, valueMs: number): void {
    for (const sink of this.sinks) {
      sink.timing(name, valueMs);
    }
  }
}
