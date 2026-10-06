// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { loadImageElement } from './imageData';

/** 识图副本控制在请求体限额以内；保留上游原图，仅向模型发送当前选中画面。 */
export async function prepareDirectorReferenceImage(source: string): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const image = await Promise.race([
      loadImageElement(source),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('参考图片读取超时，请检查图片后重试')), 15_000);
      }),
    ]);
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('参考图片没有有效画面');
    const scale = Math.min(1, 1280 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法读取参考图片，请重试');
    // JPEG 不支持透明度，以白色衬底保留透明图中人物与道具的可辨轮廓。
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.86);
    if (!dataUrl.startsWith('data:image/jpeg;base64,') || dataUrl.length > 2_800_000) {
      throw new Error('参考图片过大或无法转换，请缩小图片后重试');
    }
    return dataUrl;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
