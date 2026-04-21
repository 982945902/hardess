import { resolve } from "node:path";

export interface CliInputPaths {
  assignmentPath: string;
  runtimeAdapterPath: string;
  planningFragmentPath: string;
  protocolPackagePath: string;
}

export interface CliOptions extends CliInputPaths {
  outputPath: string;
}

export function readCliArgs(argv: string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      continue;
    }

    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`missing value for --${key}`);
    }

    options.set(key, value);
    index += 1;
  }

  return options;
}

export function resolveCliOptions(rootDir: string, argv: string[]): CliOptions {
  const cliArgs = readCliArgs(argv);
  const resolveOverride = (key: string, fallback: string): string => {
    const value = cliArgs.get(key);
    if (!value) {
      return resolve(rootDir, fallback);
    }

    return resolve(process.cwd(), value);
  };

  return {
    assignmentPath: resolveOverride("assignment", "assignment.json"),
    runtimeAdapterPath: resolveOverride("runtime-adapter", "runtime-adapter.json"),
    planningFragmentPath: resolveOverride("planning-fragment", "planning-fragment.json"),
    protocolPackagePath: resolveOverride("protocol-package", "protocol-package.json"),
    outputPath: resolveOverride("output", ".generated.config.capnp")
  };
}
