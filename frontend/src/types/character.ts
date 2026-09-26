// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
export interface CharacterVoiceSample {
  path: string;
  sha256?: string;
  updated_at?: string;
}

export type CharacterVoiceSlotId =
  | "default"
  | "child"
  | "youth"
  | "middle"
  | "elder";

export interface CharacterVoiceSlot {
  slot: CharacterVoiceSlotId | string;
  label: string;
  path: string;
  url: string;
  sha256: string;
  updated_at: string;
  inherited_from_default: boolean;
  required: boolean;
}

export interface CharacterVoiceSamples {
  character: string;
  slots: CharacterVoiceSlot[];
}

export type CharacterAssetKind =
  | "portrait"
  | "identity"
  | "identity_costume"
  | "identity_portrait"
  | "identity_three_view"
  | "identity_expression_grid";

export interface CharacterAssetHistoryEntry {
  history_id: string;
  filename: string;
  url: string;
  created_at?: string;
  bytes?: number;
}

export interface CharacterAssetHistory {
  kind: CharacterAssetKind;
  identity_id?: string;
  current_url?: string | null;
  entries: CharacterAssetHistoryEntry[];
}

export interface CharacterAssetRestoreResult {
  kind: CharacterAssetKind;
  identity_id?: string;
  restored: boolean;
  url: string;
  backup_history_id?: string;
}

export interface Character {
  name: string;
  aliases?: string[];
  description?: string;
  role?: string;
  gender?: string;
  age_group?: string;
  is_main?: boolean;
  face_prompt?: string;
  body_type?: string;
  reference_audio_path?: string;
  reference_audio_url?: string;
  reference_audio_sha256?: string;
  reference_audio_updated_at?: string;
  voice_samples_by_age_group?: Record<string, CharacterVoiceSample>;
  portrait_path?: string | null;
  portrait_url?: string | null;
  history_url?: string;
  restore_url?: string;
  /**
   * 该角色名下所有身份的 id，由角色列表接口一次带出（身份详情仍走
   * `/characters/{name}/identities` 按需拉）。用于把 `?type=identity&id=` 深链
   * 解析到拥有它的角色，不必逐个角色去拉身份列表。
   */
  identity_ids?: string[];
}

export interface Identity {
  identity_id: string;
  identity_name: string;
  appearance_details?: string;
  face_prompt?: string;
  age_group?: string;
  body_type?: string;
  reference_audio_path?: string;
  reference_audio_url?: string;
  reference_audio_sha256?: string;
  reference_audio_updated_at?: string;
  image_path?: string | null;
  image_url?: string | null;
  costume_image_path?: string | null;
  costume_image_url?: string | null;
  portrait_image_path?: string | null;
  portrait_image_url?: string | null;
  three_view_url?: string | null;
  expression_grid_url?: string | null;
  three_view_history_url?: string;
  three_view_restore_url?: string;
  expression_grid_history_url?: string;
  expression_grid_restore_url?: string;
  look_design?: {
    makeup?: string;
    clothing?: string;
    accessories?: string[];
    face_shape?: string;
    eyes?: string;
    eyebrows?: string;
    nose?: string;
    lips?: string;
    body?: string;
    hair?: string;
    style?: string;
  };
  voice_url?: string;
  voice_source?: "" | "identity" | "default" | string;
  history_url?: string;
  restore_url?: string;
  costume_history_url?: string;
  portrait_history_url?: string;
}

export interface IdentityAttempts {
  image_attempts: number;
  portrait_attempts: number;
}
