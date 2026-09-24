// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ShotRecipePanel } from "@/features/canvas/ui/ShotRecipePanel";
import { apiCall } from "@/api/client";

import { useCanvasStore } from "@/stores/canvasStore";

/** 受控输入必须走 fireEvent.change，直接改 value 不会触发 React 的 onChange。 */
function fillInput(element: HTMLElement, value: string): void {
  fireEvent.change(element, { target: { value } });
}

/**
 * 渲染产物回写：面板走 useCanvasStore.getState()（drawer 之外的全局 store），
 * 所以测试里直接给真实 store 铺一条画布状态，并 spy 掉 addEdge 观察调用。
 *
 * jsdom 里跑真 store 而不是 mock：回写路径的核心事实正是「addEdge 对 video→video
 * 静默返回 null」，只有真 store 才会真的走白名单把它算出来。
 */
function seedCanvas(nodeIds: string[]) {
  useCanvasStore.setState({
    nodes: nodeIds.map((id) => ({
      id,
      type: "video",
      position: { x: 0, y: 0 },
      data: {},
    })) as never,
    edges: [] as never,
    // 回写路径要观察的其实是 updateNodeData（产物写进版本绑定的那个节点）。
    // 用真 store 的真实现，断言落在节点 data 上，比 spy 更接近产品行为。
  });
  return { nodes: () => useCanvasStore.getState().nodes };
}

// i18n 在测试里用真实词条太重，mock 成 key 回显 + 插值拼接即可（断言 key 与参数）。
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts
        ? `${key}(${Object.entries(opts)
            .map(([name, value]) => `${name}=${String(value)}`)
            .join(",")})`
        : key,
  }),
}));

// apiCall 走 ky + 相对 URL，测试里没有 baseURL 可解析；按仓库既有范式换成 spy。
vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, apiCall: vi.fn() };
});

const RECIPE_HEADER = {
  recipe_id: "recipe_abc",
  title: "第 3 场 夜巷",
  canvas_id: "default",
  node_id: "n1",
  recorded_at: "2026-09-24T00:00:00Z",
};

/** v2 有一条真实报价；v1/v3 没有报价（quoted=false），v3 能力目录也读不到。 */
const RECIPE_VERSIONS = [
  {
    version_id: "v1",
    parent_version_id: null,
    status: "completed",
    prompt_delta: { mode: "full", prompt: "wide establishing shot" },
    model_snapshot: {
      model_id: "seedance-2",
      capabilities_known: true,
      minDuration: 4,
      maxDuration: 12,
      supportedModes: ["text2video"],
      referenceImageMax: 3,
    },
    cost_ledger: {
      quoted: false,
      reason: "video backend unavailable",
      quantity: 8,
    },
    recorded_at: "2026-09-24T00:01:00Z",
    lineage: ["v1"],
  },
  {
    version_id: "v2",
    parent_version_id: "v1",
    status: "completed",
    prompt_delta: { mode: "delta", prompt: "add rain", changes: { weather: "rain" } },
    model_snapshot: {
      model_id: "seedance-2",
      capabilities_known: true,
      minDuration: 4,
      maxDuration: 12,
      supportedModes: ["text2video"],
      referenceImageMax: 3,
    },
    cost_ledger: {
      quoted: true,
      quantity: 8,
      total_cost: 42,
      display: "42 credits",
      unit: "call",
    },
    recorded_at: "2026-09-24T00:02:00Z",
    lineage: ["v1", "v2"],
  },
  {
    version_id: "v3",
    parent_version_id: "v2",
    status: "failed",
    prompt_delta: { mode: "delta", prompt: "add rain harder", changes: { weather: "storm" } },
    model_snapshot: {
      model_id: "seedance-2",
      capabilities_known: false,
      frozen_at: "2026-09-24T00:03:00Z",
    },
    cost_ledger: { quoted: false, reason: "credit quote unavailable: PortNotRegistered" },
    recorded_at: "2026-09-24T00:04:00Z",
    lineage: ["v1", "v2", "v3"],
  },
];

function mockApi() {
  seedCanvas(["n1"]);
  const call = vi.mocked(apiCall).mockReset();
  call.mockImplementation(async (path: string) => {
    if (path.endsWith("/shot-recipes")) {
      return [RECIPE_HEADER] as never;
    }
    if (path.includes("/shot-recipes/")) {
      return {
        recipe: RECIPE_HEADER,
        versions: RECIPE_VERSIONS,
        look_decisions: [
          {
            decision_id: "look_1",
            identity_id: "id_lin",
            character_name: "林雪",
            version_id: "v2",
            identity_known: true,
            identity_snapshot: { identity_id: "id_lin", identity_known: true },
            overrides: { costume_image: "/static/x.png" },
            recorded_at: "2026-09-24T00:02:30Z",
          },
        ],
      } as never;
    }
    throw new Error(`unexpected path: ${path}`);
  });
  return call;
}

function setup() {
  const onClose = vi.fn();
  const view = render(
    <ShotRecipePanel project="proj-1" nodeId="n1" onClose={onClose} />,
  );
  return { onClose, unmount: view.unmount };
}

/** 渲染可提交的版本：ready + 有 job 之外的产物位 + 能力目录已知。 */
const RENDERABLE_VERSION = {
  version_id: "v4",
  parent_version_id: "v3",
  status: "ready",
  prompt_delta: { mode: "delta", prompt: "steady the camera" },
  model_snapshot: {
    model_id: "seedance-2",
    capabilities_known: true,
    minDuration: 4,
    maxDuration: 12,
    supportedModes: ["text2video"],
    referenceImageMax: 3,
  },
  cost_ledger: { quoted: false, reason: "credit quote unavailable" },
  duration_seconds: 8,
  source_refs: { canvas_id: "default", node_id: "n1" },
  recorded_at: "2026-09-24T00:05:00Z",
  lineage: ["v1", "v2", "v3", "v4"],
};

/** 已经渲染完成的版本：terminal + 产物 url。 */
const COMPLETED_VERSION = {
  ...RENDERABLE_VERSION,
  version_id: "v5",
  parent_version_id: "v4",
  status: "completed",
  source_refs: {
    canvas_id: "default",
    node_id: "n1",
    job_id: "job_v5",
    artifact_url: "/static/freezone/v5.mp4",
  },
  recorded_at: "2026-09-24T00:06:00Z",
  lineage: ["v1", "v2", "v3", "v4", "v5"],
};

/** 渲染失败的版本：终态 failed + 后端原话。 */
const FAILED_VERSION = {
  ...RENDERABLE_VERSION,
  version_id: "v6",
  parent_version_id: "v5",
  status: "failed",
  source_refs: {
    canvas_id: "default",
    node_id: "n1",
    job_id: "job_v6",
    error: "backend returned 502",
  },
  recorded_at: "2026-09-24T00:07:00Z",
  lineage: ["v1", "v2", "v3", "v4", "v5", "v6"],
};

describe("ShotRecipePanel", () => {
  it("lists recipes and renders every version of the selected one", async () => {
    mockApi();
    setup();

    expect(await screen.findByTestId("shot-recipe-item-recipe_abc")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId("shot-recipe-version-v3")).toBeTruthy(),
    );
    expect(screen.getByTestId("shot-recipe-version-v1")).toBeTruthy();
    expect(screen.getByTestId("shot-recipe-version-v2")).toBeTruthy();
    expect(screen.getByText("node.shotRecipe.title")).toBeTruthy();
    expect(screen.getByText("node.shotRecipe.versionChain")).toBeTruthy();
  });

  it("shows the parent link of each version and marks the first one as root", async () => {
    mockApi();
    setup();

    await waitFor(() =>
      expect(screen.getByTestId("shot-recipe-parent-v3")).toBeTruthy(),
    );
    // v3 ← v2 ← v1 的父指针必须逐条可见，首版显示为根。
    expect(screen.getByTestId("shot-recipe-parent-v3").textContent).toBe(
      "node.shotRecipe.parent(value=v2)",
    );
    expect(screen.getByTestId("shot-recipe-parent-v2").textContent).toBe(
      "node.shotRecipe.parent(value=v1)",
    );
    expect(screen.getByTestId("shot-recipe-parent-v1").textContent).toBe(
      "node.shotRecipe.root",
    );
  });

  it("renders its own status and prompt delta per version", async () => {
    mockApi();
    setup();

    await waitFor(() =>
      expect(screen.getByTestId("shot-recipe-version-v3")).toBeTruthy(),
    );
    expect(screen.getByTestId("shot-recipe-version-v1").textContent).toContain(
      "node.shotRecipe.promptDeltaMode(mode=full)",
    );
    expect(screen.getByTestId("shot-recipe-version-v2").textContent).toContain(
      "node.shotRecipe.promptDeltaMode(mode=delta)",
    );
    expect(screen.getByTestId("shot-recipe-version-v3").textContent).toContain("failed");
  });

  it("says the quote is unavailable instead of rendering a price when quoted=false", async () => {
    mockApi();
    setup();

    await waitFor(() =>
      expect(screen.getByTestId("shot-recipe-cost-v1")).toBeTruthy(),
    );
    const v1Cost = screen.getByTestId("shot-recipe-cost-v1").textContent ?? "";
    expect(v1Cost).toContain("node.shotRecipe.costUnavailable");
    expect(v1Cost).toContain("reason=video backend unavailable");
    // 没拿到报价就绝不能出现任何价格数字。
    expect(v1Cost).not.toMatch(/\d/);

    const v3Cost = screen.getByTestId("shot-recipe-cost-v3").textContent ?? "";
    expect(v3Cost).toContain("node.shotRecipe.costUnavailable");
    expect(v3Cost).not.toMatch(/\d/);

    // 有报价的那条才显示报价本身。
    const v2Cost = screen.getByTestId("shot-recipe-cost-v2").textContent ?? "";
    expect(v2Cost).toBe("42 credits");
    expect(v2Cost).not.toContain("node.shotRecipe.costUnavailable");
  });

  it("degrades to an unknown-capabilities notice when capabilities_known=false", async () => {
    mockApi();
    setup();

    await waitFor(() =>
      expect(screen.getByTestId("shot-recipe-capabilities-v3")).toBeTruthy(),
    );
    const v3Caps = screen.getByTestId("shot-recipe-capabilities-v3").textContent ?? "";
    expect(v3Caps).toContain("node.shotRecipe.capabilitiesUnknown");
    expect(v3Caps).toContain("model=seedance-2");
    // 不得伪造能力数值（这里是 4-12s / text2video / ref img ≤3）。
    expect(v3Caps).not.toContain("4-12s");
    expect(v3Caps).not.toContain("text2video");

    const v1Caps = screen.getByTestId("shot-recipe-capabilities-v1").textContent ?? "";
    expect(v1Caps).toContain("4-12s");
    expect(v1Caps).toContain("text2video");
  });

  it("renders look decisions with their bound version and identity degradation", async () => {
    mockApi();
    setup();

    await waitFor(() =>
      expect(screen.getByTestId("shot-recipe-look-look_1")).toBeTruthy(),
    );
    const look = screen.getByTestId("shot-recipe-look-look_1").textContent ?? "";
    expect(look).toContain("林雪");
    expect(look).toContain("node.shotRecipe.identityKnown(value=id_lin)");
    expect(look).toContain("node.shotRecipe.boundVersion(value=v2)");
  });

  it("shows an empty state instead of a chain when the project has no recipes", async () => {
    const call = vi.mocked(apiCall).mockReset();
    call.mockResolvedValue([] as never);
    setup();

    expect(await screen.findByTestId("shot-recipe-empty")).toBeTruthy();
    expect(screen.queryByText("node.shotRecipe.versionChain")).toBeNull();
  });

  it("surfaces a load failure with the backend detail", async () => {
    const call = vi.mocked(apiCall).mockReset();
    call.mockRejectedValue(new Error("boom"));
    setup();

    // 失败时展示失败原因，不拿空态冒充「项目里没有配方」，也不假装链上有东西。
    expect(await screen.findByTestId("shot-recipe-failed")).toBeTruthy();
    expect(
      screen.getByText("node.shotRecipe.failed(detail=boom)"),
    ).toBeTruthy();
    // 失败不是空态：不能拿「项目里没有配方」掩盖读取错误。
    expect(screen.queryByTestId("shot-recipe-empty")).toBeNull();
    expect(screen.queryByText("node.shotRecipe.versionChain")).toBeNull();
  });

  it("calls the recipe endpoints by project and recipe id", async () => {
    const call = mockApi();
    setup();

    await waitFor(() =>
      expect(screen.getByTestId("shot-recipe-version-v3")).toBeTruthy(),
    );
    const paths = call.mock.calls.map(([path]) => path);
    expect(paths).toContain("projects/proj-1/shot-recipes");
    expect(paths).toContain("projects/proj-1/shot-recipes/recipe_abc");
  });
});

/**
 * 渲染入口：入队 → 立刻对账 → 拉新明细。断言渲染不再是后端孤岛。
 */
describe("ShotRecipePanel render entry", () => {
  function mockRenderApi(options: {
    /** 对账回执。中间态用 changed=false + status=rendering。 */
    sync?: Record<string, unknown>;
    /** 对账后 GET 详情返回的版本集合。 */
    afterVersions?: unknown[];
    /** 停留在 intermediate 状态（对账没有推进任何行）时为 true。 */
    staysIntermediate?: boolean;
    /** 画布上铺哪些节点 id（默认 ["n1"]，与版本的 source_refs.node_id 一致）。 */
    canvasNodes?: string[];
  } = {}) {
    seedCanvas(options.canvasNodes ?? ["n1"]);
    let rendered = false;
    const call = vi.mocked(apiCall).mockReset();
    call.mockImplementation((async (path: string) => {
      if (path.endsWith("/shot-recipes")) return [RECIPE_HEADER];
      if (path.endsWith("/render")) {
        rendered = true;
        return { recipe_id: "recipe_abc", version_id: "v4", job_id: "job_v4" };
      }
      if (path.endsWith("/sync")) {
        return (
          options.sync ?? {
            recipe_id: "recipe_abc",
            version_id: "v4",
            changed: false,
            status: "rendering",
            task_status: "running",
            task_found: true,
          }
        );
      }
      if (path.includes("/shot-recipes/")) {
        const refreshed = rendered && options.afterVersions;
        let versions: unknown[] = refreshed
          ? (options.afterVersions as unknown[])
          : [...RECIPE_VERSIONS, RENDERABLE_VERSION];
        if (rendered && options.staysIntermediate) {
          versions = [...RECIPE_VERSIONS, { ...RENDERABLE_VERSION, status: "rendering" }];
        }
        return { recipe: RECIPE_HEADER, versions, look_decisions: [] };
      }
      throw new Error(`unexpected path: ${path}`);
    }) as never);
    return call;
  }

  it("enqueues, reconciles and refreshes through the three real endpoints", async () => {
    const call = mockRenderApi();
    setup();

    const button = await screen.findByTestId("shot-recipe-render-v4");
    button.click();

    await waitFor(() =>
      expect(call.mock.calls.some(([path]) => path.endsWith("/sync"))).toBe(true),
    );
    const paths = call.mock.calls.map(([path]) => path);
    const renderIdx = paths.findIndex((path) => path.endsWith("/render"));
    const syncIdx = paths.findIndex((path) => path.endsWith("/sync"));
    expect(renderIdx).toBeGreaterThan(-1);
    // 顺序不能反：必须先入队再对账，否则对账查的是一个不存在的任务。
    expect(syncIdx).toBeGreaterThan(renderIdx);

    const renderUrl = paths[renderIdx];
    expect(renderUrl).toBe(
      "projects/proj-1/shot-recipes/recipe_abc/versions/v4/render",
    );
    expect(paths[syncIdx]).toBe(
      "projects/proj-1/shot-recipes/recipe_abc/versions/v4/sync",
    );
    const renderBody = call.mock.calls[renderIdx][1] as {
      method?: string;
      json?: Record<string, unknown>;
    };
    expect(renderBody.method).toBe("POST");
    expect(renderBody.json?.model_id).toBe("seedance-2");
    expect(renderBody.json?.duration_seconds).toBe(8);
  });

  it("keeps rendering visible when the task is still running (changed=false)", async () => {
    const call = mockRenderApi({ staysIntermediate: true });
    setup();

    const button = await screen.findByTestId("shot-recipe-render-v4");
    button.click();

    await waitFor(() =>
      expect(call.mock.calls.some(([path]) => path.endsWith("/sync"))).toBe(true),
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("shot-recipe-version-v4").textContent,
      ).toContain("rendering"),
    );
    const row = screen.getByTestId("shot-recipe-version-v4").textContent ?? "";
    expect(row).not.toContain("node.shotRecipe.renderCompleted");
    expect(screen.queryByTestId("shot-recipe-render-outcome-v4")).toBeNull();
    // rendering 是中间态，不是 ready：入口收起，避免重复入队。
    expect(screen.queryByTestId("shot-recipe-render-v4")).toBeNull();
  });

  it("shows the artifact url once the task reached completed", async () => {
    mockRenderApi({
      sync: {
        recipe_id: "recipe_abc",
        version_id: "v4",
        changed: true,
        status: "completed",
        task_found: true,
        artifact_url: "/static/freezone/v4.mp4",
      },
      afterVersions: [...RECIPE_VERSIONS, COMPLETED_VERSION],
    });
    setup();

    const button = await screen.findByTestId("shot-recipe-render-v4");
    button.click();

    const outcome = await screen.findByTestId("shot-recipe-render-outcome-v5");
    expect(outcome.textContent).toContain("node.shotRecipe.renderCompleted");
    expect(outcome.textContent).toContain("/static/freezone/v5.mp4");
  });

  it("writes the artifact back onto the node this recipe is bound to", async () => {
    mockRenderApi({
      sync: {
        recipe_id: "recipe_abc",
        version_id: "v4",
        changed: true,
        status: "completed",
        task_found: true,
        artifact_url: "/static/freezone/v4.mp4",
        source_refs: {
          canvas_id: "default",
          node_id: "n1",
          artifact_url: "/static/freezone/v4.mp4",
        },
      },
      afterVersions: [
        ...RECIPE_VERSIONS,
        {
          ...COMPLETED_VERSION,
          version_id: "v4",
          parent_version_id: "v3",
          source_refs: {
            canvas_id: "default",
            node_id: "n1",
            job_id: "job_v4",
            artifact_url: "/static/freezone/v4.mp4",
          },
          lineage: ["v1", "v2", "v3", "v4"],
        },
      ],
    });
    setup();

    const button = await screen.findByTestId("shot-recipe-render-v4");
    button.click();

    // 回执带来源节点回写：产物落到版本绑定的那个节点上（面板 props.nodeId === n1）。
    await waitFor(() =>
      expect(
        (
          useCanvasStore.getState().nodes.find((node) => node.id === "n1")
            ?.data as { videoUrl?: string }
        ).videoUrl,
      ).toBe("/static/freezone/v4.mp4"),
    );
    const writeback = await screen.findByTestId("shot-recipe-canvas-writeback");
    expect(writeback.textContent).toContain("/static/freezone/v4.mp4");
    // 「画布白名单不允许建边」那句提示是错的，不能回归。
    expect(screen.queryByTestId("shot-recipe-manual-edge-hint")).toBeNull();
  });

  it("surfaces a missing canvas node instead of crashing when the node is gone", async () => {
    mockRenderApi({
      canvasNodes: ["other-node"],
      sync: {
        recipe_id: "recipe_abc",
        version_id: "v4",
        changed: true,
        status: "completed",
        task_found: true,
        artifact_url: "/static/freezone/v4.mp4",
        source_refs: {
          canvas_id: "default",
          node_id: "n1",
          artifact_url: "/static/freezone/v4.mp4",
        },
      },
      afterVersions: [...RECIPE_VERSIONS, COMPLETED_VERSION],
    });
    setup();

    const button = await screen.findByTestId("shot-recipe-render-v4");
    button.click();

    // 版本绑定的节点不在当前画布上：如实报错，不猜节点、不崩。
    const failure = await screen.findByTestId("shot-recipe-failed");
    expect(failure.textContent).toContain(
      "node.shotRecipe.artifactWritebackMissingNode",
    );
    expect(failure.textContent).toContain("node=n1");
    // 画布上那个别的节点没被写过任何产物。
    expect(useCanvasStore.getState().nodes[0].data).toEqual({});
  });

  it("shows the failure reason instead of a success badge on a failed render", async () => {
    mockRenderApi({
      sync: {
        recipe_id: "recipe_abc",
        version_id: "v4",
        changed: true,
        status: "failed",
        task_found: true,
        error: "backend returned 502",
      },
      afterVersions: [...RECIPE_VERSIONS, FAILED_VERSION],
    });
    setup();

    const button = await screen.findByTestId("shot-recipe-render-v4");
    button.click();

    const outcome = await screen.findByTestId("shot-recipe-render-outcome-v6");
    expect(outcome.textContent).toContain("node.shotRecipe.renderFailed");
    expect(outcome.textContent).toContain("backend returned 502");
    // 没有任何产物地址可指，不许编造。
    expect(outcome.textContent).not.toContain("http");
  });

  it("does not offer a render button when capabilities are unknown", async () => {
    mockApi();
    setup();

    await waitFor(() =>
      expect(screen.getByTestId("shot-recipe-version-v3")).toBeTruthy(),
    );
    // v3 是 failed 且 capabilities_known=false：后端会 409，前端就不该给入口。
    expect(screen.queryByTestId("shot-recipe-render-v3")).toBeNull();
    // 已完成 / 未就绪的版本同样不给入口。
    expect(screen.queryByTestId("shot-recipe-render-v1")).toBeNull();
    expect(screen.queryByTestId("shot-recipe-render-v2")).toBeNull();
  });
});

/**
 * 预检入口：只读地跑一次「能不能渲染」，把结构化 check 列表按 status 分色展示。
 *
 * 预检按钮**独立于 canRender**：它的意义正是在「还不能渲染」时说清为什么，所以
 * capabilities_known=false 的 ready 版本也该有预检入口。
 */
describe("ShotRecipePanel preflight entry", () => {
  /** 能力目录读不到的 ready 版本：渲染入口不出现，预检入口必须出现。 */
  const READY_NO_CAPS = {
    ...RENDERABLE_VERSION,
    version_id: "v7",
    parent_version_id: "v6",
    model_snapshot: { model_id: "seedance-2", capabilities_known: false },
    recorded_at: "2026-09-24T00:08:00Z",
    lineage: ["v1", "v2", "v3", "v4", "v5", "v6", "v7"],
  };

  function mockPreflightApi(report: Record<string, unknown>) {
    seedCanvas(["n1"]);
    const call = vi.mocked(apiCall).mockReset();
    call.mockImplementation((async (path: string) => {
      if (path.endsWith("/shot-recipes")) return [RECIPE_HEADER];
      if (path.endsWith("/preflight")) return report;
      if (path.includes("/shot-recipes/")) {
        return {
          recipe: RECIPE_HEADER,
          versions: [READY_NO_CAPS],
          look_decisions: [],
        };
      }
      throw new Error(`unexpected path: ${path}`);
    }) as never);
    return call;
  }

  const BLOCKED_REPORT = {
    recipe_id: "recipe_abc",
    version_id: "v7",
    ok: false,
    blocking: ["model_capabilities"],
    warnings: ["billing"],
    checks: [
      {
        id: "model_capabilities",
        status: "block",
        detail: "duration_seconds above maximum: 99 > 12",
      },
      { id: "look_decisions", status: "pass", detail: "no look decision bound" },
      { id: "source_refs", status: "warn", detail: "canvas 'default' not found" },
      { id: "billing", status: "warn", detail: "video backend unavailable" },
    ],
  };

  it("offers preflight on a ready version even when the render button is hidden", async () => {
    mockPreflightApi(BLOCKED_REPORT);
    setup();

    // capabilities_known=false：渲染入口不出现……
    expect(await screen.findByTestId("shot-recipe-preflight-v7")).toBeTruthy();
    expect(screen.queryByTestId("shot-recipe-render-v7")).toBeNull();
    // ……但预检入口必须在，否则用户无从知道为什么不能渲染。
    expect(screen.getByTestId("shot-recipe-preflight-v7")).toBeTruthy();
  });

  it("calls the preflight endpoint with the version's model and renders each check", async () => {
    const call = mockPreflightApi(BLOCKED_REPORT);
    setup();

    const button = await screen.findByTestId("shot-recipe-preflight-v7");
    button.click();

    const report = await screen.findByTestId("shot-recipe-preflight-report-v7");
    expect(report).toBeTruthy();
    const url = call.mock.calls
      .map(([path]) => path)
      .find((path) => path.endsWith("/preflight"));
    expect(url).toBe(
      "projects/proj-1/shot-recipes/recipe_abc/versions/v7/preflight",
    );
    const body = call.mock.calls.find(([path]) =>
      path.endsWith("/preflight"),
    )?.[1] as { method?: string; json?: Record<string, unknown> };
    expect(body.method).toBe("POST");
    expect(body.json?.model_id).toBe("seedance-2");
    expect(body.json?.duration_seconds).toBe(8);

    // 每条 check 一行，status 与 detail 原样展示
    const blockRow = screen.getByTestId(
      "shot-recipe-preflight-check-v7-model_capabilities",
    );
    expect(blockRow.textContent).toContain("status=block");
    expect(blockRow.textContent).toContain("99 > 12");
    // block 红、warn 黄、pass 弱化——三种颜色必须分开
    expect(blockRow.className).toContain("text-red-300");
    const warnRow = screen.getByTestId("shot-recipe-preflight-check-v7-source_refs");
    expect(warnRow.textContent).toContain("status=warn");
    expect(warnRow.className).toContain("text-amber-300");
    const passRow = screen.getByTestId("shot-recipe-preflight-check-v7-look_decisions");
    expect(passRow.textContent).toContain("status=pass");
    expect(passRow.className).toContain("text-white/40");
    // warn 绝不画成 pass：没有任何一条被提升
    expect(warnRow.className).not.toContain("text-white/40");
  });

  it("names the blocking checks when ok=false and never claims success", async () => {
    mockPreflightApi(BLOCKED_REPORT);
    setup();

    const button = await screen.findByTestId("shot-recipe-preflight-v7");
    button.click();

    const summary = await screen.findByTestId("shot-recipe-preflight-summary-v7");
    expect(summary.textContent).toBe(
      "node.shotRecipe.preflightBlocked(ids=model_capabilities)",
    );
    expect(summary.className).toContain("text-red-300");
    expect(summary.textContent).not.toContain("preflightAllPassed");
  });

  it("reports warnings without block as warnings, not as passed", async () => {
    mockPreflightApi({
      recipe_id: "recipe_abc",
      version_id: "v7",
      ok: true,
      blocking: [],
      warnings: ["billing", "source_refs"],
      checks: [
        { id: "model_capabilities", status: "pass", detail: "duration=8s" },
        { id: "billing", status: "warn", detail: "credit quote unavailable" },
      ],
    });
    setup();

    const button = await screen.findByTestId("shot-recipe-preflight-v7");
    button.click();

    const summary = await screen.findByTestId("shot-recipe-preflight-summary-v7");
    // ok=true 但有 warn：必须报「有警告」，不得说「全部通过」。
    expect(summary.textContent).toBe(
      "node.shotRecipe.preflightWarnings(ids=billing, source_refs)",
    );
    expect(summary.textContent).not.toContain("preflightAllPassed");
  });

  it("surfaces a preflight failure through the panel error path", async () => {
    const call = vi.mocked(apiCall).mockReset();
    call.mockImplementation((async (path: string) => {
      if (path.endsWith("/shot-recipes")) return [RECIPE_HEADER];
      if (path.endsWith("/preflight")) throw new Error("preflight boom");
      if (path.includes("/shot-recipes/")) {
        return {
          recipe: RECIPE_HEADER,
          versions: [READY_NO_CAPS],
          look_decisions: [],
        };
      }
      throw new Error(`unexpected path: ${path}`);
    }) as never);
    setup();

    const button = await screen.findByTestId("shot-recipe-preflight-v7");
    button.click();

    const failed = await screen.findByTestId("shot-recipe-failed");
    expect(failed.textContent).toContain("preflight boom");
    // 失败不是结论：不能留下任何预检报告冒充已检查
    expect(screen.queryByTestId("shot-recipe-preflight-report-v7")).toBeNull();
  });
});

/**
 * 质量检查入口：只读地算一次「这条版本哪里可疑」，按 severity 分色逐条展示
 * detail 与 evidence。
 *
 * 面板上**不得出现任何总分/评分**：报告本身就是结构化 risks 列表，渲染一个 score
 * 就违背了 oracle 的要求。这里连同「不得把 critical 画成 warning」一起钉住。
 */
describe("ShotRecipePanel quality entry", () => {
  const READY_NO_CAPS = {
    ...RENDERABLE_VERSION,
    version_id: "v7",
    parent_version_id: "v6",
    model_snapshot: { model_id: "seedance-2", capabilities_known: false },
    recorded_at: "2026-09-24T00:08:00Z",
    lineage: ["v1", "v2", "v3", "v4", "v5", "v6", "v7"],
  };

  const QUALITY_REPORT = {
    recipe_id: "recipe_abc",
    version_id: "v7",
    risks: [
      {
        id: "look_identity_drift",
        severity: "critical",
        detail: "character '林雪' changed identity: 'id_a' -> 'id_b'",
        evidence: {
          version_id: "v7",
          parent_version_id: "v6",
          character_name: "林雪",
        },
      },
      {
        id: "parent_not_completed",
        severity: "warning",
        detail: "this version branches off a shoot that never succeeded",
        evidence: { version_id: "v7", parent_status: "failed" },
      },
      {
        id: "cost_unknown",
        severity: "info",
        detail: "credit quote unavailable",
        evidence: { version_id: "v7", quoted: false },
      },
    ],
    counts: { critical: 1, warning: 1, info: 1 },
    risk_ids: ["look_identity_drift", "parent_not_completed", "cost_unknown"],
    checked_at: "2026-09-24T00:09:00Z",
  };

  function mockQualityApi(report: Record<string, unknown>) {
    seedCanvas(["n1"]);
    const call = vi.mocked(apiCall).mockReset();
    call.mockImplementation((async (path: string) => {
      if (path.endsWith("/shot-recipes")) return [RECIPE_HEADER];
      if (path.endsWith("/quality")) return report;
      if (path.includes("/shot-recipes/")) {
        return {
          recipe: RECIPE_HEADER,
          versions: [READY_NO_CAPS],
          look_decisions: [],
        };
      }
      throw new Error(`unexpected path: ${path}`);
    }) as never);
    return call;
  }

  it("offers quality on a ready version even when the render button is hidden", async () => {
    mockQualityApi(QUALITY_REPORT);
    setup();

    expect(await screen.findByTestId("shot-recipe-quality-v7")).toBeTruthy();
    expect(screen.queryByTestId("shot-recipe-render-v7")).toBeNull();
  });

  it("calls the quality endpoint read-only and renders each risk with its evidence", async () => {
    const call = mockQualityApi(QUALITY_REPORT);
    setup();

    const button = await screen.findByTestId("shot-recipe-quality-v7");
    button.click();

    const report = await screen.findByTestId("shot-recipe-quality-report-v7");
    expect(report).toBeTruthy();
    const qualityCall = call.mock.calls.find(([path]) =>
      path.endsWith("/quality"),
    );
    expect(qualityCall?.[0]).toBe(
      "projects/proj-1/shot-recipes/recipe_abc/versions/v7/quality",
    );
    // 纯只读：GET，没有 method / json 之类的请求体
    expect(qualityCall?.[1]).toBeUndefined();

    // 逐条按 severity 分色：critical 红 / warning 黄 / info 弱化
    const critical = screen.getByTestId(
      "shot-recipe-quality-risk-v7-look_identity_drift",
    );
    expect(critical.textContent).toContain("severity=critical");
    expect(critical.textContent).toContain("changed identity");
    expect(critical.className).toContain("text-red-300");
    // evidence 必须逐条展示（报告要可审计）
    expect(critical.textContent).toContain("node.shotRecipe.qualityEvidence");
    expect(critical.textContent).toContain("character_name");
    expect(critical.textContent).toContain("parent_version_id");

    const warning = screen.getByTestId(
      "shot-recipe-quality-risk-v7-parent_not_completed",
    );
    expect(warning.textContent).toContain("severity=warning");
    expect(warning.className).toContain("text-amber-300");
    expect(warning.className).not.toContain("text-red-300");

    const info = screen.getByTestId("shot-recipe-quality-risk-v7-cost_unknown");
    expect(info.textContent).toContain("severity=info");
    expect(info.className).toContain("text-white/40");

    // 面板上不得出现任何总分 / 评分字段
    const text = report.textContent ?? "";
    expect(text).not.toMatch(/score|rating|grade/i);
  });

  it("summarises by severity count instead of claiming the version is good", async () => {
    mockQualityApi(QUALITY_REPORT);
    setup();

    const button = await screen.findByTestId("shot-recipe-quality-v7");
    button.click();

    const summary = await screen.findByTestId("shot-recipe-quality-summary-v7");
    expect(summary.textContent).toBe(
      "node.shotRecipe.qualitySummary(critical=1,warning=1,info=1)",
    );
    expect(summary.textContent).not.toContain("qualityClean");
  });

  it("says no risks were found for a clean report rather than inventing a score", async () => {
    mockQualityApi({
      recipe_id: "recipe_abc",
      version_id: "v7",
      risks: [],
      counts: { critical: 0, warning: 0, info: 0 },
      risk_ids: [],
      checked_at: "2026-09-24T00:09:00Z",
    });
    setup();

    const button = await screen.findByTestId("shot-recipe-quality-v7");
    button.click();

    const summary = await screen.findByTestId("shot-recipe-quality-summary-v7");
    expect(summary.textContent).toBe("node.shotRecipe.qualityClean");
    expect(
      screen.queryByTestId("shot-recipe-quality-risk-v7-cost_unknown"),
    ).toBeNull();
  });

  it("surfaces a quality failure through the panel error path", async () => {
    const call = vi.mocked(apiCall).mockReset();
    call.mockImplementation((async (path: string) => {
      if (path.endsWith("/shot-recipes")) return [RECIPE_HEADER];
      if (path.endsWith("/quality")) throw new Error("quality boom");
      if (path.includes("/shot-recipes/")) {
        return {
          recipe: RECIPE_HEADER,
          versions: [READY_NO_CAPS],
          look_decisions: [],
        };
      }
      throw new Error(`unexpected path: ${path}`);
    }) as never);
    setup();

    const button = await screen.findByTestId("shot-recipe-quality-v7");
    button.click();

    const failed = await screen.findByTestId("shot-recipe-failed");
    expect(failed.textContent).toContain("quality boom");
    // 失败不是结论：不能留下任何报告冒充已检查
    expect(screen.queryByTestId("shot-recipe-quality-report-v7")).toBeNull();
  });
});

/**
 * 重拍入口：在**已完成且有 artifact_url** 的版本行上展开内联表单，提交后复用
 * handleRender 的动作序列（入队 → 立刻 sync → 重拉明细），使新子版本出现。
 *
 * 区间非法（end <= start）必须就地报错、**不发请求**——让用户白等一次 400 是明确的
 * 反面要求。没有产物的版本（ready / rendering / failed）不给入口。
 */
describe("ShotRecipePanel reshoot entry", () => {
  /** 重拍后新出现的子版本（v5 的重拍产物）。 */
  const RESHOOT_CHILD = {
    ...COMPLETED_VERSION,
    version_id: "v7",
    parent_version_id: "v5",
    status: "rendering",
    prompt_delta: {
      mode: "delta",
      prompt: "reshoot this bit",
      changes: { reshoot_segment: { source_version_id: "v5", job_id: "job_re" } },
    },
    source_refs: {
      canvas_id: "default",
      node_id: "n1",
      job_id: "job_re",
      task_type: "freezone_video_reshoot",
      reshoot_of: "v5",
      artifact_url: "/static/freezone/v5.mp4",
    },
    recorded_at: "2026-09-24T00:10:00Z",
    lineage: ["v1", "v2", "v3", "v4", "v5", "v7"],
  };

  function mockReshootApi(options: { childAppears?: boolean } = {}) {
    seedCanvas(["n1"]);
    let reshooted = false;
    const call = vi.mocked(apiCall).mockReset();
    call.mockImplementation((async (path: string) => {
      if (path.endsWith("/shot-recipes")) return [RECIPE_HEADER];
      if (path.endsWith("/reshoot")) {
        reshooted = true;
        return {
          recipe_id: "recipe_abc",
          version_id: "v7",
          source_version_id: "v5",
          job_id: "job_re",
        };
      }
      if (path.endsWith("/sync")) {
        return {
          recipe_id: "recipe_abc",
          version_id: "v7",
          changed: false,
          status: "rendering",
          task_found: true,
        };
      }
      if (path.includes("/shot-recipes/")) {
        return {
          recipe: RECIPE_HEADER,
          versions: [
            ...RECIPE_VERSIONS,
            COMPLETED_VERSION,
            ...(reshooted && options.childAppears !== false
              ? [RESHOOT_CHILD]
              : []),
          ],
          look_decisions: [],
        };
      }
      throw new Error(`unexpected path: ${path}`);
    }) as never);
    return call;
  }

  it("offers reshoot only on a completed version with an artifact url", async () => {
    mockReshootApi();
    setup();

    expect(await screen.findByTestId("shot-recipe-reshoot-v5")).toBeTruthy();
    // 没出过片的版本（v1 是 completed 但没有 artifact_url）不给入口
    expect(screen.queryByTestId("shot-recipe-reshoot-v1")).toBeNull();
    expect(screen.queryByTestId("shot-recipe-reshoot-v3")).toBeNull();
    expect(screen.queryByTestId("shot-recipe-reshoot-v4")).toBeNull();
  });

  it("submits the inline range and refreshes so the child version appears", async () => {
    const call = mockReshootApi();
    setup();

    const toggle = await screen.findByTestId("shot-recipe-reshoot-v5");
    toggle.click();

    const start = await screen.findByTestId("shot-recipe-reshoot-start-v5");
    const end = screen.getByTestId("shot-recipe-reshoot-end-v5");
    const prompt = screen.getByTestId("shot-recipe-reshoot-prompt-v5");
    fillInput(start, "1.5");
    fillInput(end, "4.5");
    fillInput(prompt, "reshoot this bit");
    screen.getByTestId("shot-recipe-reshoot-submit-v5").click();

    await waitFor(() =>
      expect(call.mock.calls.some(([path]) => path.endsWith("/reshoot"))).toBe(true),
    );
    const paths = call.mock.calls.map(([path]) => path);
    const reshootIdx = paths.findIndex((path) => path.endsWith("/reshoot"));
    const syncIdx = paths.findIndex((path) => path.endsWith("/sync"));
    // 顺序不能反：必须先入队再对账，否则对账查的是一个不存在的任务。
    expect(syncIdx).toBeGreaterThan(reshootIdx);
    expect(paths[reshootIdx]).toBe(
      "projects/proj-1/shot-recipes/recipe_abc/versions/v5/reshoot",
    );
    expect(paths[syncIdx]).toBe(
      "projects/proj-1/shot-recipes/recipe_abc/versions/v7/sync",
    );
    const body = call.mock.calls[reshootIdx][1] as {
      method?: string;
      json?: Record<string, unknown>;
    };
    expect(body.method).toBe("POST");
    expect(body.json?.model_id).toBe("seedance-2");
    expect(body.json?.start_seconds).toBe(1.5);
    expect(body.json?.end_seconds).toBe(4.5);
    expect(body.json?.prompt).toBe("reshoot this bit");

    // 重拉明细后新子版本出现在链上，父指针指向源版本
    const child = await screen.findByTestId("shot-recipe-version-v7");
    expect(child.textContent).toContain("rendering");
    expect(screen.getByTestId("shot-recipe-parent-v7").textContent).toBe(
      "node.shotRecipe.parent(value=v5)",
    );
  });

  it("rejects an invalid range locally without sending any request", async () => {
    const call = mockReshootApi();
    setup();

    const toggle = await screen.findByTestId("shot-recipe-reshoot-v5");
    toggle.click();

    const start = await screen.findByTestId("shot-recipe-reshoot-start-v5");
    const end = screen.getByTestId("shot-recipe-reshoot-end-v5");
    fillInput(start, "6");
    fillInput(end, "3");
    screen.getByTestId("shot-recipe-reshoot-submit-v5").click();

    const failed = await screen.findByTestId("shot-recipe-failed");
    expect(failed.textContent).toContain("node.shotRecipe.reshootRangeInvalid");
    // 就地拦下：一个请求都不发（尤其不能先发 /reshoot 再等 400）。
    expect(call.mock.calls.some(([path]) => path.endsWith("/reshoot"))).toBe(false);
    expect(call.mock.calls.some(([path]) => path.endsWith("/sync"))).toBe(false);
  });

  it("surfaces a reshoot failure through the panel error path", async () => {
    const call = vi.mocked(apiCall).mockReset();
    call.mockImplementation((async (path: string) => {
      if (path.endsWith("/shot-recipes")) return [RECIPE_HEADER];
      if (path.endsWith("/reshoot")) throw new Error("reshoot boom");
      if (path.includes("/shot-recipes/")) {
        return {
          recipe: RECIPE_HEADER,
          versions: [...RECIPE_VERSIONS, COMPLETED_VERSION],
          look_decisions: [],
        };
      }
      throw new Error(`unexpected path: ${path}`);
    }) as never);
    setup();

    const toggle = await screen.findByTestId("shot-recipe-reshoot-v5");
    toggle.click();
    fillInput(await screen.findByTestId("shot-recipe-reshoot-start-v5"), "1");
    fillInput(screen.getByTestId("shot-recipe-reshoot-end-v5"), "3");
    screen.getByTestId("shot-recipe-reshoot-submit-v5").click();

    const failed = await screen.findByTestId("shot-recipe-failed");
    expect(failed.textContent).toContain("reshoot boom");
    // 失败不是成功：不能凭空多出一条子版本行。
    expect(screen.queryByTestId("shot-recipe-version-v7")).toBeNull();
  });
});
