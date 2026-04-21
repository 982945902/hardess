import { resolve } from "node:path";

import { resolveCliOptions } from "./cli-args";
import { applyRuntimeAdapterOverrides, loadExperimentInputs } from "./config-model";
import { resolveRuntimeModel } from "./resolved-runtime-model";

const rootDir = resolve(import.meta.dir);
const { assignmentPath, runtimeAdapterPath, planningFragmentPath, protocolPackagePath, listenAddressOverride } = resolveCliOptions(
  rootDir,
  process.argv.slice(2)
);
const { assignment, runtimeAdapter: loadedRuntimeAdapter, planningFragment, protocolPackage } = loadExperimentInputs({
  assignmentPath,
  runtimeAdapterPath,
  planningFragmentPath,
  protocolPackagePath
});
const runtimeAdapter = applyRuntimeAdapterOverrides(loadedRuntimeAdapter, {
  listenAddress: listenAddressOverride
});

process.stdout.write(
  `${JSON.stringify(resolveRuntimeModel(assignment, runtimeAdapter, planningFragment, protocolPackage), null, 2)}\n`
);
