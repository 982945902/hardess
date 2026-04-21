import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadExperimentInputs } from "./config-model";
import { renderConfig } from "./config-render";

const rootDir = resolve(import.meta.dir);

function readCliArgs(argv: string[]) {
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

const cliArgs = readCliArgs(process.argv.slice(2));
const assignmentPath = resolve(rootDir, cliArgs.get("assignment") ?? "assignment.json");
const runtimeAdapterPath = resolve(rootDir, cliArgs.get("runtime-adapter") ?? "runtime-adapter.json");
const planningFragmentPath = resolve(rootDir, cliArgs.get("planning-fragment") ?? "planning-fragment.json");
const protocolPackagePath = resolve(rootDir, cliArgs.get("protocol-package") ?? "protocol-package.json");
const outputPath = resolve(rootDir, cliArgs.get("output") ?? ".generated.config.capnp");
const { assignment, runtimeAdapter, planningFragment, protocolPackage } = loadExperimentInputs({
  assignmentPath,
  runtimeAdapterPath,
  planningFragmentPath,
  protocolPackagePath
});
const config = renderConfig(assignment, runtimeAdapter, planningFragment, protocolPackage);

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, config, "utf8");

process.stdout.write(`${outputPath}\n`);
