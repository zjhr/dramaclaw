// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { Combobox } from "@base-ui/react/combobox";
import { ChevronDown, Loader2, RotateCw } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useFetchBrainClawModels } from "@/lib/queries/model-gateway";

interface BrainClawModelInputProps {
  value: string;
  onChange: (value: string) => void;
  baseUrl: string;
  apiKey: string;
  savedApiKeyPreview: string;
  disabled?: boolean;
}

/** 模型列表仅绑定当前凭据；切换端点后丢弃旧列表和迟到响应。 */
export function BrainClawModelInput(props: BrainClawModelInputProps) {
  const { t } = useTranslation();
  const fetchModels = useFetchBrainClawModels();
  const [listing, setListing] = useState<{ source: string; models: string[] } | null>(null);
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(true);
  const source = JSON.stringify([props.baseUrl.trim(), props.apiKey.trim(), props.savedApiKeyPreview]);
  const currentSource = useRef(source);
  currentSource.current = source;
  const models = listing?.source === source ? listing.models : [];
  const canFetch = Boolean(props.baseUrl.trim() && (props.apiKey.trim() || props.savedApiKeyPreview));

  const handleFetch = async () => {
    const requestedSource = source;
    try {
      const response = await fetchModels.mutateAsync({
        newApiBaseUrl: props.baseUrl.trim(),
        ...(props.apiKey.trim() ? { newApiApiKey: props.apiKey.trim() } : {}),
      });
      if (currentSource.current !== requestedSource) return;
      if (!response.ok) {
        toast.error(t("settings.modelConfig.brainclaw.fetchModelsFailed"));
        return;
      }
      setListing({ source: requestedSource, models: response.data.models });
      setShowAll(true);
      setOpen(true);
    } catch {
      if (currentSource.current === requestedSource) {
        toast.error(t("settings.modelConfig.brainclaw.fetchModelsFailed"));
      }
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
      <Combobox.Root
        modal={false}
        items={models}
        open={open}
        onOpenChange={(nextOpen) => {
          if (nextOpen) setShowAll(true);
          setOpen(nextOpen);
        }}
        filter={(item, query) => showAll || item.toLowerCase().includes(query.toLowerCase())}
        value={models.includes(props.value) ? props.value : null}
        inputValue={props.value}
        onInputValueChange={(value, details) => {
          if (details.reason === "input-clear") {
            details.cancel();
            return;
          }
          setShowAll(false);
          props.onChange(value);
        }}
        onValueChange={(value) => { if (value !== null) props.onChange(value); }}
        disabled={props.disabled}
      >
        <div className="relative min-w-0 flex-1">
          <Combobox.Input
            id="brainclaw-model"
            name="brainclaw-model"
            placeholder="brainclaw"
            maxLength={256}
            autoCapitalize="none"
            spellCheck={false}
            aria-describedby="brainclaw-model-hint"
            render={<Input className="h-9 pr-8 font-mono" />}
          />
          <Combobox.Trigger
            aria-label={t("settings.modelConfig.channelModels.select")}
            className="absolute inset-y-0 right-0 flex w-8 items-center justify-center rounded-r-md text-muted-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40"
          >
            <ChevronDown className="size-3.5" />
          </Combobox.Trigger>
        </div>
        <Combobox.Portal>
          <Combobox.Positioner sideOffset={4} align="start" className="z-50">
            <Combobox.Popup className="w-(--anchor-width) min-w-48 overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md">
              <Combobox.Empty className="px-3 py-3 text-xs text-muted-foreground" role="status">
                {listing?.source === source
                  ? t("settings.modelConfig.brainclaw.modelsEmpty")
                  : t("settings.modelConfig.brainclaw.modelHint")}
              </Combobox.Empty>
              <Combobox.List className="max-h-56 overflow-y-auto p-1">
                {(model: string) => (
                  <Combobox.Item key={model} value={model} title={model} className="cursor-default truncate rounded px-2 py-1.5 text-xs outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground">
                    {model}
                  </Combobox.Item>
                )}
              </Combobox.List>
            </Combobox.Popup>
          </Combobox.Positioner>
        </Combobox.Portal>
      </Combobox.Root>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-9 shrink-0 text-xs"
        disabled={props.disabled || fetchModels.isPending || !canFetch}
        onClick={() => void handleFetch()}
      >
        {fetchModels.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCw className="size-3.5" />}
        {t("settings.modelConfig.channelModels.fetch")}
        {listing?.source === source ? ` (${models.length})` : ""}
      </Button>
    </div>
  );
}
