export interface Logger {
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
}

export class ConsoleLogger implements Logger {
  info(message: string, extra: Record<string, unknown> = {}): void {
    console.info(JSON.stringify({ level: "info", message, ...extra }));
  }

  warn(message: string, extra: Record<string, unknown> = {}): void {
    console.warn(JSON.stringify({ level: "warn", message, ...extra }));
  }

  error(message: string, extra: Record<string, unknown> = {}): void {
    console.error(JSON.stringify({ level: "error", message, ...extra }));
  }
}
