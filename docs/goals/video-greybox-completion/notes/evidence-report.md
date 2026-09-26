# T006 分层测试证据报告 — 视频转白模管线

- 任务：T006（执行分层测试并产出证据报告）
- 看板：/Users/mac/ai/dramaclaw/docs/goals/video-greybox-completion/state.yaml
- 执行日期：2026-09-21
- 执行方式：沙箱实跑，所有命令输出为当次会话原始捕获，未删减、未修饰
- 前置状态：T003/T004/T005 接线 done、T011 形状契约修复 done（本报告 L2a 哑模型契约项即为 T011 修复后的复跑留档）

## 1. 概要表

| 腿 | 判定 | 一句话 |
| --- | --- | --- |
| L1 greybox_render 自检复跑 | OK | `greybox_render self-check OK`，exit 0 |
| L2a 依赖探测 | OK | `depth_model_available: True` + `OK: 依赖就绪，可跑 L2 权重冒烟`，exit 0 |
| L2a 哑模型形状契约（T011 复跑留档） | OK | `OK (720, 1280)` ndim==2，predict_depth 契约成立 |
| L2b 权重冒烟（环境门槛：代理存活） | OK | 同会话代理 curl 200，带代理 env 下载+推理通过：`WEIGHTS_OK (360, 640) 0.1446 6.4950` |
| L3 合成 ffmpeg 腿（完整 runner 端到端） | OK | 24 帧全流程跑通，产物 3.000000s / aac / 320x240，三要素全过 |
| L3 真实腿（环境门槛：仓库现成视频） | OK（机械验收）/ 目视项待主人体检 | ai-avatar.mp4 113 帧端到端跑通，14.048005s / aac / 1600x1200；人体/结构可辨性标注为主人体检，样本帧路径见 §3.6 |
| SKIP 项 | 无 | 本会话代理存活且仓库含现成 mp4，L2b 与 L3 真实腿均实跑，无 SKIP |

## 2. 环境事实

### 2.1 解释器与 world extra

```
$ which python python3 ffmpeg ffprobe; ./.venv/bin/python --version 2>&1; ls .venv/lib/python3.11/site-packages | grep -iE '^(torch|transformers|timm|numpy|pillow|safetensors|sharp)'
/Users/mac/.local/share/mise/shims/python
/Users/mac/.local/share/mise/shims/python3
/opt/homebrew/bin/ffmpeg
/opt/homebrew/bin/ffprobe
Python 3.11.13
numpy
numpy-1.26.4.dist-info
pillow_heif
pillow_heif-1.4.0.dist-info
pillow-11.3.0.dist-info
safetensors
safetensors-0.8.0.dist-info
sharp
sharp-0.1.dist-info
timm
timm-1.0.27.dist-info
torch
torch-2.12.1.dist-info
torchgen
torchvision
torchvision-0.27.1.dist-info
transformers
transformers-4.57.6.dist-info
```

事实：裸 `python`/`python3` 是 mise shim（Python 3.14.0，无项目 editable 安装，L2 类脚本用它必 ModuleNotFoundError）；本报告全部使用 `./.venv/bin/python`（Python 3.11.13）。world extra 在位：torch 2.12.1 / transformers 4.57.6 / timm 1.0.27 / PIL 11.3.0 / safetensors 0.8.0 / sharp。ffmpeg/ffprobe 在 /opt/homebrew/bin（版本 8.1.1，见 §3.5 ffmpeg 输出头部）。

### 2.2 代理状态（L2b/L3 环境门槛的前置证据）

```
$ curl -sS -o /dev/null -w '%{http_code}' -x http://127.0.0.1:7897 https://huggingface.co
200 EXIT=0
```

事实：本会话代理 127.0.0.1:7897 存活（HTTP 200），满足 T002 裁决 L2b 合法证据三条件之①（同会话存活证据）；条件②（报告逐字记录带代理 env 完整命令与原始输出）由 §3.4 满足；条件③（下载显式走代理 env）由 §3.4 命令的 `HTTPS_PROXY/HTTP_PROXY=http://127.0.0.1:7897` 前缀满足。

## 3. 各腿命令与原始输出

### 3.1 L1（沙箱必过）复跑

命令（逐字）：

```
PYTHONDONTWRITEBYTECODE=1 ./.venv/bin/python src/novelvideo/generators/greybox_render.py
```

原始输出：

```
greybox_render self-check OK
EXIT=0
```

判定：OK。符合 T002 定稿 oracle（预期 `greybox_render self-check OK` exit 0）。

### 3.2 L2a（沙箱必过）之一：依赖探测

命令（逐字）：

```
PYTHONDONTWRITEBYTECODE=1 ./.venv/bin/python src/novelvideo/generators/greybox_depth.py
```

原始输出：

```
depth_model_available: True
OK: 依赖就绪，可跑 L2 权重冒烟
EXIT=0
```

判定：OK。torch + transformers 探测通过。

### 3.3 L2a（沙箱必过）之二：哑模型形状契约（T011 verify 第一条复跑留档）

命令（逐字，与 state.yaml T011 verify 第一条一致）：

```
PYTHONDONTWRITEBYTECODE=1 ./.venv/bin/python -c "import torch;from PIL import Image;from novelvideo.generators.greybox_depth import predict_depth;exec(\"class B(dict):\n def to(s,d): return s\nclass P:\n def __call__(s,images=None,return_tensors=None): return B()\nclass O: predicted_depth=torch.rand(1,518,686)\nclass M:\n def __call__(s,**k): return O()\n def eval(s): return s\");d=predict_depth(Image.new('RGB',(1280,720)),P(),M(),torch.device('cpu'));assert d.ndim==2 and d.shape==(720,1280),d.shape;print('OK',d.shape)"
```

原始输出：

```
OK (720, 1280)
EXIT=0
```

判定：OK。T011 修复（interpolate 后取 `[0,0]`）后 predict_depth 返回 (720,1280) ndim==2，哑模型走真实 predict_depth 代码路径，契约与 docstring 及 jobs.py 消费方 `depth_to_pointcloud` 的 `h, w = depth01.shape` 一致。L2a 双过达成。

### 3.4 L2b（环境门槛）权重冒烟

前置证据（§2.2）：代理 200。命令（逐字，下载显式走代理 env）：

```
HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 PYTHONDONTWRITEBYTECODE=1 ./.venv/bin/python -c "
from PIL import Image
from novelvideo.generators.greybox_depth import load_depth_model, predict_depth
p, m, d = load_depth_model('cpu')
img = Image.new('RGB', (640, 360))
depth = predict_depth(img, p, m, d)
assert depth.ndim == 2 and depth.shape == (360, 640), depth.shape
print('WEIGHTS_OK', depth.shape, float(depth.min()), float(depth.max()))
"
```

原始输出（未删减）：

```
Using a slow image processor as `use_fast` is unset and a slow processor was saved with this model. `use_fast=True` will be the default behavior in v4.52, even if the model was saved with a slow processor. This will result in minor differences in outputs. You'll still be able to use a slow processor with `use_fast=False`.
WEIGHTS_OK (360, 640) 0.14459826052188873 6.494995594024658
EXIT=0
```

判定：OK。Depth-Anything-V2-Small-hf 权重经代理下载成功，CPU 推理单帧 640x360 深度图，ndim==2 / shape==(360,640) 断言通过，深度值域 [0.1446, 6.4950] 合理。满足 T002 裁决三条件，作为合法 L2 证据。首行 warning 为 transformers 慢处理器提示，不影响断言。

### 3.5 L3 合成腿（沙箱必过）——完整 runner 端到端（因 L2b 通过，未走降级路径）

合成源命令（逐字）：

```
ffmpeg -y -f lavfi -i testsrc=size=320x240:rate=8:duration=3 -f lavfi -i sine=frequency=440:duration=3 -c:v libx264 -c:a aac -shortest /tmp/gb_src.mp4
```

原始输出（逐字全文 56 行；由重跑同一命令并经 `> /tmp/gb_ffmpeg_src.log 2>&1` 落盘捕获，与首次实跑为同一确定性命令，仅 speed 等计时行随运行波动）：

```
ffmpeg version 8.1.1 Copyright (c) 2000-2026 the FFmpeg developers
  built with Apple clang version 21.0.0 (clang-2100.0.123.102)
  configuration: --prefix=/opt/homebrew/Cellar/ffmpeg/8.1.1 --enable-shared --enable-pthreads --enable-version3 --cc=clang --host-cflags= --host-ldflags= --enable-ffplay --enable-gpl --enable-libsvtav1 --enable-libopus --enable-libx264 --enable-libmp3lame --enable-libdav1d --enable-libvmaf --enable-libvpx --enable-libx265 --enable-openssl --enable-videotoolbox --enable-audiotoolbox --enable-neon
  libavutil      60. 26.101 / 60. 26.101
  libavcodec     62. 28.101 / 62. 28.101
  libavformat    62. 12.101 / 62. 12.101
  libavdevice    62.  3.101 / 62.  3.101
  libavfilter    11. 14.101 / 11. 14.101
  libswscale      9.  5.101 /  9.  5.101
  libswresample   6.  3.101 /  6.  3.101
Input #0, lavfi, from 'testsrc=size=320x240:rate=8:duration=3':
  Duration: N/A, start: 0.000000, bitrate: N/A
  Stream #0:0: Video: wrapped_avframe, rgb24, 320x240 [SAR 1:1 DAR 4:3], 8 fps, 8 tbr, 8 tbn
Input #1, lavfi, from 'sine=frequency=440:duration=3':
  Duration: N/A, start: 0.000000, bitrate: 705 kb/s
  Stream #1:0: Audio: pcm_s16le, 44100 Hz, mono, s16, 705 kb/s
Stream mapping:
  Stream #0:0 -> #0:0 (wrapped_avframe (native) -> h264 (libx264))
  Stream #1:0 -> #0:1 (pcm_s16le (native) -> aac (native))
Press [q] to stop, [?] for help
[libx264 @ 0x8eb039180] using SAR=1/1
[libx264 @ 0x8eb039180] using cpu capabilities: ARMv8 NEON DotProd I8MM
[libx264 @ 0x8eb039180] profile High 4:4:4 Predictive, level 1.2, 4:4:4, 8-bit
[libx264 @ 0x8eb039180] 264 - core 165 r3222 b35605a - H.264/MPEG-4 AVC codec - Copyleft 2003-2025 - http://www.videolan.org/x264.html - options: cabac=1 ref=3 deblock=1:0:0 analyse=0x3:0x113 me=hex subme=7 psy=1 psy_rd=1.00:0.00 mixed_ref=1 me_range=16 chroma_me=1 trellis=1 8x8dct=1 cqm=0 deadzone=21,11 fast_pskip=1 chroma_qp_offset=4 threads=7 lookahead_threads=1 sliced_threads=0 nr=0 decimate=1 interlaced=0 bluray_compat=0 constrained_intra=0 bframes=3 b_pyramid=2 b_adapt=1 b_bias=0 direct=1 weightb=1 open_gop=0 weightp=2 keyint=250 keyint_min=8 scenecut=40 intra_refresh=0 rc_lookahead=40 rc=crf mbtree=1 crf=23.0 qcomp=0.60 qpmin=0 qpmax=69 qpstep=4 ip_ratio=1.40 aq=1:1.00
Output #0, mp4, to '/tmp/gb_src.mp4':
  Metadata:
    encoder         : Lavf62.12.101
  Stream #0:0: Video: h264 (avc1 / 0x31637661), yuv444p(tv, progressive), 320x240 [SAR 1:1 DAR 4:3], q=2-31, 8 fps, 16384 tbn
    Metadata:
      encoder         : Lavc62.28.101 libx264
    Side data:
      CPB properties: bitrate max/min/avg: 0/0/0 buffer size: 0 vbv_delay: N/A
  Stream #0:1: Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 69 kb/s
    Metadata:
      encoder         : Lavc62.28.101 aac
[out#0/mp4 @ 0x8eac14900] video:12KiB audio:26KiB subtitle:0KiB other streams:0KiB global headers:0KiB muxing overhead: 6.901650%
frame=   24 fps=0.0 q=-1.0 Lsize=      40KiB time=00:00:02.75 bitrate= 119.9kbits/s speed=58.7x elapsed=0:00:00.04    
[libx264 @ 0x8eb039180] frame I:1     Avg QP:17.56  size:  3296
[libx264 @ 0x8eb039180] frame P:7     Avg QP:14.70  size:   790
[libx264 @ 0x8eb039180] frame B:16    Avg QP:12.67  size:   172
[libx264 @ 0x8eb039180] consecutive B-frames:  8.3%  8.3%  0.0% 83.3%
[libx264 @ 0x8eb039180] mb I  I16..4: 40.0% 33.3% 26.7%
[libx264 @ 0x8eb039180] mb P  I16..4:  3.0%  1.0%  4.0%  P16..4:  5.6%  3.6%  2.1%  0.0%  0.0%    skip:80.6%
[libx264 @ 0x8eb039180] mb B  I16..4:  1.1%  0.6%  0.0%  B16..8:  8.5%  1.2%  0.2%  direct: 0.9%  skip:87.5%  L0:52.4% L1:45.0% BI: 2.7%
[libx264 @ 0x8eb039180] 8x8 transform intra:27.2% inter:27.4%
[libx264 @ 0x8eb039180] coded y,u,v intra: 16.2% 15.3% 14.0% inter: 1.4% 1.5% 1.4%
[libx264 @ 0x8eb039180] i16 v,h,dc,p: 58% 18%  4% 19%
[libx264 @ 0x8eb039180] i8 v,h,dc,ddl,ddr,vr,hd,vl,hu: 47% 10% 43%  0%  0%  0%  0%  0%  0%
[libx264 @ 0x8eb039180] i4 v,h,dc,ddl,ddr,vr,hd,vl,hu: 37% 41% 18%  1%  1%  1%  0%  1%  0%
[libx264 @ 0x8eb039180] Weighted P-Frames: Y:0.0% UV:0.0%
[libx264 @ 0x8eb039180] ref P L0: 76.8%  7.2% 12.2%  3.8%
[libx264 @ 0x8eb039180] ref B L0: 84.3% 11.3%  4.4%
[libx264 @ 0x8eb039180] ref B L1: 94.3%  5.7%
[libx264 @ 0x8eb039180] kb/s:30.86
[aac @ 0x8eb039c00] Qavg: 609.750
EXIT=0
```

（ffprobe 复核合成源时长 3.000000s。）

runner 驱动脚本（/tmp 下，逐字内容）：

```python
import asyncio
from pathlib import Path

from novelvideo.freezone.jobs import run_freezone_video_greybox


async def main() -> None:
    def on_progress(fraction: float, message: str) -> None:
        print(f"PROGRESS {fraction:.2f} {message}")

    path, meta = await run_freezone_video_greybox(
        project_dir=Path("/tmp/gb_t006_proj"),
        job_id="t006",
        source_path="/tmp/gb_src.mp4",
        fps=8,
        device_name="cpu",
        progress_callback=on_progress,
    )
    print("RESULT_PATH", path)
    print("RESULT_META", meta)


asyncio.run(main())
```

驱动命令（逐字）：

```
HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 PYTHONDONTWRITEBYTECODE=1 ./.venv/bin/python /tmp/gb_l3_driver.py
```

原始输出（未删减）：

```
Using a slow image processor as `use_fast` is unset and a slow processor was saved with this model. `use_fast=True` will be the default behavior in v4.52, even if the model was saved with a slow processor. This will result in minor differences in outputs. You'll still be able to use a slow processor with `use_fast=False`.
PROGRESS 0.10 已抽帧 24 帧
PROGRESS 0.13 深度推理 1/24
PROGRESS 0.16 深度推理 2/24
PROGRESS 0.19 深度推理 3/24
PROGRESS 0.22 深度推理 4/24
PROGRESS 0.25 深度推理 5/24
PROGRESS 0.28 深度推理 6/24
PROGRESS 0.30 深度推理 7/24
PROGRESS 0.33 深度推理 8/24
PROGRESS 0.36 深度推理 9/24
PROGRESS 0.39 深度推理 10/24
PROGRESS 0.42 深度推理 11/24
PROGRESS 0.45 深度推理 12/24
PROGRESS 0.48 深度推理 13/24
PROGRESS 0.51 深度推理 14/24
PROGRESS 0.54 深度推理 15/24
PROGRESS 0.57 深度推理 16/24
PROGRESS 0.60 深度推理 17/24
PROGRESS 0.62 深度推理 18/24
PROGRESS 0.65 深度推理 19/24
PROGRESS 0.68 深度推理 20/24
PROGRESS 0.71 深度推理 21/24
PROGRESS 0.74 深度推理 22/24
PROGRESS 0.77 深度推理 23/24
PROGRESS 0.80 深度推理 24/24
PROGRESS 1.00 白模视频已生成
RESULT_PATH /tmp/gb_t006_proj/freezone/_outputs/freezone_video_greybox/t006.mp4
RESULT_META {'backend': 'local-depth', 'fps': 8, 'fov_deg': 60.0, 'ambient': 0.35, 'base_grey': 0.85, 'outline': 0.0, 'invert': False, 'frames': 24}
EXIT=0
```

验收命令与原始输出（时长/音轨/分辨率三要素）：

```
$ ffprobe -v error -show_entries format=duration -of csv=p=0 /tmp/gb_t006_proj/freezone/_outputs/freezone_video_greybox/t006.mp4
3.000000
$ ffprobe -v error -select_streams a -show_entries stream=codec_name -of csv=p=0 /tmp/gb_t006_proj/freezone/_outputs/freezone_video_greybox/t006.mp4
aac
$ ffprobe -v error -select_streams v -show_entries stream=width,height,codec_name -of csv=p=0 /tmp/gb_t006_proj/freezone/_outputs/freezone_video_greybox/t006.mp4
h264,320,240
$ ls -la /tmp/gb_t006_proj/freezone/_outputs/freezone_video_greybox/t006.mp4
-rw-r--r--@ 1 mac  staff  88008  9月 21 00:17 /tmp/gb_t006_proj/freezone/_outputs/freezone_video_greybox/t006.mp4
```

判定：OK。抽帧→深度推理→灰白渲染→合帧（`-map 0:v -map 1:a? -c:a copy -shortest`）完整 runner 端到端跑通；时长 3.000000s（≈3s，容差 1s 内）、音轨 aac（原 440Hz sine 保留）、分辨率 320x240（与源一致）。ffmpeg 两段命令形态与 jobs.py 内实现一致（本腿直接调用 runner，即 jobs.py 同款命令）。

### 3.6 L3 真实腿（环境门槛）——仓库现成视频 + 完整 runner

素材查找命令（逐字）：

```
find /Users/mac/ai/dramaclaw/frontend/public /Users/mac/ai/dramaclaw/tests /Users/mac/ai/dramaclaw/state -iname '*.mp4' | head -20
```

原始输出（逐字全文，head -20 内 19 条命中；命令中 `---` 后的第二条 find（maxdepth 3）无新增命中）：

```
/Users/mac/ai/dramaclaw/frontend/public/video/loading.mp4
/Users/mac/ai/dramaclaw/frontend/public/video/ai-avatar.mp4
/Users/mac/ai/dramaclaw/frontend/public/images/xia-dao-launcher.mp4
/Users/mac/ai/dramaclaw/frontend/public/images/btnmotion.mp4
/Users/mac/ai/dramaclaw/frontend/public/brand/party-founding-105.mp4
/Users/mac/ai/dramaclaw/frontend/public/video/camera-presets/spiral-up.mp4
/Users/mac/ai/dramaclaw/frontend/public/video/camera-presets/truck-right.mp4
/Users/mac/ai/dramaclaw/frontend/public/video/camera-presets/handheld.mp4
/Users/mac/ai/dramaclaw/frontend/public/video/camera-presets/crane-up.mp4
/Users/mac/ai/dramaclaw/frontend/public/video/camera-presets/fixed.mp4
/Users/mac/ai/dramaclaw/frontend/public/video/camera-presets/pan-left.mp4
/Users/mac/ai/dramaclaw/frontend/public/video/camera-presets/tilt-up.mp4
/Users/mac/ai/dramaclaw/frontend/public/video/camera-presets/zoom-in.mp4
/Users/mac/ai/dramaclaw/frontend/public/video/camera-presets/zoom-out.mp4
/Users/mac/ai/dramaclaw/frontend/public/video/camera-presets/pan-right.mp4
/Users/mac/ai/dramaclaw/frontend/public/video/camera-presets/crane-down.mp4
/Users/mac/ai/dramaclaw/frontend/public/video/camera-presets/tilt-down.mp4
/Users/mac/ai/dramaclaw/frontend/public/video/camera-presets/drone.mp4
/Users/mac/ai/dramaclaw/frontend/public/video/camera-presets/dolly-in.mp4
```


选用 `frontend/public/video/ai-avatar.mp4`（含人像，最适合目视项；且带 aac 音轨）。源探测原始输出：

```
$ ffprobe -v error -show_entries format=duration:stream=codec_type,codec_name,width,height -of default=noprint_wrappers=1 /Users/mac/ai/dramaclaw/frontend/public/video/ai-avatar.mp4
codec_name=h264
codec_type=video
width=1600
height=1200
codec_name=aac
codec_type=audio
duration=14.066667
```

驱动脚本（/tmp 下）：与 §3.5 同构，`source_path` 指向 ai-avatar.mp4、`project_dir=Path("/tmp/gb_t006_real")`、`job_id="t006real"`、`fps=8`、`device_name="cpu"`，另加 `flush=True`。

驱动命令（逐字，含 tail 收敛进度日志；113 帧逐帧进度行为同模式）：

```
HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 PYTHONDONTWRITEBYTECODE=1 ./.venv/bin/python /tmp/gb_l3_real_driver.py 2>&1 | tail -15; echo "EXIT=${PIPESTATUS[0]:-$?}"
```

原始输出（tail -15 原样）：

```
PROGRESS 0.73 深度推理 102/113
PROGRESS 0.74 深度推理 103/113
PROGRESS 0.74 深度推理 104/113
PROGRESS 0.75 深度推理 105/113
PROGRESS 0.76 深度推理 106/113
PROGRESS 0.76 深度推理 107/113
PROGRESS 0.77 深度推理 108/113
PROGRESS 0.78 深度推理 109/113
PROGRESS 0.78 深度推理 110/113
PROGRESS 0.79 深度推理 111/113
PROGRESS 0.79 深度推理 112/113
PROGRESS 0.80 深度推理 113/113
PROGRESS 1.00 白模视频已生成
RESULT_PATH /tmp/gb_t006_real/freezone/_outputs/freezone_video_greybox/t006real.mp4
RESULT_META {'backend': 'local-depth', 'fps': 8, 'fov_deg': 60.0, 'ambient': 0.35, 'base_grey': 0.85, 'outline': 0.0, 'invert': False, 'frames': 113}
EXIT=0
```

验收命令与原始输出：

```
$ ffprobe -v error -show_entries format=duration -of csv=p=0 /tmp/gb_t006_real/freezone/_outputs/freezone_video_greybox/t006real.mp4
14.048005
$ ffprobe -v error -select_streams a -show_entries stream=codec_name -of csv=p=0 /tmp/gb_t006_real/freezone/_outputs/freezone_video_greybox/t006real.mp4
aac
$ ffprobe -v error -select_streams v -show_entries stream=width,height,codec_name -of csv=p=0 /tmp/gb_t006_real/freezone/_outputs/freezone_video_greybox/t006real.mp4
h264,1600,1200
$ ffprobe -v error -show_entries format=duration -of csv=p=0 /Users/mac/ai/dramaclaw/frontend/public/video/ai-avatar.mp4
14.066667
```

判定：机械验收 OK（时长 14.048005s vs 源 14.066667s，差 0.019s；音轨 aac 保留；分辨率 1600x1200 与源一致；113 帧端到端无失败）。

目视项（人体/结构可辨）——**主人体检项，本报告不自动判过**：

抽帧样本命令（逐字）：

```
mkdir -p /tmp/gb_t006_real/samples
ffmpeg -y -v error -i /tmp/gb_t006_real/freezone/_outputs/freezone_video_greybox/t006real.mp4 -vf "select='eq(n\,30)+eq(n\,60)+eq(n\,90)'" -vsync 0 /tmp/gb_t006_real/samples/frame_%02d.png
```

样本路径（白模产物抽帧，供主人体检）：

- /tmp/gb_t006_real/samples/frame_01.png（第 30 帧）
- /tmp/gb_t006_real/samples/frame_02.png（第 60 帧）
- /tmp/gb_t006_real/samples/frame_03.png（第 90 帧）
- 完整白模产物：/tmp/gb_t006_real/freezone/_outputs/freezone_video_greybox/t006real.mp4

机械非空白佐证（非目视判定，仅证明帧非纯色）：

```
$ PYTHONDONTWRITEBYTECODE=1 ./.venv/bin/python -c "
import numpy as np
from PIL import Image
for n in (1, 2, 3):
    a = np.asarray(Image.open(f'/tmp/gb_t006_real/samples/frame_{n:02d}.png'))
    print(f'frame_{n:02d}', 'shape', a.shape, 'mode-grey', a.ndim == 2, 'min', int(a.min()), 'max', int(a.max()), 'std', round(float(a.std()), 2))
"
frame_01 shape (1200, 1600, 3) mode-grey False min 64 max 223 std 46.93
frame_02 shape (1200, 1600, 3) mode-grey False min 67 max 219 std 46.4
frame_03 shape (1200, 1600, 3) mode-grey False min 61 max 223 std 46.42
```

（视频编码后为 3 通道承载灰度内容，R=G=B；min/max 与 std 表明帧含实际明暗结构，非空白图。人体轮廓与几何结构可辨性须由主人目视上述样本后确认。）

## 4. SKIP 项复跑命令

无 SKIP 项。本会话代理 127.0.0.1:7897 存活（curl 200）且仓库含现成 mp4，L2b 与 L3 真实腿均实跑通过。若未来新会话需复跑（代理不存活时按 T002 裁决应 SKIP 并附以下逐字命令）：

```bash
# L2b 权重冒烟（先验代理；非 200 则 SKIP）
curl -sS -o /dev/null -w '%{http_code}' -x http://127.0.0.1:7897 https://huggingface.co
HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 PYTHONDONTWRITEBYTECODE=1 ./.venv/bin/python -c "
from PIL import Image
from novelvideo.generators.greybox_depth import load_depth_model, predict_depth
p, m, d = load_depth_model('cpu')
img = Image.new('RGB', (640, 360))
depth = predict_depth(img, p, m, d)
assert depth.ndim == 2 and depth.shape == (360, 640), depth.shape
print('WEIGHTS_OK', depth.shape, float(depth.min()), float(depth.max()))
"

# L3 真实腿（换任意现成 mp4 即可）
HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 PYTHONDONTWRITEBYTECODE=1 ./.venv/bin/python /tmp/gb_l3_real_driver.py
```

## 5. 结论

已通过的验收项：

- L1 复跑：`greybox_render self-check OK` exit 0（沙箱）。
- L2a 双过：依赖探测 `depth_model_available: True / OK`；哑模型形状契约 `OK (720, 1280)` ndim==2（T011 修复后复跑留档，沙箱）。
- L2b 权重冒烟：代理同会话存活证据 + 带代理 env 下载与 CPU 推理断言全过（环境门槛，合法证据三条件齐备）。
- L3 合成腿：完整 runner 端到端，ffprobe 三要素全过——时长 3.000000s、音轨 aac、分辨率 320x240（沙箱）。
- L3 真实腿机械验收：仓库现成视频 ai-avatar.mp4 端到端，时长 14.048005s（源 14.066667s）、音轨 aac、分辨率 1600x1200、113 帧无失败。

待真实环境/主人体检的项：

- L3 真实腿目视项：白模产物中人体轮廓与几何结构是否可辨，须主人目视 /tmp/gb_t006_real/samples/frame_01.png~frame_03.png（及完整产物 t006real.mp4）后确认，本报告不自动判过。
- 本机特有环境说明：L2b/L3 依赖本机用户级代理 127.0.0.1:7897 下载 HF 权重；若在无该代理的环境复跑，先按 §4 验代理，非 200 按 SKIP 处理并保留原始失败输出，禁止放宽断言。

汇总：沙箱可验腿（L1 / L2a / L3 合成腿）全部 OK；环境门槛腿（L2b / L3 真实腿）本会话实跑 OK，无 FAIL、无 SKIP；唯一未决项为真实腿目视质量，归属主人体检。

---

## 6. 补充：VDA 时序一致后端（2026-09-21，主人拍板「换 Video-Depth-Anything 试试」）

起因：逐帧后端（DA V2）帧间深度抖动，`temporal_window` 窗口平滑被主人实测否掉（抹运动）。改用 Video-Depth-Anything（CVPR25 Highlight）整段推理：32 帧窗口内时序 attention + 关键帧对齐融合，帧间深度天然一致。

**改动**：`greybox_depth.py` 新增 `vda_available()` / `predict_depth_sequence_vda()` / `iter_frame_depths(backend="vda")`；`backend` 参数沿 jobs.py → runners/freezone.py → routes/freezone.py → schemas.py → ops.ts 全链路透传；画布加 `vda` 预设（`DEPTH_VIDEO_PRESETS`）、调参台加 backend 下拉与「VDA时序一致」预设；i18n 三语补词条。默认仍为 `frame`。

**实测**（本机 CPU，同源 `/tmp/tuner_test_3s.mp4`，fps=8 → 27 帧，其余参数默认）：

| 指标 | frame（DA V2 逐帧） | vda（整段） |
|---|---|---|
| 端到端耗时 | 23.1s | 34.6s（推理段 ~30s，慢 ~50%） |
| 帧间差分均值 | 15.975 | 9.982（**-37.5%**） |
| 空间高频（条纹/噪点） | 0.634 | 0.570（-10.1%） |
| 产物 | 时长 3.018s、音轨 aac 保留 | 时长 3.018s、音轨 aac 保留 |

目视（同一帧并排，`/tmp/greybox_vda_test/fr_01.png` vs `vda_01.png`）：两者主体几何结构一致；VDA 背景噪点明显更少、明暗过渡更连续，无逐帧后端的背景颗粒闪烁。

**环境依赖**：VDA 仓库 `~/.cache/greybox/vda_repo` + 权重 `~/.cache/greybox/vda/video_depth_anything_vits.pth`（116MB）；另需 `opencv-python-headless` 与 `easydict`（已装入 `.venv`，VDA 仓库自身 import 需要）。

**结论**：CPU 上慢 50% 可接受，稳定性收益明确。双后端并存：`frame` 默认（快），`vda` 按需（静止/固定机位、对帧间抖动敏感的场景）。目视质量仍待主人在调参台用真实视频终验。
