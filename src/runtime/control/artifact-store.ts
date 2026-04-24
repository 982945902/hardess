import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ArtifactManifest, ArtifactPackageManager, Assignment } from "../../shared/index.ts";
import type { Logger } from "../observability/logger.ts";
import { NoopMetrics, type Metrics } from "../observability/metrics.ts";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type PrepareRunner = (command: string, args: string[], options: { cwd: string }) => Promise<void>;

interface PreparedArtifactInputMetadata {
  kind: "worker" | "workerDirectory" | "workerArchive" | "projectFile";
  logicalName?: string;
  sourceRef: string;
  targetPath: string;
  fingerprint?: string;
}

interface PreparedArtifactMetadata {
  sourceUri: string;
  digest?: string;
  entry: string;
  packageManager: ArtifactPackageManager;
  inputs: PreparedArtifactInputMetadata[];
}

export interface ArtifactStoreOptions {
  rootDir: string;
  fetchFn?: FetchLike;
  prepareRunner?: PrepareRunner;
  logger?: Logger;
  metrics?: Metrics;
}

export class ArtifactStore {
  private readonly rootDir: string;
  private readonly fetchFn: FetchLike;
  private readonly prepareRunner: PrepareRunner;
  private readonly logger?: Logger;
  private readonly metrics: Metrics;

  constructor(options: ArtifactStoreOptions) {
    this.rootDir = resolve(options.rootDir);
    this.fetchFn = options.fetchFn ?? fetch;
    this.prepareRunner = options.prepareRunner ?? defaultPrepareRunner;
    this.logger = options.logger;
    this.metrics = options.metrics ?? new NoopMetrics();
  }

  async stageHttpWorker(
    assignment: Assignment,
    manifest?: ArtifactManifest
  ): Promise<{
    localEntry: string;
  }> {
    const entry = manifest?.entry ?? assignment.httpWorker?.entry;
    if (!entry) {
      throw new Error(`Missing http worker entry for assignment ${assignment.assignmentId}`);
    }

    const manifestId = manifest?.manifestId ?? assignment.artifact.manifestId;
    const sourceUri = manifest?.source.uri ?? assignment.artifact.sourceUri;
    const digest = manifest?.source.digest ?? assignment.artifact.digest;
    const packageManager = manifest?.packageManager ?? { kind: "bun" as const };
    const artifactDir = join(this.rootDir, sanitizePathSegment(manifestId));
    const localEntry = join(artifactDir, entry);
    const metadataPath = join(artifactDir, ".artifact-meta.json");
    const stagePlan = await this.buildStagePlan({
      sourceUri,
      digest,
      entry,
      localEntry,
      packageManager,
      artifactDir
    });

    const currentMetadata = await readPreparedMetadata(metadataPath);
    if (await this.canReusePreparedArtifact(currentMetadata, stagePlan)) {
      await this.ensureProjectPrepared(stagePlan);
      return { localEntry };
    }

    for (const input of stagePlan.inputs) {
      if (input.kind === "workerDirectory") {
        await rm(input.targetPath, { recursive: true, force: true });
        await cp(resolveLocalSourcePath(input.sourceRef), input.targetPath, { recursive: true });
        continue;
      }
      if (input.kind === "workerArchive") {
        await this.extractArchiveSource(input.sourceRef, input.targetPath, digest);
        continue;
      }
      const source = await this.readSource(input.sourceRef);
      if (input.kind === "worker") {
        verifyDigest(source, digest);
      }
      await mkdir(dirname(input.targetPath), { recursive: true });
      await writeFile(input.targetPath, source, "utf8");
    }

    await writeFile(
      metadataPath,
      JSON.stringify(
        {
          sourceUri,
          digest,
          entry,
          packageManager,
          inputs: stagePlan.inputs.map((input) => ({
            kind: input.kind,
            logicalName: input.logicalName,
            sourceRef: input.sourceRef,
            targetPath: input.targetPath,
            fingerprint: input.fingerprint
          }))
        } satisfies PreparedArtifactMetadata,
        null,
        2
      ),
      "utf8"
    );

    await this.ensureProjectPrepared(stagePlan);

    this.logger?.info("artifact staged", {
      manifestId,
      sourceUri,
      localEntry
    });

    return { localEntry };
  }

  async stageServiceModule(
    assignment: Assignment,
    manifest?: ArtifactManifest
  ): Promise<{
    localEntry: string;
  }> {
    const entry = manifest?.entry ?? assignment.serviceModule?.entry;
    if (!entry) {
      throw new Error(`Missing service module entry for assignment ${assignment.assignmentId}`);
    }

    const manifestId = manifest?.manifestId ?? assignment.artifact.manifestId;
    const sourceUri = manifest?.source.uri ?? assignment.artifact.sourceUri;
    const digest = manifest?.source.digest ?? assignment.artifact.digest;
    const packageManager = manifest?.packageManager ?? { kind: "bun" as const };
    const artifactDir = join(this.rootDir, sanitizePathSegment(manifestId));
    const localEntry = join(artifactDir, entry);
    const metadataPath = join(artifactDir, ".artifact-meta.json");
    const stagePlan = await this.buildStagePlan({
      sourceUri,
      digest,
      entry,
      localEntry,
      packageManager,
      artifactDir
    });

    const currentMetadata = await readPreparedMetadata(metadataPath);
    if (await this.canReusePreparedArtifact(currentMetadata, stagePlan)) {
      await this.ensureProjectPrepared(stagePlan);
      return { localEntry };
    }

    for (const input of stagePlan.inputs) {
      if (input.kind === "workerDirectory") {
        await rm(input.targetPath, { recursive: true, force: true });
        await cp(resolveLocalSourcePath(input.sourceRef), input.targetPath, { recursive: true });
        continue;
      }
      if (input.kind === "workerArchive") {
        await this.extractArchiveSource(input.sourceRef, input.targetPath, digest);
        continue;
      }
      const source = await this.readSource(input.sourceRef);
      if (input.kind === "worker") {
        verifyDigest(source, digest);
      }
      await mkdir(dirname(input.targetPath), { recursive: true });
      await writeFile(input.targetPath, source, "utf8");
    }

    await writeFile(
      metadataPath,
      JSON.stringify(
        {
          sourceUri,
          digest,
          entry,
          packageManager,
          inputs: stagePlan.inputs.map((input) => ({
            kind: input.kind,
            logicalName: input.logicalName,
            sourceRef: input.sourceRef,
            targetPath: input.targetPath,
            fingerprint: input.fingerprint
          }))
        } satisfies PreparedArtifactMetadata,
        null,
        2
      ),
      "utf8"
    );

    await this.ensureProjectPrepared(stagePlan);

    this.logger?.info("artifact staged", {
      manifestId,
      sourceUri,
      localEntry
    });

    return { localEntry };
  }

  private async buildStagePlan(input: {
    sourceUri: string;
    digest?: string;
    entry: string;
    localEntry: string;
    packageManager: ArtifactPackageManager;
    artifactDir: string;
  }): Promise<{
    sourceUri: string;
    digest?: string;
    entry: string;
    localEntry: string;
    artifactDir: string;
    packageManager: ArtifactPackageManager;
    inputs: Array<PreparedArtifactInputMetadata>;
  }> {
    const sourceIsDirectory = await isDirectorySourceRef(input.sourceUri);
    const sourceIsArchive = isArchiveSourceRef(input.sourceUri);
    const inputs: PreparedArtifactInputMetadata[] = sourceIsArchive
      ? [
          {
            kind: "workerArchive",
            sourceRef: input.sourceUri,
            targetPath: input.artifactDir,
            fingerprint: await computeSourceFingerprint(input.sourceUri)
          }
        ]
      : sourceIsDirectory
      ? [
          {
            kind: "workerDirectory",
            sourceRef: input.sourceUri,
            targetPath: input.artifactDir,
            fingerprint: await computeSourceFingerprint(input.sourceUri)
          }
        ]
      : [
          {
            kind: "worker",
            sourceRef: input.sourceUri,
            targetPath: input.localEntry,
            fingerprint: await computeSourceFingerprint(input.sourceUri)
          }
        ];

    if (!sourceIsDirectory && !sourceIsArchive) {
      for (const projectFile of listProjectFiles(input.packageManager, input.artifactDir, input.sourceUri)) {
        inputs.push({
          kind: "projectFile",
          logicalName: projectFile.logicalName,
          sourceRef: projectFile.sourceRef,
          targetPath: projectFile.targetPath,
          fingerprint: await computeSourceFingerprint(projectFile.sourceRef)
        });
      }
    }

    return {
      sourceUri: input.sourceUri,
      digest: input.digest,
      entry: input.entry,
      localEntry: input.localEntry,
      artifactDir: input.artifactDir,
      packageManager: input.packageManager,
      inputs
    };
  }

  private async canReusePreparedArtifact(
    currentMetadata: PreparedArtifactMetadata | null,
    stagePlan: {
      sourceUri: string;
      digest?: string;
      entry: string;
      localEntry: string;
      artifactDir: string;
      packageManager: ArtifactPackageManager;
      inputs: Array<PreparedArtifactInputMetadata>;
    }
  ): Promise<boolean> {
    if (!currentMetadata) {
      return false;
    }

    if (
      currentMetadata.sourceUri !== stagePlan.sourceUri ||
      currentMetadata.digest !== stagePlan.digest ||
      currentMetadata.entry !== stagePlan.entry
    ) {
      return false;
    }

    if (
      !samePackageManager(currentMetadata.packageManager, stagePlan.packageManager) ||
      currentMetadata.inputs.length !== stagePlan.inputs.length
    ) {
      return false;
    }

    for (let index = 0; index < stagePlan.inputs.length; index += 1) {
      const stagedInput = stagePlan.inputs[index];
      const cachedInput = currentMetadata.inputs[index];
      if (!cachedInput) {
        return false;
      }
      if (
        cachedInput.kind !== stagedInput.kind ||
        cachedInput.logicalName !== stagedInput.logicalName ||
        cachedInput.sourceRef !== stagedInput.sourceRef ||
        cachedInput.targetPath !== stagedInput.targetPath
      ) {
        return false;
      }
      if (!(await pathExists(stagedInput.targetPath))) {
        return false;
      }
      if (!canReusePreparedInput(stagedInput, cachedInput, stagePlan.digest)) {
        return false;
      }
    }

    return true;
  }

  private async ensureProjectPrepared(stagePlan: {
    sourceUri: string;
    digest?: string;
    entry: string;
    localEntry: string;
    artifactDir: string;
    packageManager: ArtifactPackageManager;
    inputs: Array<PreparedArtifactInputMetadata>;
  }): Promise<void> {
    if (stagePlan.packageManager.kind !== "bun" || !stagePlan.packageManager.packageJson) {
      return;
    }

    const prepareKey = createProjectPrepareKey(stagePlan.packageManager, stagePlan.inputs);
    const prepareMetadataPath = join(stagePlan.artifactDir, ".artifact-prepare-meta.json");
    const currentPrepared = await readPreparedProjectState(prepareMetadataPath);
    if (currentPrepared?.key === prepareKey) {
      this.metrics.increment("artifact.prepare_cache_hit");
      return;
    }
    this.metrics.increment("artifact.prepare_cache_miss");

    const args = [
      "install",
      "--cwd",
      stagePlan.artifactDir,
      "--silent",
      "--no-progress",
      "--no-summary",
      "--ignore-scripts"
    ];
    if (stagePlan.packageManager.frozenLock) {
      args.push("--frozen-lockfile");
    }

    const startedAt = Date.now();
    try {
      await this.prepareRunner("bun", args, {
        cwd: stagePlan.artifactDir
      });

      await writeFile(
        prepareMetadataPath,
        JSON.stringify(
          {
            key: prepareKey,
            packageManagerKind: "bun",
            preparedAt: Date.now()
          },
          null,
          2
        ),
        "utf8"
      );

      this.metrics.increment("artifact.prepare_ok");
      this.metrics.timing("artifact.prepare_ms", Date.now() - startedAt);

      this.logger?.info("artifact project prepared", {
        packageManager: "bun",
        artifactDir: stagePlan.artifactDir,
        entry: stagePlan.localEntry
      });
    } catch (error) {
      this.metrics.increment("artifact.prepare_error");
      this.metrics.timing("artifact.prepare_ms", Date.now() - startedAt);
      this.logger?.warn("artifact project prepare failed", {
        packageManager: "bun",
        artifactDir: stagePlan.artifactDir,
        entry: stagePlan.localEntry,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  private async readSource(sourceUri: string): Promise<string> {
    if (sourceUri.startsWith("http://") || sourceUri.startsWith("https://")) {
      const response = await this.fetchFn(sourceUri);
      if (!response.ok) {
        throw new Error(
          `Artifact fetch failed: ${response.status} ${response.statusText}`.trim()
        );
      }
      return await response.text();
    }

    if (sourceUri.startsWith("file://")) {
      return await readFile(new URL(sourceUri), "utf8");
    }

    return await readFile(resolve(sourceUri), "utf8");
  }

  private async readSourceBytes(sourceUri: string): Promise<Buffer> {
    if (sourceUri.startsWith("http://") || sourceUri.startsWith("https://")) {
      const response = await this.fetchFn(sourceUri);
      if (!response.ok) {
        throw new Error(
          `Artifact fetch failed: ${response.status} ${response.statusText}`.trim()
        );
      }
      return Buffer.from(await response.arrayBuffer());
    }

    if (sourceUri.startsWith("file://")) {
      return await readFile(new URL(sourceUri));
    }

    return await readFile(resolve(sourceUri));
  }

  private async extractArchiveSource(sourceUri: string, artifactDir: string, digest?: string): Promise<void> {
    const archive = await this.readSourceBytes(sourceUri);
    verifyDigest(archive, digest);
    await rm(artifactDir, { recursive: true, force: true });
    await mkdir(artifactDir, { recursive: true });
    const archivePath = join(artifactDir, ".artifact-source.tgz");
    await writeFile(archivePath, archive);
    await this.prepareRunner("tar", ["-xzf", archivePath, "-C", artifactDir], {
      cwd: artifactDir
    });
    await rm(archivePath, { force: true });
  }
}

function listProjectFiles(
  packageManager: ArtifactPackageManager,
  artifactDir: string,
  workerSourceUri: string
): Array<{
  logicalName: string;
  sourceRef: string;
  targetPath: string;
}> {
  if (packageManager.kind === "deno") {
    return [
      buildProjectFile("denoJson", packageManager.denoJson, artifactDir, workerSourceUri, "deno.json"),
      buildProjectFile("denoLock", packageManager.denoLock, artifactDir, workerSourceUri, "deno.lock")
    ].filter((value): value is NonNullable<typeof value> => value !== undefined);
  }

  return [
    buildProjectFile("packageJson", packageManager.packageJson, artifactDir, workerSourceUri, "package.json"),
    buildProjectFile("bunfigToml", packageManager.bunfigToml, artifactDir, workerSourceUri, "bunfig.toml"),
    buildProjectFile("bunLock", packageManager.bunLock, artifactDir, workerSourceUri, "bun.lock")
  ].filter((value): value is NonNullable<typeof value> => value !== undefined);
}

function buildProjectFile(
  logicalName: string,
  fileRef: string | undefined,
  artifactDir: string,
  workerSourceUri: string,
  fallbackName: string
):
  | {
      logicalName: string;
      sourceRef: string;
      targetPath: string;
    }
  | undefined {
  if (!fileRef) {
    return undefined;
  }

  return {
    logicalName,
    sourceRef: resolveCompanionSourceRef(workerSourceUri, fileRef),
    targetPath: resolveLocalPackageFilePath(artifactDir, fileRef, fallbackName)
  };
}

function resolveLocalPackageFilePath(
  artifactDir: string,
  packageFileRef: string,
  fallbackName: string
): string {
  if (
    packageFileRef.startsWith("http://") ||
    packageFileRef.startsWith("https://") ||
    packageFileRef.startsWith("file://")
  ) {
    return join(artifactDir, fallbackName);
  }

  if (isAbsoluteFileSystemPath(packageFileRef)) {
    return join(artifactDir, fallbackName);
  }

  return join(artifactDir, packageFileRef);
}

function resolveCompanionSourceRef(workerSourceUri: string, packageFileRef: string): string {
  if (
    packageFileRef.startsWith("http://") ||
    packageFileRef.startsWith("https://") ||
    packageFileRef.startsWith("file://")
  ) {
    return packageFileRef;
  }

  if (workerSourceUri.startsWith("http://") || workerSourceUri.startsWith("https://")) {
    return new URL(packageFileRef, workerSourceUri).href;
  }

  if (workerSourceUri.startsWith("file://")) {
    return new URL(packageFileRef, workerSourceUri).href;
  }

  return resolve(dirname(workerSourceUri), packageFileRef);
}

function isAbsoluteFileSystemPath(path: string): boolean {
  if (path.startsWith("/")) {
    return true;
  }

  return /^[A-Za-z]:[\\/]/.test(path);
}

async function readPreparedMetadata(path: string): Promise<PreparedArtifactMetadata | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as PreparedArtifactMetadata;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function readPreparedProjectState(path: string): Promise<{
  key: string;
  packageManagerKind: "bun";
  preparedAt: number;
} | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as {
      key?: string;
      packageManagerKind?: "bun";
      preparedAt?: number;
    };
    if (typeof parsed?.key !== "string" || parsed.packageManagerKind !== "bun") {
      return null;
    }
    return {
      key: parsed.key,
      packageManagerKind: "bun",
      preparedAt: typeof parsed.preparedAt === "number" ? parsed.preparedAt : 0
    };
  } catch {
    return null;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function samePackageManager(left: ArtifactPackageManager, right: ArtifactPackageManager): boolean {
  if (left.kind !== right.kind || left.frozenLock !== right.frozenLock) {
    return false;
  }

  if (left.kind === "deno" && right.kind === "deno") {
    return left.denoJson === right.denoJson && left.denoLock === right.denoLock;
  }

  if (left.kind === "bun" && right.kind === "bun") {
    return (
      left.packageJson === right.packageJson &&
      left.bunfigToml === right.bunfigToml &&
      left.bunLock === right.bunLock
    );
  }

  return false;
}

function createProjectPrepareKey(
  packageManager: ArtifactPackageManager,
  inputs: PreparedArtifactInputMetadata[]
): string {
  return JSON.stringify({
    packageManager,
    projectInputs: inputs
      .filter((input) => input.kind === "projectFile")
      .map((input) => ({
        logicalName: input.logicalName,
        sourceRef: input.sourceRef,
        targetPath: input.targetPath,
        fingerprint: input.fingerprint
      }))
  });
}

function canReusePreparedInput(
  stagedInput: PreparedArtifactInputMetadata,
  cachedInput: PreparedArtifactInputMetadata,
  workerDigest?: string
): boolean {
  if (isRemoteSourceRef(stagedInput.sourceRef)) {
    return (stagedInput.kind === "worker" && Boolean(workerDigest)) || stagedInput.kind === "workerArchive";
  }

  return stagedInput.fingerprint !== undefined && stagedInput.fingerprint === cachedInput.fingerprint;
}

async function computeSourceFingerprint(sourceRef: string): Promise<string | undefined> {
  if (isRemoteSourceRef(sourceRef)) {
    return undefined;
  }

  if (isArchiveSourceRef(sourceRef)) {
    const source = await readFile(resolveLocalSourcePath(sourceRef));
    return createHash("sha256").update(source).digest("hex");
  }

  const sourceStat = await stat(resolveLocalSourcePath(sourceRef));
  return `${sourceStat.size}:${sourceStat.mtimeMs}`;
}

function isRemoteSourceRef(sourceRef: string): boolean {
  return sourceRef.startsWith("http://") || sourceRef.startsWith("https://");
}

function isArchiveSourceRef(sourceRef: string): boolean {
  const pathname = sourceRef.startsWith("http://") || sourceRef.startsWith("https://") || sourceRef.startsWith("file://")
    ? new URL(sourceRef).pathname
    : sourceRef;
  return pathname.endsWith(".tgz") || pathname.endsWith(".tar.gz");
}

async function isDirectorySourceRef(sourceRef: string): Promise<boolean> {
  if (isRemoteSourceRef(sourceRef)) {
    return false;
  }
  try {
    return (await stat(resolveLocalSourcePath(sourceRef))).isDirectory();
  } catch {
    return false;
  }
}

function resolveLocalSourcePath(sourceRef: string): string {
  return sourceRef.startsWith("file://")
    ? fileURLToPath(sourceRef)
    : resolve(sourceRef);
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function verifyDigest(source: string | Uint8Array, digest?: string): void {
  if (!digest) {
    return;
  }

  const [algorithm, expected] = digest.includes(":") ? digest.split(":", 2) : ["sha256", digest];
  if (!expected) {
    throw new Error(`Invalid artifact digest format: ${digest}`);
  }
  if (algorithm !== "sha256" && algorithm !== "sha512") {
    throw new Error(`Unsupported artifact digest algorithm: ${algorithm}`);
  }

  const actual = createHash(algorithm).update(source).digest("hex");
  if (actual !== expected) {
    throw new Error(`Artifact digest mismatch for ${algorithm}`);
  }
}

async function defaultPrepareRunner(
  command: string,
  args: string[],
  options: { cwd: string }
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      rejectPromise(error);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      rejectPromise(
        new Error(
          `Prepare command failed (${command} ${args.join(" ")}): ${stderr.trim() || `exit code ${code}`}`
        )
      );
    });
  });
}
