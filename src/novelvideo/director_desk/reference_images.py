"""导演台参考画面的真实图像输入：限额校验与三种对话协议的内容块。"""

from __future__ import annotations

import base64
import binascii
from io import BytesIO
from typing import Any, Sequence

from PIL import Image, UnidentifiedImageError

# 只发当前选中的一张画面，避免整组分镜重复占用模型上下文和请求体。
MAX_REFERENCE_IMAGE_BYTES = 2 * 1024 * 1024
MAX_REFERENCE_DATA_URL_CHARS = 2_800_000
_FORMATS = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp", "GIF": "image/gif"}


def normalize_reference_images(images: Sequence[str] | None) -> list[str]:
    """只接收已由浏览器读取的图片字节，不让模型服务自行抓取私有或失效链接。"""
    if images is None:
        return []
    if not isinstance(images, (list, tuple)) or len(images) > 1:
        raise ValueError("每轮只能附上当前选中的一张参考图片")
    result = []
    for data_url in images:
        if not isinstance(data_url, str) or len(data_url) > MAX_REFERENCE_DATA_URL_CHARS:
            raise ValueError("参考图片过大，请缩小图片后重试")
        header, separator, encoded = data_url.partition(",")
        if not separator or header not in {f"data:{mime};base64" for mime in _FORMATS.values()}:
            raise ValueError("参考图片必须是 PNG、JPEG、WebP 或 GIF 的实际图像输入")
        try:
            raw = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise ValueError("参考图片编码无效，请重新读取图片") from exc
        if not raw or len(raw) > MAX_REFERENCE_IMAGE_BYTES:
            raise ValueError("参考图片过大或为空，请缩小图片后重试")
        try:
            with Image.open(BytesIO(raw)) as image:
                if _FORMATS.get(image.format) != header[5:-7]:
                    raise ValueError("参考图片格式与实际内容不一致")
                if image.width * image.height > 16_000_000:
                    raise ValueError("参考图片尺寸过大，请缩小图片后重试")
                image.verify()
        except (OSError, SyntaxError, UnidentifiedImageError, Image.DecompressionBombError) as exc:
            raise ValueError("参考图片无法解码，请重新读取图片") from exc
        result.append(data_url)
    return result


def reference_user_content(protocol: str, text: str, images: Sequence[str] | None) -> str | list[dict[str, Any]]:
    """按目标渠道重建内容块，使切换协议、读取历史后仍真正携带图片。"""
    validated = normalize_reference_images(images)
    if not validated:
        return text
    if protocol == "responses":
        return [{"type": "input_text", "text": text},
                *({"type": "input_image", "image_url": value} for value in validated)]
    if protocol == "anthropic":
        return [{"type": "text", "text": text}, *(
            {"type": "image", "source": {"type": "base64", "media_type": value[5:value.index(";")],
                                          "data": value.split(",", 1)[1]}}
            for value in validated
        )]
    return [{"type": "text", "text": text},
            *({"type": "image_url", "image_url": {"url": value}} for value in validated)]
