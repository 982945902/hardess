import { createHash } from "node:crypto";
import type { ServiceModuleProtocolPackage } from "./admin-types.ts";

type ServiceModuleProtocolPackageDigestInput = Omit<ServiceModuleProtocolPackage, "digest">;

export function normalizeServiceModuleProtocolPackage(
  input: ServiceModuleProtocolPackageDigestInput
): ServiceModuleProtocolPackageDigestInput {
  return {
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
  const expected = computeServiceModuleProtocolPackageDigest({
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
