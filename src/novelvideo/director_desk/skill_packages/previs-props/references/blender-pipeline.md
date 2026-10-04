# AI 现场写 Blender 脚本（第三档阶梯）

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

## 你不能自己跑 Blender —— 这条要如实说

导演台暴露的工具里**没有执行脚本或 shell 的能力**。所以你在这一档能做的是：

1. 按用户描述写出一份 bpy 脚本，**每条命令都必须是可执行的动作**（`primitive_*_add`、
   `transform_apply`、`join`），不要写占位符、伪代码或「此处补充」。
2. 把脚本连同下面这条命令一起交给用户，说明**你还没有验证过它**：

   ```bash
   .venv/bin/python scripts/blender/ai_model.py \
       --script /tmp/<道具名>.py --out /tmp/<道具名>.glb \
       --kind <类别> --expect-parts <预期零件数>
   ```

3. 用户跑完后把 stdout 那一行 JSON 给你。`"ok": true` 才是能用；`false` 就按下面的
   失败码处理，**不要重试到「差不多就行」，更不要编一个说「已经做好了」**。

## `--kind` 用这张表（护栏据此做尺度归一化）

`table`/`desk` 0.75、`chair`/`stool`/`bench` 0.45、`bar_stool` 0.75、`sofa` 0.80、
`bed`/`nightstand` 0.55、`wardrobe` 1.90、`shelf` 1.80、`lamp` 1.60、`table_lamp` 0.45、
`vase` 0.30、`bottle` 0.25、`cup` 0.10、`bowl` 0.08、`book` 0.24、`box` 0.30、
`crate` 0.40、`plant` 1.20、`door` 2.05、`window` 1.20、`barrel` 0.88、`toolbox` 0.25、
`stair` 1.60、`railing` 1.10。单位米。

**表里没有的类别就不要瞎编** —— 换成最接近的，或者显式给 `--real-height`（米）。

## 写脚本时怎么降低被护栏打回的概率

- **`--expect-parts` 你最清楚**：四条腿的凳子是 5 个连通分量（座 + 4 腿）。数错就会被
  `component-count` 打回。
- **每个零件必须真的和主体相接**：悬空的把手、飘着的装饰、脱离的盖子都会被 `floating-parts`
  打回。写之前先想清楚谁靠着谁。
- **不许靠猜尺寸**：护栏会按真实尺寸等比缩放并把底面贴到地面，所以脚本里的尺寸只影响比例，
  不影响最终大小。但**长宽高比例**是你的责任 —— 护栏不会替你修正「桌子做成正方体」。
- **不要用布尔运算拼复杂轮廓**：布尔枚举跨版本最容易失效（管线锁 Blender 4.5，
  因为 5.0 对合成器/布尔枚举 API 实测 0% 通过）。用少量基本体组合更稳。
- **控制面数**：导出前超过 200 万面直接判失败。

## 失败码怎么解释给用户

护栏失败**不是 bug，是它在替用户省钱**。按失败码如实转述，并给出下一步：

| `reason` 前缀 | 意思 | 下一步 |
| --- | --- | --- |
| `ai-script-error` | 脚本自己抛异常 | 报错已带 traceback；按 traceback 改脚本重试 |
| `component-count` | 连通分量数与 `--expect-parts` 不符 | 通常是多写/少写了一个零件，重数一遍 |
| `floating-parts` | 有零件没和主体接触（**最常见**） | 把悬空件挪到接触位置，或明确它是分离设计并改期望 |
| `degenerate-geometry` | 有零体积的退化零件 | 去掉那个零件 |
| `network-blocked` | 脚本想联网 | bpy 脚本不需要联网，去掉 |
| `timeout` | 超过 60 秒（默认） | 多半是死循环或失控的细分 |
| `face-budget` | 面数超 200 万 | 降细分、改用更简单的基本体 |
| `blender-version` | 版本不是锁定的 4.5.x | 装对齐的 Blender（`--blender` 或 `DRAMACLAW_BLENDER`） |

重试上限 3 次。**仍然不过就如实告诉用户「这个造型做不了，建议加一个固定模板」** ——
把坏模型塞进场景比不做更糟：它会浮在半空、尺寸不对，而且用户看不出问题在哪。

## 过了护栏之后

`ok: true` 的 JSON 里 `report.out` 是 GLB 路径，用它导入：

```
director_media({action:"import", path:"<report.out>", name:"<显示名>", mime:"model/gltf-binary"})
```

然后按 resourceId `add`（模型资源要显式写 `kind`）。`report.normalization.bboxAfter`
是归一化后的真实包围盒尺寸，可以直接告诉用户这个道具实际有多大。

**GLB 保持未压缩** —— 上游 loader 见到 Draco 扩展会直接拒绝加载。管线已经关掉了压缩，
不要再去手工开。