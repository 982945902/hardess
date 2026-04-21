import { resolve } from "node:path";

import { resolveCliOptions } from "./cli-args";
import { loadExperimentInputs } from "./config-model";
import { resolveRuntimeModel } from "./resolved-runtime-model";

const rootDir = resolve(import.meta.dir);
const { assignmentPath, runtimeAdapterPath, planningFragmentPath, protocolPackagePath } = resolveCliOptions(
  rootDir,
  process.argv.slice(2)
);
const { assignment, runtimeAdapter, planningFragment, protocolPackage } = loadExperimentInputs({
  assignmentPath,
  runtimeAdapterPath,
  planningFragmentPath,
  protocolPackagePath
});

process.stdout.write(
  `${JSON.stringify(resolveRuntimeModel(assignment, runtimeAdapter, planningFragment, protocolPackage), null, 2)}\n`
);
