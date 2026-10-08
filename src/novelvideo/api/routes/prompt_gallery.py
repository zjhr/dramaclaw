# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab

"""提示词画廊搜索接口。"""

from collections.abc import Mapping

from fastapi import APIRouter, Depends

from novelvideo.api.auth import get_api_user
from novelvideo.api.schemas import PromptGallerySearchBody
from novelvideo.prompt_gallery_search import expand_prompt_search

router = APIRouter()


@router.post("/prompt-gallery/ai-search")
async def ai_search_prompt_gallery(
    body: PromptGallerySearchBody,
    user: Mapping[str, object] = Depends(get_api_user),
):
    """把自然语言想法转换成前端本地排序所需的检索意图。"""

    _ = user
    data = await expand_prompt_search(body.query, media_kind=body.media_kind)
    return {"ok": True, "data": data}
