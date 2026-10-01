// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

import { FileText } from "lucide-react";
import { IngestPageFrame } from "./IngestChrome";
import { ManuscriptThread } from "./ManuscriptThread";
import { useDesk } from "./desk";

/** 虾导从零写一篇新文件，已上传的小说留在原位。 */
export function DialogueDesk() {
  const desk = useDesk();
  return (
    <IngestPageFrame
      desk={desk}
      aside={<ManuscriptThread desk={desk} />}
      below={
        desk.zeroStep === "draft" ? (
          <div className="xialiao-rise flex items-center gap-3 rounded-lg border border-white/10 bg-white/[0.04] px-4 py-3">
            <FileText className="size-4 text-sky-400" />
            <div className="min-w-0">
              <p className="truncate text-sm">{desk.brief.premise}</p>
              <p className="text-xs text-muted-foreground">新文件 · {desk.brief.kind} · 未导入</p>
            </div>
          </div>
        ) : null
      }
    />
  );
}
