#!/usr/bin/env python3
"""白模调参台 —— 独立本地服务（与 DramaClaw 项目系统完全无关）。

刻意不碰的东西：项目数据库、任务队列、项目资产目录、积分/车道、鉴权。
只做一件事：收本地视频 + 调参 JSON -> 跑白模管线 -> 回传 mp4。

视频与产物全部落在系统临时目录的 greybox_tuner/ 下
（macOS 为 /var/folders/.../T/greybox_tuner/，Linux 为 /tmp/greybox_tuner/），
服务重启即忘，与项目数据零交集。

用法：
    ./.venv/bin/python scripts/greybox_tuner.py [--port 8790]
然后浏览器打开 http://localhost:8790/ （页面由本服务同源托管，无 CORS）。
"""

from __future__ import annotations

import argparse
import shutil
import tempfile
import uuid
from pathlib import Path

import uvicorn
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import FileResponse, HTMLResponse

WORK_DIR = Path(tempfile.gettempdir()) / "greybox_tuner"
UPLOAD_DIR = WORK_DIR / "uploads"
OUTPUT_DIR = WORK_DIR / "outputs"

# 调参台页面：项目前端里的静态单文件。独立服务直接同源托管它，
# 这样页面改字段不用动服务（刷新即可）。
TUNER_PAGE = (
    Path(__file__).resolve().parent.parent / "frontend" / "public" / "greybox-tuner.html"
)

# 参数白名单：只透传这些键给 runner，其余忽略（防手滑传入怪字段炸管线）。
ALLOWED_PARAMS = {
    "fps",
    "fov_deg",
    "ambient",
    "base_grey",
    "outline",
    "invert",
    "gamma",
    "smooth",
    "fill_strength",
    "temporal_window",
    "backend",
    "shade",
    "device_name",
}

app = FastAPI(title="greybox-tuner", docs_url=None, redoc_url=None)


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    if TUNER_PAGE.exists():
        return TUNER_PAGE.read_text(encoding="utf-8")
    return "<h1>greybox-tuner</h1><p>tuner page not found</p>"


@app.post("/api/greybox")
async def run_greybox(
    file: UploadFile = File(...),
    params: str = Form("{}"),
) -> FileResponse:
    """收视频 + 参数 JSON，同步跑完整管线，直接回传 mp4 文件。

    同步（非任务队列）是刻意的：单人调参一次只跑一个，阻塞等待最直观，
    也不需要项目那套 task_state/SSE 机制。
    """
    import json

    from novelvideo.freezone.jobs import run_freezone_video_greybox

    try:
        raw = json.loads(params)
        if not isinstance(raw, dict):
            raise ValueError("params must be a JSON object")
    except (ValueError, TypeError) as exc:
        raise ValueError(f"bad params json: {exc}") from exc
    kwargs = {k: v for k, v in raw.items() if k in ALLOWED_PARAMS}

    job_id = uuid.uuid4().hex[:12]
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    src = UPLOAD_DIR / f"{job_id}_{file.filename or 'input.mp4'}"
    with src.open("wb") as fh:
        shutil.copyfileobj(file.file, fh)

    # project_dir 用一个临时空目录：outputs_dir 会自建产物结构，
    # 渲染过程完全不读项目数据。
    proj_dir = WORK_DIR / "proj"
    proj_dir.mkdir(parents=True, exist_ok=True)
    out, meta = await run_freezone_video_greybox(
        project_dir=proj_dir,
        job_id=job_id,
        source_path=str(src),
        **kwargs,
    )
    return FileResponse(
        out,
        media_type="video/mp4",
        filename=f"greybox-{job_id}.mp4",
        headers={"X-Greybox-Meta": json.dumps(meta, ensure_ascii=False)},
    )


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"ok": "greybox-tuner"}


def main() -> None:
    parser = argparse.ArgumentParser(description="greybox tuner standalone server")
    parser.add_argument("--port", type=int, default=8790)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    print(f"greybox tuner -> http://{args.host}:{args.port}/", flush=True)
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
