// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  attemptCacheBustedReload,
  installChunkLoadRecovery,
  isChunkLoadError,
  navigateToProjectList,
  requestChunkLoadRecovery,
  resetChunkLoadRecoveryForTests,
} from "@/lib/chunk-load-recovery";

describe("chunk-load-recovery", () => {
  beforeEach(() => {
    resetChunkLoadRecoveryForTests();
  });

  it("asks the user to refresh for dynamic import failures without auto-reloading", () => {
    const result = requestChunkLoadRecovery(
      new TypeError("Failed to fetch dynamically imported module: /assets/freezone.lazy-old.js"),
    );

    expect(result).toBe("needs-user-reload");
  });

  it("keeps showing the refresh prompt for repeated dynamic import failures", () => {
    const result = requestChunkLoadRecovery(
      new TypeError("error loading dynamically imported module"),
    );

    expect(result).toBe("needs-user-reload");
  });

  it("retries one cache-busted document load per build and stops looping", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const navigate = vi.fn();
    const options = {
      buildId: "build-a",
      href: "https://app.example/projects/p/freezone?canvas=c1#node",
      storage,
      navigate,
      nonce: "retry-1",
    };

    expect(attemptCacheBustedReload(options)).toBe(true);
    expect(navigate).toHaveBeenCalledTimes(1);
    const destination = new URL(navigate.mock.calls[0][0]);
    expect(destination.pathname).toBe("/projects/p/freezone");
    expect(destination.searchParams.get("canvas")).toBe("c1");
    expect(destination.searchParams.get("__app_chunk_recovery")).toBe("build-a-retry-1");
    expect(destination.hash).toBe("#node");
    expect(attemptCacheBustedReload(options)).toBe(false);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("allows the cache-busted recovery attempt after a new build", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const navigate = vi.fn();
    attemptCacheBustedReload({ buildId: "build-a", href: "https://app.example/", storage, navigate, nonce: "1" });

    expect(attemptCacheBustedReload({ buildId: "build-b", href: "https://app.example/", storage, navigate, nonce: "2" })).toBe(true);
    expect(navigate).toHaveBeenCalledTimes(2);
  });

  it("provides an escape to the project list when the current route chunk stays unavailable", () => {
    const navigate = vi.fn();
    expect(navigateToProjectList(navigate, "/projects/demo/freezone")).toBe(true);
    expect(navigate).toHaveBeenCalledWith("/");
  });

  it("does not redirect again when the project list itself has a chunk failure", () => {
    const navigate = vi.fn();
    expect(navigateToProjectList(navigate, "/")).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("ignores non chunk-load errors", () => {
    const result = requestChunkLoadRecovery(
      new Error("ordinary render failure"),
    );

    expect(result).toBe("ignored");
  });

  it("recognizes common browser chunk failure messages", () => {
    expect(isChunkLoadError(new Error("ChunkLoadError: Loading chunk 123 failed."))).toBe(true);
    expect(isChunkLoadError("Importing a module script failed.")).toBe(true);
    expect(isChunkLoadError(new Error("Failed to fetch dynamically imported module"))).toBe(true);
    expect(isChunkLoadError(new Error("network failed while saving canvas"))).toBe(false);
  });

  it("keeps the app shell mounted while showing the user-refresh prompt", () => {
    const mainSource = readFileSync(resolve(process.cwd(), "src/main.tsx"), "utf8");
    const updatePromptSource = readFileSync(
      resolve(process.cwd(), "src/components/app-update-required.tsx"),
      "utf8",
    );

    expect(mainSource).not.toContain("if (updateRequired) {");
    expect(mainSource).toContain("<RouterProvider router={router} />");
    expect(mainSource).toContain("updateRequired ? <AppUpdateRequired /> : <AppUpdateAvailable />");
    expect(updatePromptSource).toContain("attemptAutomaticChunkReload");
    expect(updatePromptSource).toContain("forceChunkReload");
    expect(updatePromptSource).toContain("navigateToProjectList");
    expect(updatePromptSource).toContain("fixed inset-0");
  });

  it("prevents Vite preload chunk failures from bubbling into a retry loop", () => {
    const cleanup = installChunkLoadRecovery();
    const event = new Event("vite:preloadError", { cancelable: true }) as Event & { payload?: unknown };
    event.payload = new TypeError("Failed to fetch dynamically imported module: /assets/freezone.lazy-old.js");

    const dispatched = window.dispatchEvent(event);

    expect(dispatched).toBe(false);
    cleanup();
  });
});
