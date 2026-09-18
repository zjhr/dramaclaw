# Vendored: 3D 导演台（3d-director-desk）

本目录是上游 `3d-director-desk` 的**构建产物**（`dist/` 全量），作为静态资源随仓库发布。
播放/编辑逻辑全部来自上游，本仓库不改其源码。

## 来源

| 项 | 值 |
|---|---|
| 上游仓库 | https://github.com/xiaozangao/3d-director-desk |
| 同步版本 | v0.3.1（`package.json` `version`） |
| 同步 commit | `a6c931cd36d8263d986706f74ab4efe9d5151959`（2026-07-22，Merge PR #2） |
| 上游许可 | MIT，Copyright (c) 2026 YZ（见上游 `LICENSE`） |
| 本目录性质 | 构建产物快照，非源码；升级方式见下 |

## 重新生成方式

本目录是 `npm run build`（= `tsc -b && vite build`）的 `dist/` 输出，未做任何后处理。

```bash
# 在临时目录操作，避免污染仓库
git clone --depth 1 https://github.com/xiaozangao/3d-director-desk.git /tmp/dd-spike/desk
cd /tmp/dd-spike/desk
git checkout a6c931cd36d8263d986706f74ab4efe9d5151959
npm install --no-audit --no-fund
npm run build                 # 实测 ~3.9s
rsync -a --delete dist/ <repo>/frontend/public/director-desk/
```

产物内资源引用一律为相对路径（`./assets/...`），因此可以整体挂载到任意子路径
（本仓库挂在 `/director-desk/`）。`local-assets/` 下的模型/缩略图由上游 `public/`
原样拷贝，**不做裁剪**。

## 内置素材清单

### GUO 道具与场景包（`local-assets/guo-3d-assets/`）

| 包 | 数量 | 说明 | 来源与许可 |
|---|---|---|---|
| `guo-mounted-props-200/` | `counts.props = 180` 件挂载道具（+ 缩略图） | FBX 道具库，按需读取 | 见该目录 `README.md` |
| `guo-scene-presets-200/` | `counts.presets = 200` 套场景预设（311 张缩略图） | PMA 场景预设包 | 见该目录 `README.md` |
| `guo-skeleton-models/` | `counts.models = 37` 个骨架模型（+ 缩略图） | 可选包，缺失时 UI 应显示不可用态 | 见该目录 `README.md` |

### Mixamo 兼容人物与动作（`local-assets/mixamo/`）

来源逐条登记在 `local-assets/mixamo/SOURCES.md`，摘要：

- 人物：`characters/camille.fbx`（mephistia/character-animations）、
  `characters/xbot.glb`、`characters/robot-expressive.glb`、`characters/soldier.glb`
  （后三者取自 Three.js 官方示例模型目录）
- 动作：`animations/{walk,run,wave}.fbx`（GameDevGuidance/Animation-Quick-Turn-180）、
  `animations/jump.fbx`（MinaPecheux/UnityTutorials-MixamoAnimations）、
  `animations/{sit-stand,side-step-left}.fbx`（MolochDaGod/Grudge-Studio-Game）

### UE 人偶（`models/`）

- `models/ue-mannequin-retopology.glb` —— UE Mannequin (Retopology)
- 许可原文：`models/ue-mannequin-retopology.license.txt`
  （作者 William Luque，来源 Sketchfab，
  license type: **SKETCHFAB Standard**，允许全球范围内商用与非商用的衍生作品）

### 其它

- `assets/` —— 构建出的 JS/CSS chunk。`assets/gaussianSplatExperiment-*.js` 约 5MB，
  是上游的高斯泼溅实验页 chunk，属正常产物，保留。
- `benchmark-panorama.jpg`、`example*`/`extension-*-smoke.html` —— 上游自带的
  基准全景图与独立 smoke 页，一并保留。

## 合规登记

本目录的整体许可与各素材来源登记见仓库根 `REUSE.toml`（`precedence = "override"` 块）、
根 `NOTICE` 与 `license-inventory.csv`。
