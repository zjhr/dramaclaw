// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  PROJECT_NAME_MAX_LENGTH,
  getProjectNameValidationKey,
} from "@/routes/_app/index";

describe("项目名称长度校验", () => {
  it("接受 64 字符名称", () => {
    expect(PROJECT_NAME_MAX_LENGTH).toBe(64);
    expect(getProjectNameValidationKey("a".repeat(64))).toBeNull();
  });

  it("拒绝 65 字符名称", () => {
    expect(getProjectNameValidationKey("a".repeat(65))).toBe("project.nameTooLong");
  });

  it("接受中文以及字母、数字、下划线的组合", () => {
    expect(getProjectNameValidationKey("让你管账号")).toBeNull();
    expect(getProjectNameValidationKey("项目_01")).toBeNull();
    expect(getProjectNameValidationKey("项".repeat(64))).toBeNull();
  });

  it("按 NFC 计算长度，组合字符不算两个字符", () => {
    expect(getProjectNameValidationKey("e\u0301".repeat(64))).toBeNull();
    expect(getProjectNameValidationKey("项".repeat(65))).toBe("project.nameTooLong");
  });

  it("拒绝空格、斜杠和标点", () => {
    expect(getProjectNameValidationKey("让你管 账号")).toBe("project.nameInvalid");
    expect(getProjectNameValidationKey("项目/名")).toBe("project.nameInvalid");
    expect(getProjectNameValidationKey("foo-bar")).toBe("project.nameInvalid");
  });
});
