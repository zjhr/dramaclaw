// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ResponsePromise } from "ky";
import { api, uploadApi } from "@/lib/api";
import { jsonWithBackendError } from "@/lib/api-errors";
import { p } from "@/lib/api-path";
import { queryKeys } from "@/lib/query-keys";
import type { ErrorResponse, OkResponse, TaskResponse } from "@/types/api";
import type { Chapter } from "@/types/episode";
import type { SpineTemplate } from "@/types/project";

export interface FormatCheckIssue {
  code: string;
  line: number | null;
  /** 后端产的中文原文，仅作 i18n 的 defaultValue，不要直接渲染。 */
  message: string;
  /** 同上。 */
  fix: string;
  /** 结构化插值参数，交给 localizeFormatCheck 拼本地化文案。 */
  params?: Record<string, unknown>;
}

export interface FormatCheck {
  level: "ok" | "warning" | "blocking";
  /** 后端产的中文原文，仅作 i18n 的 defaultValue，不要直接渲染。 */
  summary: string;
  summary_code?: string;
  summary_params?: Record<string, unknown>;
  issues?: FormatCheckIssue[];
  metrics?: Record<string, number>;
  scene_header_status?: "standard" | "repairable" | "missing";
}

export interface UploadResult {
  filename: string;
  size: number;
  total_chars?: number;
  billable_chars?: number;
  count?: number;
  episode?: number;
  chapters?: Chapter[];
  format_check?: FormatCheck;
}

export interface ManuscriptCharacterMapping {
  original: string;
  aliases: string[];
  replacement: string;
  replacement_aliases: string[];
  gender: "male" | "female" | "animal" | "unknown";
  selected: boolean;
}

export interface ManuscriptActionRequest {
  filename: string;
  action:
    | "hook"
    | "wash"
    | "cast_preview"
    | "cast_apply"
    | "gender_preview"
    | "gender_apply"
    | "imitate"
    | "adapt";
  spine_template: SpineTemplate;
  style?: string;
  mappings?: ManuscriptCharacterMapping[];
  reasoning_effort?: "none" | "low" | "medium" | "high";
}

export interface ManuscriptActionResult {
  action: ManuscriptActionRequest["action"];
  working_filename?: string;
  mappings?: ManuscriptCharacterMapping[];
  content?: string;
  upload?: UploadResult;
  calls?: string[];
}

/** 「另写一篇」的三种成稿。ad 走精品剧脊，锁死 1 集。 */
export type WriteKind = "novel" | "drama" | "ad";

export interface WriteFirstAnswer {
  skill_id: string;
  question: string;
  answer: string;
  /** 没有生成出问题时为 true，模型按该写法的提示词自行补齐。 */
  filled_by_skill: boolean;
}

export interface WriteFirstRequest {
  kind: WriteKind;
  premise: string;
  lead: string;
  count: string;
  skills: string[];
  answers?: WriteFirstAnswer[];
  reasoning_effort?: "none" | "low" | "medium" | "high";
  filename?: string;
  episode?: number;
  note?: string;
}

/** 写法库里的一条写法：名称 + 说明 + 提示词 + 这一问 + 三句灵感。 */
export interface WritingSkill {
  id: string;
  name: string;
  description: string;
  prompt: string;
  question: string;
  suggestions: string[];
  builtin: boolean;
}

/** 广告自带的那一问，由体裁决定，不进写法库。 */
export interface WritingSkillBrief {
  id: string;
  name: string;
  description: string;
  question: string;
  suggestions: string[];
}

export interface WritingSkillLibrary {
  skills: WritingSkill[];
  ad_brief: WritingSkillBrief;
}

export interface WritingSkillSave {
  id?: string;
  name: string;
  description: string;
  prompt: string;
  question: string;
  suggestions: string[];
  /** 提示词改了会让模型重写问题和三句；这里显式要求再生成一次。 */
  regenerate: boolean;
  /** 生成时的体裁上下文。空串表示脱离具体成稿来写这条问句。 */
  kind: WriteKind | "";
  context: string;
}

export interface WritingSkillSaveResult {
  skill: WritingSkill;
  regenerated: boolean;
}

export interface SkillSuggestionsResult {
  question: string;
  suggestions: string[];
}

interface ChaptersResult {
  chapters: Chapter[];
  total_chars: number;
  billable_chars?: number;
  count?: number;
  source_filename?: string;
  /** Client-only marker: upload parsing succeeded, but Cognee ingest has not completed. */
  preview_only?: boolean;
}

export interface KnowledgeGraphNode {
  id: string;
  label: string;
  type: string;
  degree: number;
  properties: Record<string, unknown>;
}

export interface KnowledgeGraphEdge {
  id: string;
  source: string;
  target: string;
  relation: string;
  properties: Record<string, unknown>;
}

export interface KnowledgeGraphSnapshot {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
  total_nodes: number;
  total_edges: number;
  truncated: boolean;
}

export function useUploadNovel(project: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      file,
      spineTemplate,
    }: {
      file: File;
      spineTemplate: SpineTemplate;
    }) => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("spine_template", spineTemplate);
      const response = await jsonWithBackendError<OkResponse<UploadResult> | ErrorResponse>(
        uploadApi.post(p`api/v1/projects/${project}/ingest/upload`, { body: formData }),
      );
      if (!response.ok) {
        throw new Error(response.error);
      }
      return response;
    },
    onSuccess: (response, variables) => {
      const preview = response.data;
      if (
        Array.isArray(preview.chapters) &&
        typeof preview.total_chars === "number"
      ) {
        queryClient.setQueryData<OkResponse<ChaptersResult>>(
          queryKeys.chapterPreview(project, variables.spineTemplate),
          {
            ok: true,
            data: {
              chapters: preview.chapters,
              total_chars: preview.total_chars,
              billable_chars: preview.billable_chars,
              count: preview.count,
              source_filename: preview.filename,
              preview_only: true,
            },
          },
        );
        return;
      }

      queryClient.invalidateQueries({ queryKey: queryKeys.chapters(project) });
    },
  });
}

export function useChapters(
  project: string,
  spineTemplate: SpineTemplate,
  enabled = true,
) {
  return useQuery({
    queryKey: queryKeys.chapterPreview(project, spineTemplate),
    queryFn: ({ signal }) =>
      api
        .get(p`api/v1/projects/${project}/chapters`, {
          signal,
          searchParams: { spine_template: spineTemplate },
        })
        .json<OkResponse<ChaptersResult>>(),
    enabled: !!project && enabled,
  });
}

export function useKnowledgeGraph(project: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.knowledgeGraph(project),
    // Ladybug graph reads run in a backend executor thread and cannot be stopped
    // safely midway. Do not consume React Query's unmount signal: let the request
    // finish and populate the cache when users briefly switch pages.
    queryFn: () =>
      api
        .get(p`api/v1/projects/${project}/ingest/graph`)
        .json<OkResponse<KnowledgeGraphSnapshot>>(),
    enabled: !!project && enabled,
    staleTime: 30_000,
  });
}

export interface ManuscriptRepairResult {
  original_filename: string;
  working_filename: string;
  chapter_number: number;
  chunk_index: number;
  chunk_count: number;
  chapter_count: number;
  completed_chapters: number[];
  done: boolean;
  needs_choice?: boolean;
  choices?: string[];
  calls?: string[];
  format_check?: FormatCheck;
  upload?: UploadResult;
}

export function useRepairManuscript(project: string) {
  return useMutation({
    mutationFn: async (params: {
      filename: string;
      spine_template: SpineTemplate;
      restart?: boolean;
      scene_header?: string;
      reasoning_effort?: "none" | "low" | "medium" | "high";
    }) => {
      const response = await jsonWithBackendError<
        | (OkResponse<ManuscriptRepairResult> & { error?: string })
        | (ErrorResponse & { data?: ManuscriptRepairResult })
      >(
        api.post(p`api/v1/projects/${project}/ingest/repair`, {
          json: params,
          timeout: 900_000,
          throwHttpErrors: false,
        }),
      );
      if (!response.ok) {
        const failed = new Error(response.error || "repair failed") as Error & {
          calls?: string[];
        };
        if (response.data?.calls?.length) {
          failed.calls = response.data.calls;
        }
        throw failed;
      }
      return response;
    },
  });
}

export function useManuscriptAction(project: string) {
  return useMutation({
    mutationFn: async (params: ManuscriptActionRequest) => {
      const response = await jsonWithBackendError<
        | (OkResponse<ManuscriptActionResult> & { error?: string })
        | (ErrorResponse & { data?: ManuscriptActionResult })
      >(
        api.post(p`api/v1/projects/${project}/ingest/manuscript-action`, {
          json: params,
          timeout: 1_800_000,
          throwHttpErrors: false,
        }),
      );
      if (!response.ok) {
        const failed = new Error(response.error || "manuscript action failed") as Error & {
          calls?: string[];
        };
        if (response.data?.calls?.length) failed.calls = response.data.calls;
        throw failed;
      }
      return response;
    },
  });
}

export function useWriteFirst(project: string) {
  return useMutation({
    mutationFn: async (params: WriteFirstRequest) => {
      const response = await jsonWithBackendError<
        | (OkResponse<{ upload: UploadResult; quality_issues?: string[] }> & { error?: string })
        | (ErrorResponse & { data?: { upload: UploadResult; quality_issues?: string[] } })
      >(
        api.post(p`api/v1/projects/${project}/ingest/write-first`, {
          json: params,
          timeout: 1_800_000,
          throwHttpErrors: false,
        }),
      );
      if (!response.ok || !response.data?.upload) {
        throw new Error(response.error || "failed to write the first unit");
      }
      return response.data;
    },
  });
}

export function useSaveManuscriptImitation(project: string) {
  return useMutation({
    mutationFn: async (params: {
      filename: string;
      content: string;
      spine_template: SpineTemplate;
      suffix?: string;
      target_template?: SpineTemplate | "";
      validate?: boolean;
    }) => {
      const response = await jsonWithBackendError<
        | (OkResponse<{ upload: UploadResult; import_started: false }> & { error?: string })
        | (ErrorResponse & { data?: { upload: UploadResult; import_started: false } })
      >(
        api.post(p`api/v1/projects/${project}/ingest/manuscript-action/save-imitation`, {
          json: params,
          timeout: 60_000,
          throwHttpErrors: false,
        }),
      );
      if (!response.ok || !response.data?.upload) {
        throw new Error(response.error || "failed to save imitation");
      }
      return response.data.upload;
    },
  });
}

export function useStartIngest(project: string) {
  return useMutation({
    mutationFn: async (params: {
      filename: string;
      rebuild?: boolean;
      spine_template?: SpineTemplate;
    }) => {
      const response = await jsonWithBackendError<TaskResponse | ErrorResponse>(
        api.post(p`api/v1/projects/${project}/ingest/start`, {
          json: params,
          throwHttpErrors: false,
        }),
      );
      if (!response.ok) {
        throw new Error(response.error);
      }
      return response;
    },
  });
}

// ── 写法库 ────────────────────────────────────────────────────────────────
// 写法是手艺不是某一本书的设定，所以这套接口挂在 /api/v1 下面，不带 project：
// 所有项目共用同一份 writing-skills.json。

async function writingSkillCall<T>(request: ResponsePromise): Promise<T> {
  const response = await jsonWithBackendError<
    (OkResponse<T> & { error?: string }) | (ErrorResponse & { data?: T })
  >(request);
  if (!response.ok || !response.data) {
    throw new Error(response.error || "failed to reach the writing skill library");
  }
  return response.data;
}

export function useWritingSkills() {
  return useQuery({
    queryKey: queryKeys.writingSkills(),
    queryFn: ({ signal }) =>
      writingSkillCall<WritingSkillLibrary>(
        api.get(p`api/v1/writing-skills`, { signal, throwHttpErrors: false }),
      ),
  });
}

export function useSaveWritingSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: WritingSkillSave) =>
      writingSkillCall<WritingSkillSaveResult>(
        params.id
          ? api.put(p`api/v1/writing-skills/${params.id}`, {
              json: params,
              throwHttpErrors: false,
            })
          : api.post(p`api/v1/writing-skills`, { json: params, throwHttpErrors: false }),
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.writingSkills() });
    },
  });
}

export function useDeleteWritingSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      writingSkillCall<{ id: string }>(
        api.delete(p`api/v1/writing-skills/${id}`, { throwHttpErrors: false }),
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.writingSkills() });
    },
  });
}

export function useRestoreWritingSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      writingSkillCall<{ skill: WritingSkill }>(
        api.post(p`api/v1/writing-skills/${id}/restore`, { throwHttpErrors: false }),
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.writingSkills() });
    },
  });
}

/** 提问过程中的「换一批」：只换屏幕上这三句，写法库不动。 */
export function useReshuffleWritingSkill() {
  return useMutation({
    mutationFn: async (params: {
      id: string;
      question: string;
      avoid: string[];
      kind: WriteKind | "";
      context: string;
    }) =>
      writingSkillCall<SkillSuggestionsResult>(
        api.post(p`api/v1/writing-skills/${params.id}/suggestions`, {
          json: params,
          // 换一批走真实模型，实测 20s–190s；默认 30s 会在模型返回前掐断请求。
          timeout: 300_000,
          throwHttpErrors: false,
        }),
      ),
  });
}
