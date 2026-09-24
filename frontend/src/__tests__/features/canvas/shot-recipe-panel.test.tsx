// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import { ShotRecipePanel } from "@/features/canvas/ui/ShotRecipePanel";
import { apiCall } from "@/api/client";

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