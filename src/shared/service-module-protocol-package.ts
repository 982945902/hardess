import { createHash } from "node:crypto";
import type { ServiceModuleProtocolPackage, ServiceModuleProtocolPackageRef } from "./admin-types.ts";

type ServiceModuleProtocolPackageDigestInput = Omit<ServiceModuleProtocolPackage, "digest">;

export function buildServiceModuleProtocolPackageId(protocol: string, version: string): string {
  return `${protocol}@${version}`;
}

export function normalizeServiceModuleProtocolPackage(
  input: ServiceModuleProtocolPackageDigestInput
): ServiceModuleProtocolPackageDigestInput {
  return {
    packageId: input.packageId,
    protocol: input.protocol,
    version: input.version,
    actions: [...input.actions].sort()
  };
}

export function computeServiceModuleProtocolPackageDigest(
  input: ServiceModuleProtocolPackageDigestInput
): string {
  const normalized = normalizeServiceModuleProtocolPackage(input);
  return `sha256:${createHash("sha256").update(JSON.stringify(normalized)).digest("hex")}`;
}

export function verifyServiceModuleProtocolPackageDigest(input: ServiceModuleProtocolPackage): void {
  const expectedPackageId = buildServiceModuleProtocolPackageId(input.protocol, input.version);
  if (input.packageId !== expectedPackageId) {
    throw new Error(
      `Service module protocol package id mismatch: expected ${expectedPackageId}, got ${input.packageId}`
    );
  }
  const expected = computeServiceModuleProtocolPackageDigest({
    packageId: input.packageId,
    protocol: input.protocol,
    version: input.version,
    actions: input.actions
  });
  if (input.digest !== expected) {
    throw new Error(
      `Service module protocol package digest mismatch: expected ${expected}, got ${input.digest}`
    );
  }
}

export function toServiceModuleProtocolPackageRef(
  input: Pick<ServiceModuleProtocolPackage, "packageId" | "digest">
): ServiceModuleProtocolPackageRef {
  return {
    packageId: input.packageId,
    digest: input.digest
  };
}
