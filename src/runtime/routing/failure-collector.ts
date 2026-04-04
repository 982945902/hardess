import {
  ERROR_CODES,
  ROUTE_FAILURE_STAGES,
  type ConnRef,
  type ErrorCode,
  type SysRouteFailure,
  type SysResultPayload
} from "../../shared/index.ts";

export class DispatchFailureCollector {
  private readonly deliveredConns: ConnRef[] = [];
  private readonly failed: SysRouteFailure[] = [];

  constructor(private readonly resolvedPeers: string[]) {}

  recordDelivered(target: ConnRef): void {
    this.deliveredConns.push(target);
  }

  recordResolveFailure(peerId: string): void {
    this.failed.push({
      peerId,
      stage: ROUTE_FAILURE_STAGES.RESOLVE,
      code: ERROR_CODES.ROUTE_PEER_OFFLINE,
      message: `Peer ${peerId} is offline`,
      retryable: false
    });
  }

  recordAuthFailure(target: ConnRef, code: ErrorCode, message: string): void {
    this.failed.push({
      peerId: target.peerId,
      nodeId: target.nodeId,
      connId: target.connId,
      stage: ROUTE_FAILURE_STAGES.AUTH,
      code,
      message,
      retryable: false
    });
  }

  recordEgressFailure(
    target: ConnRef,
    code: ErrorCode,
    message: string,
    retryable = false
  ): void {
    this.failed.push({
      peerId: target.peerId,
      nodeId: target.nodeId,
      connId: target.connId,
      stage: ROUTE_FAILURE_STAGES.EGRESS,
      code,
      message,
      retryable
    });
  }

  build(refMsgId?: string): SysResultPayload {
    return {
      refMsgId,
      resolvedPeers: [...this.resolvedPeers],
      deliveredConns: [...this.deliveredConns],
      failed: [...this.failed],
      partialFailure: this.failed.length > 0
    };
  }

  hasDeliveries(): boolean {
    return this.deliveredConns.length > 0;
  }
}
