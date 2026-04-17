import { createHash } from "node:crypto";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ArtifactManifest, Assignment } from "../../shared/index.ts";
import type { Logger } from "../observability/logger.ts";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface PreparedArtifactInputMetadata {
  kind: "worker" | "denoJson" | "denoLock";
  sourceRef: string;
  targetPath: string;
  fingerprint?: string;
}

interface PreparedArtifactMetadata {
  sourceUri: string;
  digest?: string;
  entry: string;
  denoJson?: string;
  denoLock?: string;
  inputs: PreparedArtifactInputMetadata[];
}

export interface ArtifactStoreOptions {
  rootDir: string;
  fetchFn?: FetchLike;
  logger?: Logger;
}

export class ArtifactStore {
  private readonly rootDir: string;
  private readonly fetchFn: FetchLike;
  private readonly logger?: Logger;

  constructor(options: ArtifactStoreOptions) {
    this.rootDir = resolve(options.rootDir);
    this.fetchFn = options.fetchFn ?? fetch;
    this.logger = options.logger;
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
    const denoJson = manifest?.packageManager.denoJson;
    const denoLock = manifest?.packageManager.denoLock;
    const artifactDir = join(this.rootDir, sanitizePathSegment(manifestId));
    const localEntry = join(artifactDir, entry);
    const metadataPath = join(artifactDir, ".artifact-meta.json");
    const localDenoJson = denoJson ? resolveLocalPackageFilePath(artifactDir, denoJson, "deno.json") : undefined;
    const localDenoLock = denoLock ? resolveLocalPackageFilePath(artifactDir, denoLock, "deno.lock") : undefined;
    const stagePlan = await this.buildStagePlan({
      sourceUri,
      digest,
      entry,
      localEntry,
      denoJson,
      localDenoJson,
      denoLock,
      localDenoLock
    });

    const currentMetadata = await readPreparedMetadata(metadataPath);
    if (await this.canReusePreparedArtifact(currentMetadata, stagePlan)) {
      return { localEntry };
    }

    for (const input of stagePlan.inputs) {
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
          denoJson,
          denoLock,
          inputs: stagePlan.inputs.map((input) => ({
            kind: input.kind,
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
    const denoJson = manifest?.packageManager.denoJson;
    const denoLock = manifest?.packageManager.denoLock;
    const artifactDir = join(this.rootDir, sanitizePathSegment(manifestId));
    const localEntry = join(artifactDir, entry);
    const metadataPath = join(artifactDir, ".artifact-meta.json");
    const localDenoJson = denoJson ? resolveLocalPackageFilePath(artifactDir, denoJson, "deno.json") : undefined;
    const localDenoLock = denoLock ? resolveLocalPackageFilePath(artifactDir, denoLock, "deno.lock") : undefined;
    const stagePlan = await this.buildStagePlan({
      sourceUri,
      digest,
      entry,
      localEntry,
      denoJson,
      localDenoJson,
      denoLock,
      localDenoLock
    });

    const currentMetadata = await readPreparedMetadata(metadataPath);
    if (await this.canReusePreparedArtifact(currentMetadata, stagePlan)) {
      return { localEntry };
    }

    for (const input of stagePlan.inputs) {
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
          denoJson,
          denoLock,
          inputs: stagePlan.inputs.map((input) => ({
            kind: input.kind,
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
    denoJson?: string;
    localDenoJson?: string;
    denoLock?: string;
    localDenoLock?: string;
  }): Promise<{
    sourceUri: string;
    digest?: string;
    entry: string;
    localEntry: string;
    denoJson?: string;
    denoLock?: string;
    inputs: Array<PreparedArtifactInputMetadata>;
  }> {
    const inputs: PreparedArtifactInputMetadata[] = [
      {
        kind: "worker",
        sourceRef: input.sourceUri,
        targetPath: input.localEntry,
        fingerprint: await computeSourceFingerprint(input.sourceUri)
      }
    ];

    if (input.denoJson && input.localDenoJson) {
      const sourceRef = resolveCompanionSourceRef(input.sourceUri, input.denoJson);
      inputs.push({
        kind: "denoJson",
        sourceRef,
        targetPath: input.localDenoJson,
        fingerprint: await computeSourceFingerprint(sourceRef)
      });
    }

    if (input.denoLock && input.localDenoLock) {
      const sourceRef = resolveCompanionSourceRef(input.sourceUri, input.denoLock);
      inputs.push({
        kind: "denoLock",
        sourceRef,
        targetPath: input.localDenoLock,
        fingerprint: await computeSourceFingerprint(sourceRef)
      });
    }

    return {
      sourceUri: input.sourceUri,
      digest: input.digest,
      entry: input.entry,
      localEntry: input.localEntry,
      denoJson: input.denoJson,
      denoLock: input.denoLock,
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
      denoJson?: string;
      denoLock?: string;
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
      currentMetadata.denoJson !== stagePlan.denoJson ||
      currentMetadata.denoLock !== stagePlan.denoLock ||
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function canReusePreparedInput(
  stagedInput: PreparedArtifactInputMetadata,
  cachedInput: PreparedArtifactInputMetadata,
  workerDigest?: string
): boolean {
  if (isRemoteSourceRef(stagedInput.sourceRef)) {
    return stagedInput.kind === "worker" && Boolean(workerDigest);
  }

  return stagedInput.fingerprint !== undefined && stagedInput.fingerprint === cachedInput.fingerprint;
}

async function computeSourceFingerprint(sourceRef: string): Promise<string | undefined> {
  if (isRemoteSourceRef(sourceRef)) {
    return undefined;
  }

  const sourceStat = sourceRef.startsWith("file://")
    ? await stat(new URL(sourceRef))
    : await stat(resolve(sourceRef));
  return `${sourceStat.size}:${sourceStat.mtimeMs}`;
}

function isRemoteSourceRef(sourceRef: string): boolean {
  return sourceRef.startsWith("http://") || sourceRef.startsWith("https://");
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function verifyDigest(source: string, digest?: string): void {
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
