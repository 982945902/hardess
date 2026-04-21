import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";

const bindingValueSchema: z.ZodType<unknown> = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown())
]);

const bridgeManifestSchema = z.object({
  assignmentId: z.string().min(1),
  deploymentKind: z.literal("http_worker"),
  workerd: z.object({
    listenAddress: z.string().min(1),
    compatibilityDate: z.string().min(1),
    compatibilityFlags: z.array(z.string()).default([])
  }),
  httpWorker: z.object({
    name: z.string().min(1),
    entry: z.string().min(1),
    deployment: z.object({
      bindings: z.record(z.string(), bindingValueSchema).default({})
    }).default({})
  })
});

type BridgeManifest = z.infer<typeof bridgeManifestSchema>;

const rootDir = resolve(import.meta.dir);
const manifestPath = resolve(rootDir, "bridge-manifest.json");
const outputPath = resolve(rootDir, ".generated.config.capnp");

function renderCapnpString(value: string): string {
  return JSON.stringify(value);
}

function renderBinding(name: string, value: unknown): string {
  if (typeof value === "string") {
    return `    (name = ${renderCapnpString(name)}, text = ${renderCapnpString(value)}),`;
  }

  return `    (name = ${renderCapnpString(name)}, json = ${renderCapnpString(JSON.stringify(value))}),`;
}

function renderBindings(manifest: BridgeManifest): string {
  const bindings = Object.entries(manifest.httpWorker.deployment.bindings);
  if (bindings.length === 0) {
    return "  bindings = [],";
  }

  return ["  bindings = [", ...bindings.map(([name, value]) => renderBinding(name, value)), "  ],"].join("\n");
}

function renderCompatibilityFlags(flags: string[]): string {
  if (flags.length === 0) {
    return "";
  }

  return `  compatibilityFlags = [${flags.map((flag) => renderCapnpString(flag)).join(", ")}],\n`;
}

function renderConfig(manifest: BridgeManifest): string {
  return `using Workerd = import "/workerd/workerd.capnp";

# Generated from bridge-manifest.json.
# This is a minimal Hardess-flavored bridge into workerd config.

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .demoWorker),
  ],

  sockets = [
    (name = "http", address = ${renderCapnpString(manifest.workerd.listenAddress)}, http = (), service = "main"),
  ]
);

const demoWorker :Workerd.Worker = (
  modules = [
    (name = "worker", esModule = embed ${renderCapnpString(manifest.httpWorker.entry)}),
  ],

${renderBindings(manifest)}

  compatibilityDate = ${renderCapnpString(manifest.workerd.compatibilityDate)},
${renderCompatibilityFlags(manifest.workerd.compatibilityFlags)});`;
}

const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
const manifest = bridgeManifestSchema.parse(raw);
const config = renderConfig(manifest);

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, config, "utf8");

process.stdout.write(`${outputPath}\n`);
