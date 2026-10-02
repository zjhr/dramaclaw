import { canvasEventBus } from "@/features/canvas/application/canvasServices";

const pendingOpen = new Set<string>();

/** 工具条点「角色」。节点若还是降级壳，事件会丢，挂载后用这里补开。 */
export function requestVideoIdentityPanel(nodeId: string) {
  pendingOpen.add(nodeId);
  canvasEventBus.publish("video-node/identity-call", { nodeId });
}

export function takePendingIdentityPanel(nodeId: string) {
  return pendingOpen.delete(nodeId);
}
