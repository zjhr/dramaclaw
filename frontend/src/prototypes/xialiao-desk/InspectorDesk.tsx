// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

import { IngestPageFrame } from "./IngestChrome";
import { ManuscriptThread } from "./ManuscriptThread";
import { useDesk } from "./desk";

/** 虾导直接改工作稿，左边的开始导入跟着放开。 */
export function InspectorDesk() {
  const desk = useDesk();
  return <IngestPageFrame desk={desk} aside={<ManuscriptThread desk={desk} />} />;
}
