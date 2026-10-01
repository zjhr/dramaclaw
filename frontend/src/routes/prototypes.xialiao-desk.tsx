// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

import { createFileRoute } from "@tanstack/react-router";
import { XialiaoDeskHarness } from "@/prototypes/xialiao-desk/XialiaoDeskHarness";

export const Route = createFileRoute("/prototypes/xialiao-desk")({
  component: XialiaoDeskHarness,
});
