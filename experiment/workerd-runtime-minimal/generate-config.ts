import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { resolveCliOptions } from "./cli-args";
import { applyRuntimeAdapterOverrides, loadExperimentInputs } from "./config-model";
import { renderConfig } from "./config-render";

const rootDir = resolve(import.meta.dir);
const { assignmentPath, runtimeAdapterPath, planningFragmentPath, protocolPackagePath, outputPath, listenAddressOverride } =
  resolveCliOptions(rootDir, process.argv.slice(2));
const { assignment, runtimeAdapter: loadedRuntimeAdapter, planningFragment, protocolPackage } = loadExperimentInputs({
  assignmentPath,
  runtimeAdapterPath,
  planningFragmentPath,
  protocolPackagePath
});
const runtimeAdapter = applyRuntimeAdapterOverrides(loadedRuntimeAdapter, {
  listenAddress: listenAddressOverride
});
const config = renderConfig(assignment, runtimeAdapter, planningFragment, protocolPackage, outputPath);

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, config, "utf8");

process.stdout.write(`${outputPath}\n`);
