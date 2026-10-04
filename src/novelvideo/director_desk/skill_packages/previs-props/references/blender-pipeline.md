# AI 现场写 Blender 脚本（第三档阶梯）

**你能自己跑了。** 后端有 `blender_run_model` 工具：给它一份完整的 bpy 脚本，它就在本机
起一个 headless Blender 跑护栏，通过就产出 GLB。**用户什么都不用做**，不需要他开终端、
不需要他回传 stdout。

## 先看能不能不用这条通路

三档阶梯，**从省到贵**：

1. **复用现成 GLB** —— `frontend/public/previs-models/` 下的 `rail` / `crane` / `light_stand` / `platform`。
   `director_media` 导入即可。
2. **固定模板 + 参数** —— 轨道、摇臂、灯架、高台这类影视器材有确定性模板，确定性生成，不出错。
3. **AI 现场写 bpy 脚本 + 护栏** —— 桌、椅、瓶、花器这类简单道具。**本文件。**

短剧预演道具属于难度 L1~L2，成功率够用（见下）。再复杂的造型不要硬走这条，
先考虑目录里有没有近似资产，或者如实告诉用户做不了。

## 为什么现在放开了

原先的立场是「不把 AI 生成的 Python 喂给 Blender：安全与质量都不可控」。现在：

- **可执行率不再是问题**：裸调 LLM 写 Blender 脚本的成功率只有 0.41~0.92；挂上 coding agent
  harness 后升到 0.986~1.000（3DCodeBench, arXiv 2606.01057）。我们本来就是 agent 场景。
- **质量问题可检测**：论文点名的残余缺陷是「successful renders still suffer from
  disconnected or floating 3D geometric components」，并强调「Physical Plausibility
  supersedes Executability」—— 失败模式是**几何不成立**，而几何不成立是可测量、可拒绝、可重试的。
- **难度分层**：L1 成功率 75~89%，L3 掉到 8~32%。所以 L3 的造型应当退回固定模板。

## 怎么调

```
blender_run_model({
  script: "<完整的 bpy 脚本>",
  name: "预演方桌",          // 显示名，也用作 GLB 文件名
  kind: "table",             // 真实尺寸表里的类别 → 尺度硬归一化
  expectParts: 5             // 你预期的连通分量数
})
```

- **脚本必须是完整可执行的 bpy 代码**（`primitive_*_add`、`transform_apply`…），
  不接受占位符、伪代码或「此处补充」。写完自己通读一遍：括号配不配、坐标写没写全。
- **Blender 从出厂设置启动，场景已经是空的。** 你不需要（也不该）去删默认 Cube。
- 除 `script` 外都是可选的；`kind` 与 `realHeight` 都不给时，护栏只落地不缩放。

## `kind` 用这张表（护栏据此做尺度归一化，单位米）

`table`/`desk` 0.75、`chair`/`stool`/`bench` 0.45、`bar_stool` 0.75、`sofa` 0.80、
`bed`/`nightstand` 0.55、`wardrobe` 1.90、`shelf` 1.80、`lamp` 1.60、`table_lamp` 0.45、
`vase` 0.30、`bottle` 0.25、`cup` 0.10、`bowl` 0.08、`book` 0.24、`box` 0.30、
`crate` 0.40、`plant` 1.20、`door` 2.05、`window` 1.20、`barrel` 0.88、`toolbox` 0.25、
`stair` 1.60、`railing` 1.10。

**表里没有的类别工具会直接拒**（`unknown-kind`）。换成最接近的，或者显式给 `realHeight`（米）。

## 写脚本时怎么降低被护栏打回的概率

- **`expectParts` 你最清楚**：四条腿的凳子是 5 个连通分量（座 + 4 腿）。数错就会被
  `component-count` 打回。拿不准就**别传** —— 不传不会因数错被拒。
- **每个零件必须真的和主体相接**：悬空的把手、飘着的装饰、脱离的盖子都会被 `floating-parts`
  打回。护栏报的是每个悬空件的 `minZ`/`maxZ`，照着它把零件落到该落的高度。
- **不许靠猜尺寸**：护栏会按真实尺寸等比缩放并把底面贴到地面，所以脚本里的尺寸只影响比例，
  不影响最终大小。但**长宽高比例**是你的责任 —— 护栏不会替你修正「桌子做成正方体」。
- **不要用布尔运算拼复杂轮廓**：布尔枚举跨版本最容易失效（管线锁 Blender 4.5，
  因为 5.0 对合成器/布尔枚举 API 实测 0% 通过）。用少量基本体组合更稳。
- **控制面数**：导出前超过 200 万面直接判失败。
- **别联网**：bpy 脚本没有任何正当联网需求，护栏把网络模块换成了会抛错的桩。

## 护栏失败怎么办：读报告、改脚本、重试

护栏失败**不是 bug，是它在替用户省钱**。失败时 `ok:false`，`reason` 是失败码，
`guardReport` 是结构化细节。按下面的表改脚本，**重试上限 3 次**：

| `reason` 前缀 | 意思 | 下一步 |
| --- | --- | --- |
| `ai-script-error` | 脚本自己抛异常 | 报错带 traceback；按 traceback 改脚本重试 |
| `component-count` | 连通分量数与 `expectParts` 不符 | 通常是多写/少写了一个零件，重数一遍 |
| `floating-parts` | 有零件没和主体接触（**最常见**） | 看 `guardReport.floating` 里每个件的 `minZ`/`maxZ`，把悬空件挪到接触位置 |
| `degenerate-geometry` | 有零体积的退化零件 | 去掉那个零件 |
| `empty-scene` | 脚本跑完了但一个网格都没生成 | 忘了 `primitive_*_add`，或者只建了空对象 |
| `network-blocked` | 脚本想联网 | bpy 脚本不需要联网，去掉 |
| `timeout` | 超过 `timeoutSeconds`（默认 60，硬顶 300） | 多半是死循环或失控的细分 |
| `face-budget` | 面数超 200 万 | 降细分、改用更简单的基本体 |
| `blender-unavailable` | 本机没装可用的 Blender 4.5.x | **不是你的问题**，如实告诉用户去装 |
| `blender-version` | 版本不是锁定的 4.5.x | 同上，装对齐的版本 |
| `inline-too-large` | 模型太大，导不进工程 | 简化造型（减细分、减零件数）后重试 |

**三次仍然不过就如实告诉用户「这个造型做不了，建议加一个固定模板」** ——
把坏模型塞进场景比不做更糟：它会浮在半空、尺寸不对，而且用户看不出问题在哪。
**不要重试到「差不多就行」，更不要编一句「已经做好了」。**

## 过了护栏之后

`ok:true` 的回包里有两个能直接用的东西：

- `data` —— `data:model/gltf-binary;base64,…`。**网页版的 `director_media import` 不收本机
  路径**（上游 `automation/service.ts:60`：「本机路径导入需要桌面版」），所以只能走它。
- `guardReport.normalization.bboxAfter` —— 归一化后的真实包围盒（米 × 米 × 米），
  可以直接告诉用户这个道具实际有多大。

导入要原样透传，不要改任何一个字节：

```
director_media({
  action: "import",
  data: "<上一步的 data>",
  name: "预演方桌.glb",
  mime: "model/gltf-binary",
  requestId: "<本批次的唯一 id>",
  revision: "<最新 revision>"
})
```

然后按返回的 `resourceId` `add`（模型资源要显式写 `kind:"prop"`）。

**GLB 保持未压缩** —— 上游 loader 见到 Draco 扩展会直接拒绝加载。管线已经关掉了压缩，
不要再去手工开。

## 三平台都跑得起来（macOS / Windows / Linux）

Blender 用官方便携包，三平台各有各的下载与查找路径（`scripts/blender/ensure_blender.py`
按 `platform.system()` 选包名、按解包结构找可执行文件），不需要管理员权限、不写系统目录。
`DRAMACLAW_BLENDER` / `--blender` 在三平台上都能显式指定路径。

超时与取消在三平台上都**收得干净**：Blender 会 fork 子进程，只杀主进程等于没超时。

| | 分组方式 | 终止手段 |
| --- | --- | --- |
| macOS / Linux | `setsid`（新会话组） | `killpg` 杀整组 |
| Windows | `CREATE_NEW_PROCESS_GROUP`（新进程组） | `taskkill /PID <pid> /T /F` 杀整棵树 |

**没有 Windows 专属的失败码** —— 同一份脚本、同一份参数，在三平台上跑出同一种结果。
路径含空格（Windows 上 `C:\Users\<用户名>\...` 是常态）按 argv 列表传递，不会被拆词。
内存上限按平台如实报告（macOS 上 `setrlimit` 实际不生效、Windows 上没有 `resource`
模块），报告里的 `memoryCapped` 字段**说的是本平台的真实结果**，不是硬编码的成功。

**未实测的部分**：开发与验证环境是 macOS。Windows / Linux 分支的**选择逻辑**
（有单元测试断言选了哪组参数、发了哪条命令），但「在 Windows 上真跑一遍 Blender」
这件事没有做过 —— 第一次在 Windows 上用时请先手工跑一个最简单的例子确认。