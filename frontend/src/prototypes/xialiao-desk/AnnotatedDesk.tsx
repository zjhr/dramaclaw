// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

import { IngestPageFrame } from "./IngestChrome";
import { ManuscriptThread } from "./ManuscriptThread";
import { useDesk } from "./desk";

/** 虾导先给出场次稿，左边保持原样，点采用之后才变。 */
export function AnnotatedDesk() {
  const desk = useDesk();
  return <IngestPageFrame desk={desk} aside={<ManuscriptThread desk={desk} />} />;
}
