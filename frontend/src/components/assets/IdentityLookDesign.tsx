// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Mic, Square, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useTaskController } from "@/hooks/use-task-controller";
import { backendErrorToastMessage } from "@/lib/api-errors";
import {
  useClearIdentityVoice,
  useGenerateIdentityLookPack,
  useRecordIdentityVoice,
  useUpdateIdentity,
  useUploadIdentityVoice,
} from "@/lib/queries/characters";
import { queryKeys } from "@/lib/query-keys";
import { resolveMediaUrl } from "@/lib/media-url";
import { cn } from "@/lib/utils";
import type { Identity } from "@/types/character";
import {
  ACCESSORY_LIMIT,
  EMPTY_LOOK,
  normalizeLookDesign,
  type IdentityLookDesign,
} from "@/features/canvas/domain/identityLookCatalog";
import {
  VISUAL_ACCESSORIES,
  VISUAL_BODY,
  VISUAL_CLOTHING,
  VISUAL_EXPRESSION,
  VISUAL_EYEBROWS,
  VISUAL_EYES,
  VISUAL_FACE,
  VISUAL_HAIR,
  VISUAL_LIPS,
  VISUAL_MAKEUP,
  VISUAL_NOSE,
  VISUAL_STYLE,
  VisualPick,
} from "@/components/assets/visual-look";

type RowKey = Exclude<keyof IdentityLookDesign, "accessories">;
type DesignTab = "base" | "expression" | "wear" | "face" | "body" | "hair" | "style";

const TABS: { id: DesignTab; labelKey: string }[] = [
  { id: "base", labelKey: "characters.lookDesign.tabBase" },
  { id: "expression", labelKey: "characters.lookDesign.tabExpression" },
  { id: "wear", labelKey: "characters.lookDesign.tabWear" },
  { id: "face", labelKey: "characters.lookDesign.tabFace" },
  { id: "body", labelKey: "characters.lookDesign.tabBody" },
  { id: "hair", labelKey: "characters.lookDesign.tabHair" },
  { id: "style", labelKey: "characters.lookDesign.tabStyle" },
];

function dataUrlFromBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export function IdentityLookDesign({
  project,
  characterName,
  identity,
  imageModel,
}: {
  project: string;
  characterName: string;
  identity: Identity;
  imageModel?: string;
}) {
  const { t } = useTranslation();
  const updateIdentity = useUpdateIdentity(project, characterName);
  const generate = useGenerateIdentityLookPack(project, characterName);
  const uploadVoice = useUploadIdentityVoice(project, characterName);
  const recordVoice = useRecordIdentityVoice(project, characterName);
  const clearVoice = useClearIdentityVoice(project, characterName);
  const fileRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const [look, setLook] = useState<IdentityLookDesign>(EMPTY_LOOK);
  const [designOpen, setDesignOpen] = useState(false);
  const [tab, setTab] = useState<DesignTab>("wear");
  const [recording, setRecording] = useState(false);
  const task = useTaskController({
    key: {
      project,
      episode: 0,
      taskType: "identity_image",
      scope: `character:${characterName}:identity_look:${identity.identity_name}`,
    },
    invalidateKeys: [queryKeys.identities(project, characterName)],
    showCompleteToast: false,
    onComplete: () => toast.success(t("characters.lookDesign.generated")),
    onError: (error) => toast.error(error || t("common.error")),
  });

  useEffect(() => {
    setLook(normalizeLookDesign(identity.look_design));
  }, [identity.identity_id, identity.look_design]);

  const pickOne = (key: RowKey, value: string) => {
    setLook((current) => ({ ...current, [key]: current[key] === value ? "" : value }));
  };

  const pickAccessory = (value: string) => {
    setLook((current) => {
      if (value === "无配饰") {
        return {
          ...current,
          accessories: current.accessories.includes("无配饰") ? [] : ["无配饰"],
        };
      }
      const withoutNone = current.accessories.filter((item) => item !== "无配饰");
      if (withoutNone.includes(value)) {
        return { ...current, accessories: withoutNone.filter((item) => item !== value) };
      }
      if (withoutNone.length >= ACCESSORY_LIMIT) {
        toast.error(t("characters.lookDesign.accessoryLimit", { count: ACCESSORY_LIMIT }));
        return current;
      }
      return { ...current, accessories: [...withoutNone, value] };
    });
  };

  const lookPayload = {
    look_design: look,
    body_type: look.body,
    face_prompt: [look.face_shape, look.eyes, look.eyebrows, look.nose, look.lips, look.hair, look.expression]
      .filter(Boolean)
      .join("，"),
    appearance_details: [look.makeup, look.clothing, ...look.accessories.filter((item) => item !== "无配饰")]
      .filter(Boolean)
      .join("，"),
  };

  const save = async () => {
    try {
      await updateIdentity.mutateAsync({
        identityId: identity.identity_id,
        data: lookPayload,
      });
      toast.success(t("characters.lookDesign.saved"));
      setDesignOpen(false);
    } catch (err) {
      toast.error(backendErrorToastMessage(err, t));
    }
  };

  const generateSheets = async () => {
    try {
      await updateIdentity.mutateAsync({
        identityId: identity.identity_id,
        data: lookPayload,
      });
      const res = await generate.mutateAsync({
        identityId: identity.identity_id,
        model: imageModel || undefined,
      });
      if (res.ok === false) {
        toast.error(res.error || t("common.error"));
        return;
      }
      task.start({ scope: res.scope, taskId: res.task_id });
    } catch (err) {
      toast.error(backendErrorToastMessage(err, t));
    }
  };

  const toggleRecord = async () => {
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        setRecording(false);
        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        void dataUrlFromBlob(blob)
          .then((dataUrl) =>
            recordVoice.mutateAsync({ identityId: identity.identity_id, dataUrl }),
          )
          .then(() => toast.success(t("characters.lookDesign.voiceSaved")))
          .catch((err) => toast.error(backendErrorToastMessage(err, t)));
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch (err) {
      toast.error(backendErrorToastMessage(err, t));
    }
  };

  const voiceUrl = resolveMediaUrl(identity.voice_url || "");
  const chosen = chosenDetails(look);

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <AssetSlot title={t("characters.lookDesign.mainImage")} url={identity.image_url} featured />
        <AssetSlot title={t("characters.lookDesign.threeView")} url={identity.three_view_url} />
        <AssetSlot title={t("characters.lookDesign.expressionGrid")} url={identity.expression_grid_url} />
        <AssetSlot title={t("characters.lookDesign.closeup")} url={identity.portrait_image_url} />
      </div>
      <p className="text-sm leading-5 text-muted-foreground">{t("characters.lookDesign.keepCharacter")}</p>
      <p className="text-sm leading-5 text-foreground/80">
        {chosen.length > 0 ? chosen.join(" · ") : t("characters.lookDesign.chosenNone")}
      </p>
      <VisualPick
        label={t("characters.lookDesign.expression")}
        options={VISUAL_EXPRESSION}
        selected={look.expression}
        onPick={(value) => pickOne("expression", value)}
      />
      <VisualPick
        label={t("characters.lookDesign.makeup")}
        options={VISUAL_MAKEUP}
        selected={look.makeup}
        onPick={(value) => pickOne("makeup", value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setLook(normalizeLookDesign(identity.look_design));
            setTab("wear");
            setDesignOpen(true);
          }}
        >
          {t("characters.lookDesign.openDesign")}
        </Button>
        <Button size="sm" onClick={() => void generateSheets()} disabled={generate.isPending || task.started}>
          {generate.isPending || task.started ? <Loader2 className="size-3 animate-spin" /> : null}
          {t("characters.lookDesign.generate")}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-white/10 pt-3">
        <span className="text-sm text-foreground">{t("characters.lookDesign.voice")}</span>
        {voiceUrl ? <audio src={voiceUrl} controls className="h-8 max-w-full" /> : (
          <span className="text-sm text-muted-foreground">{t("characters.lookDesign.voiceEmpty")}</span>
        )}
        <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
          <Upload className="size-3" />
          {t("characters.lookDesign.voiceUpload")}
        </Button>
        <Button size="sm" variant="outline" onClick={() => void toggleRecord()}>
          {recording ? <Square className="size-3" /> : <Mic className="size-3" />}
          {recording ? t("characters.lookDesign.voiceStop") : t("characters.lookDesign.voiceRecord")}
        </Button>
        {identity.voice_source === "identity" ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void clearVoice.mutateAsync(identity.identity_id).catch((err) => {
                toast.error(backendErrorToastMessage(err, t));
              })
            }
          >
            <Trash2 className="size-3" />
            {t("characters.lookDesign.voiceClear")}
          </Button>
        ) : null}
        <input
          ref={fileRef}
          type="file"
          accept=".mp3,.wav,.m4a,.aac,.ogg,audio/*"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            void uploadVoice
              .mutateAsync({ identityId: identity.identity_id, file })
              .then(() => toast.success(t("characters.lookDesign.voiceSaved")))
              .catch((err) => toast.error(backendErrorToastMessage(err, t)));
          }}
        />
      </div>

      <Dialog open={designOpen} onOpenChange={setDesignOpen}>
        <DialogContent
          className="gap-0 overflow-hidden rounded-2xl border border-neutral-200 bg-white p-0 text-neutral-900 sm:max-w-xl"
          closeButtonClassName="text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
        >
          <div className="flex items-center justify-between px-5 pt-4">
            <DialogTitle className="text-base font-medium text-neutral-900">
              {t("characters.lookDesign.title")}
            </DialogTitle>
          </div>
          <div className="flex gap-1 overflow-x-auto px-5 pt-3">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={cn(
                  "shrink-0 rounded-full px-3 py-1 text-sm",
                  tab === item.id ? "bg-neutral-900 text-white" : "text-neutral-500 hover:bg-neutral-100",
                )}
              >
                {t(item.labelKey)}
              </button>
            ))}
          </div>
          <div className="max-h-[50vh] overflow-y-auto px-5 py-4">
            {tab === "base" ? (
              <div className="flex flex-col items-center gap-3">
                <AssetSlot title={t("characters.lookDesign.mainImage")} url={identity.image_url} featured />
                <p className="text-center text-sm leading-5 text-neutral-500">
                  {t("characters.lookDesign.keepCharacter")}
                </p>
              </div>
            ) : null}
            {tab === "expression" ? (
              <VisualPick label={t("characters.lookDesign.expression")} options={VISUAL_EXPRESSION} selected={look.expression} onPick={(value) => pickOne("expression", value)} light />
            ) : null}
            {tab === "wear" ? (
              <div className="flex flex-col gap-4">
                <VisualPick label={t("characters.lookDesign.makeup")} options={VISUAL_MAKEUP} selected={look.makeup} onPick={(value) => pickOne("makeup", value)} light />
                <VisualPick label={t("characters.lookDesign.clothing")} options={VISUAL_CLOTHING} selected={look.clothing} onPick={(value) => pickOne("clothing", value)} light />
                <VisualPick label={t("characters.lookDesign.accessories")} options={VISUAL_ACCESSORIES} selected={look.accessories} onPick={pickAccessory} light multiple />
              </div>
            ) : null}
            {tab === "face" ? (
              <div className="flex flex-col gap-4">
                <VisualPick label={t("characters.lookDesign.faceShape")} options={VISUAL_FACE} selected={look.face_shape} onPick={(value) => pickOne("face_shape", value)} light />
                <VisualPick label={t("characters.lookDesign.eyes")} options={VISUAL_EYES} selected={look.eyes} onPick={(value) => pickOne("eyes", value)} light />
                <VisualPick label={t("characters.lookDesign.eyebrows")} options={VISUAL_EYEBROWS} selected={look.eyebrows} onPick={(value) => pickOne("eyebrows", value)} light />
                <VisualPick label={t("characters.lookDesign.nose")} options={VISUAL_NOSE} selected={look.nose} onPick={(value) => pickOne("nose", value)} light />
                <VisualPick label={t("characters.lookDesign.lips")} options={VISUAL_LIPS} selected={look.lips} onPick={(value) => pickOne("lips", value)} light />
              </div>
            ) : null}
            {tab === "body" ? (
              <VisualPick label={t("characters.lookDesign.body")} options={VISUAL_BODY} selected={look.body} onPick={(value) => pickOne("body", value)} light />
            ) : null}
            {tab === "hair" ? (
              <VisualPick label={t("characters.lookDesign.hair")} options={VISUAL_HAIR} selected={look.hair} onPick={(value) => pickOne("hair", value)} light />
            ) : null}
            {tab === "style" ? (
              <VisualPick label={t("characters.lookDesign.style")} options={VISUAL_STYLE} selected={look.style} onPick={(value) => pickOne("style", value)} light />
            ) : null}
          </div>
          <div className="flex justify-end gap-2 border-t border-neutral-100 px-5 py-3">
            <Button type="button" variant="outline" className="border-neutral-200 bg-white text-neutral-700" onClick={() => setDesignOpen(false)}>
              {t("characters.lookDesign.cancel")}
            </Button>
            <Button type="button" className="bg-neutral-900 text-white hover:bg-neutral-800" onClick={() => void save()} disabled={updateIdentity.isPending}>
              {updateIdentity.isPending ? <Loader2 className="size-3 animate-spin" /> : null}
              {t("characters.lookDesign.save")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function chosenDetails(look: IdentityLookDesign): string[] {
  const singles = [
    look.makeup,
    look.clothing,
    look.face_shape,
    look.eyes,
    look.eyebrows,
    look.nose,
    look.lips,
    look.body,
    look.hair,
    look.style,
    look.expression,
  ];
  return [...singles, ...look.accessories].filter((item) => item.length > 0);
}

function AssetSlot({
  title,
  url,
  featured = false,
}: {
  title: string;
  url?: string | null;
  featured?: boolean;
}) {
  const resolved = resolveMediaUrl(url || "");
  return (
    <figure className={cn("overflow-hidden rounded-xl bg-neutral-100", featured && "sm:row-span-1")}>
      {resolved ? (
        <img src={resolved} alt={title} className="aspect-[3/4] w-full object-cover" />
      ) : (
        <div className="flex aspect-[3/4] items-center justify-center text-sm text-neutral-400"> </div>
      )}
      <figcaption className="px-2 py-1 text-center text-xs text-neutral-500">{title}</figcaption>
    </figure>
  );
}
