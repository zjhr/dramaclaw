// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/** 识图副本限额与失败边界；真实像素和跨层请求另由浏览器与后端验收。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareDirectorReferenceImage } from '@/features/canvas/application/directorReferenceImage';

const load = vi.hoisted(() => vi.fn<(source: string) => Promise<HTMLImageElement>>());
vi.mock('@/features/canvas/application/imageData', () => ({ loadImageElement: load }));
const jpeg = 'data:image/jpeg;base64,prepared';
const frame = (width: number, height: number) => ({ naturalWidth: width, naturalHeight: height }) as HTMLImageElement;

beforeEach(() => { load.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('导演台识图副本', () => {
  it.each([[2560, 1280, 1280, 640], [640, 2560, 320, 1280], [300, 200, 300, 200]])(
    '图片%d×%d保留比例转成%d×%d，不放大小图', async (width, height, expectedWidth, expectedHeight) => {
      const image = frame(width, height);
      load.mockResolvedValue(image);
      const context = { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() };
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
      const encode = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(jpeg);
      expect(await prepareDirectorReferenceImage('/upstream-original.png')).toBe(jpeg);
      expect(load).toHaveBeenCalledWith('/upstream-original.png');
      const canvas = encode.mock.instances[0] as HTMLCanvasElement;
      expect([canvas.width, canvas.height]).toEqual([expectedWidth, expectedHeight]);
      expect(context.fillStyle).toBe('#fff');
      expect(context.drawImage).toHaveBeenCalledWith(image, 0, 0, expectedWidth, expectedHeight);
      expect([image.naturalWidth, image.naturalHeight]).toEqual([width, height]);
    },
  );

  it('不可用画面或超大的转换结果须显式失败', async () => {
    load.mockResolvedValue(frame(0, 0));
    await expect(prepareDirectorReferenceImage('/empty')).rejects.toThrow('没有有效画面');
    load.mockResolvedValue(frame(8, 4));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ fillRect: vi.fn(), drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    const encode = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:,');
    await expect(prepareDirectorReferenceImage('/invalid')).rejects.toThrow('无法转换');
    encode.mockReturnValue(jpeg + 'a'.repeat(2_800_000));
    await expect(prepareDirectorReferenceImage('/huge')).rejects.toThrow('过大');
  });

  it('15秒内未读到图像则失败，不无限显示正在请求', async () => {
    vi.useFakeTimers();
    load.mockImplementation(() => new Promise(() => undefined));
    const pending = prepareDirectorReferenceImage('/unreachable.png');
    const rejected = expect(pending).rejects.toThrow('参考图片读取超时');
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});
