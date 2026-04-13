import { ERROR_CODES, HardessError, type AuthContext } from "../../shared/index.ts";

export function requireCapabilities(
  auth: Pick<AuthContext, "peerId" | "capabilities">,
  requiredCapabilities: string[],
  actionLabel: string
): void {
  const missingCapabilities = requiredCapabilities.filter(
    (capability) => !auth.capabilities.includes(capability)
  );

  if (missingCapabilities.length === 0) {
    return;
  }

  throw new HardessError(
    ERROR_CODES.ACL_DENIED,
    `ACL denied for ${actionLabel}`,
    {
      detail: {
        peerId: auth.peerId,
        requiredCapabilities,
        missingCapabilities
      }
    }
  );
}
