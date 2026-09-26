import { describe, expect, it } from "vitest";
import { videoReferenceConnectionRejection } from "@/features/canvas/domain/videoReferenceLimits";
import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import type { CanvasNode } from "@/features/canvas/domain/canvasNodes";

// 溯源边不受视频参考素材上限约束：深度视频/重拍派生的入边标示「产物从哪来」，
// 不是喂给模型的参考素材。agnes 系模型 referenceVideoMax=0，照表算会把边静默拒掉。
function videoNode(id: string, data: Record<string, unknown>): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.video,
    position: { x: 0, y: 0 },
    data: { videoUrl: null, ...data },
  } as CanvasNode;
}

// 模拟 referenceVideoMax=0 的模型目录（如 agnes-video-2.5-flash）。
const zeroVideoEnvelope = () => ({ image: 5, video: 0, audio: 0, total: 5 });

describe("greybox 溯源边", () => {
  it("模型 referenceVideoMax=0 时，深度视频节点的溯源边仍放行", () => {
    const source = videoNode("src", { videoUrl: "http://x/a.mp4" });
    const greybox = videoNode("gb", { isGreyboxNode: true, model: "agnes-video-2.5-flash" });
    const normal = videoNode("nm", { model: "agnes-video-2.5-flash" });
    expect(
      videoReferenceConnectionRejection([source, greybox], [], { source: "src", target: "gb" }, zeroVideoEnvelope),
    ).toBeNull();
    // 普通视频节点仍然被拒（上限语义不能破）
    expect(
      videoReferenceConnectionRejection([source, normal], [], { source: "src", target: "nm" }, zeroVideoEnvelope),
    ).not.toBeNull();
  });

  // 重拍派生节点的入边同样是溯源边（前段/后段从哪来），不是喂模型的参考素材。
  it("重拍派生节点（isReshootNode）同样免上限", () => {
    const source = videoNode("src", { videoUrl: "http://x/a.mp4" });
    const reshoot = videoNode("rs", { isReshootNode: true, model: "agnes-video-2.5-flash" });
    const normal = videoNode("nm", { model: "agnes-video-2.5-flash" });
    expect(
      videoReferenceConnectionRejection([source, reshoot], [], { source: "src", target: "rs" }, zeroVideoEnvelope),
    ).toBeNull();
    // 放行只对派生节点生效，普通视频节点仍按上限拒。
    expect(
      videoReferenceConnectionRejection([source, normal], [], { source: "src", target: "nm" }, zeroVideoEnvelope),
    ).not.toBeNull();
  });
});
