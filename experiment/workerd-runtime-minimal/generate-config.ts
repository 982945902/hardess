import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { resolveCliOptions } from "./cli-args";
import { loadExperimentInputs } from "./config-model";
import { renderConfig } from "./config-render";

const rootDir = resolve(import.meta.dir);
const { assignmentPath, runtimeAdapterPath, planningFragmentPath, protocolPackagePath, outputPath } =
  resolveCliOptions(rootDir, process.argv.slice(2));
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
