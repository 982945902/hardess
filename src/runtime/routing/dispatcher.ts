import type { AckMode, DeliveryPlan, PeerLocator } from "../../shared/types.ts";

export class Dispatcher {
  constructor(private readonly peerLocator: PeerLocator) {}

  async buildPlan(
    peerIds: string[],
    options: {
      streamId?: string;
      ack?: AckMode;
    } = {}
  ): Promise<DeliveryPlan> {
    const uniquePeerIds = Array.from(new Set(peerIds));
    const located = await this.peerLocator.findMany(uniquePeerIds);
    const targets = uniquePeerIds.flatMap((peerId) => located.get(peerId) ?? []);

    return {
      targets,
      streamId: options.streamId,
      ack: options.ack ?? "recv"
    };
  }

  invalidate(peerIds: string[]): void {
    for (const peerId of new Set(peerIds)) {
      this.peerLocator.invalidate?.(peerId);
    }
  }
}
