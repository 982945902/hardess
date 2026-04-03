export interface Metrics {
  increment(name: string, value?: number): void;
  timing(name: string, valueMs: number): void;
}

export class NoopMetrics implements Metrics {
  increment(_name: string, _value = 1): void {}

  timing(_name: string, _valueMs: number): void {}
}
