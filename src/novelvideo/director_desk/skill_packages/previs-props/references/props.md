# 道具与布景（v2 `director_apply` 细节）

## 一次提交一个批次

`director_apply` 接受 1~100 个 operations，**原子提交，失败整批回滚**。所以：

- 一次把桌子、椅子、灯全部 `add` 完，不要拆成三次调用 —— 拆开会让后一批基于过期的 revision。
- 一批里的对象之间可以用显式 id 建立依赖。
- 不确定某个字段会不会导致整批回滚时，先 `{"preview": true}` 只校验不落盘。

## 位置、朝向、尺寸

- `position` 是 `[x,y,z]` 场景米，语义是**底面中心**（道具自己不用再抬半米）。
- `patch.rotation` 是**弧度 XYZ**，不是度。
- `patch.scale` 每项必须 > 0（上游 `assertProject` 直接拒绝 ≤0）。
- 尺寸优先用 `patch.assetParameters`，键名与取值范围**必须查**：
  `director_assets({ids:["<资产id>"], details:true})`，返回里有参数 schema 与 `addExample`。
- `patch.color` 是 `#RRGGBB`。

## 资产检索的两个坑

- `query`：其中**所有空白分隔的词都必须命中同一个资产**。想搜多个候选用 `queries`（并集），
  例如 `queries:["餐桌","饭桌","table"]`。
- 默认返回 8 条摘要。只有确实需要更多时才跟 `nextOffset`；**不要为了「万一」把整个目录扫一遍**。
- `kind` 可选 `actor` / `prop` / `crowd`；`group`、`rig`、`action` 是可叠加的过滤器，各过滤条件**取交集**。

## geometry 模式

1. `{"operation":"project","patch":{"creationMode":"geometry"}}`
2. **再** `director_read` —— geometry 调色板**只在 geometry 模式下**才返回。
3. 用调色板 id `add`。

15 个形状 id 与中文名：

| id | 名称 | 额外参数 |
| --- | --- | --- |
| `shape-box` | 方块 | |
| `shape-cylinder` | 圆柱 | `segments` |
| `shape-cone` | 圆锥 | `segments` |
| `shape-capsule` | 胶囊 | `segments`,`crossSegments` |
| `shape-sphere` | 球体 | `segments`,`crossSegments` |
| `shape-torus` | 圆环 | `segments`,`crossSegments`,`thickness` |
| `shape-pyramid` | 棱锥 | |
| `shape-plane` | 平面板 | `height`（默认 0.04） |
| `shape-wedge` | 楔块 | |
| `shape-ramp` | 斜板 | `thickness` |
| `shape-arch` | 拱形 | `segments`,`thickness` |
| `shape-hemisphere` | 半球 | `segments`,`crossSegments` |
| `shape-tube` | 空心管 | `segments`,`thickness` |
| `shape-l` | L 形块 | `thickness` |
| `shape-u` | U 形块 | `thickness` |
| `shape-arc` | 圆弧段 | `segments`,`crossSegments`,`thickness`,`angle` |

通用约定：尺寸单位米，每轴 0.02~500，默认 1；`position` 为底面中心；`rotation` 为弧度；
`scale` 默认 `[1,1,1]`。所有 geometry 资产都是 `prop`。

**切模式会保留现有实体和路径**，不会清场，也不该为了切模式清空或转换场景。

geometry 模式下需要**人物**时：角色是**有名字、有独立颜色的 prop 胶囊**，靠 `path` 表达走位。
它们**不是人形骨架**，排不了人形动作；剧情动作写进 notes。多个几何体**不会自动绑定**，
要保持各自路径的相对偏移。

## 导入外部 GLB

```
director_media({action:"import", path:"<文件路径>", name:"<名字>", mime:"model/gltf-binary"})
```

导入后拿到 resourceId，用它 `add`。**模型资源要显式写 `kind`**（默认 `prop`，人写 `actor`）。

- **GLB 必须未压缩**：上游 glTF loader 见到 `KHR_draco_mesh_compression` 会直接报错拒绝加载。
  导出时不要开 Draco。
- 导入时可在 `patch` 里校准：`unitScale`（单位比例）、`orientation`（朝向）、`appearance`。
- 人形资源还需要 `rig={version:1,family:"humanoid",bones:{解剖部位:源骨骼路径}}` 与
  `defaultPose`。骨骼路径先用 `director_read({resourceId:"..."})` 查 —— 它给的是**源静置坐标系**
  下的稳定骨骼/节点路径。
- 导入后只能调 position / rotation / scale / color / visible，**不能在场景里改顶点**。

## 让道具用起来

### 绑到手上

```json
{"operation":"update","id":"prop-cup","patch":{
  "handBinding":{"actorId":"human-1","hand":"right","offset":[0,-0.05,0.08],"rotation":[0,0,0]},
  "path":null}}
```

- `offset` 是**在随手旋转的坐标系里**的场景米；`rotation` 是相对弧度。
- **必须同时 `path:null`**，否则路径和手部姿态会打架。
- 内置人形直接支持；导入的人形要先映射对应手骨；**群众和动物不支持**。
- 道具 scale 保持独立。绑定后道具跟随**实际摆出的**手部姿态。
- `handBinding:null` 解绑。要保留当前摆放，同时把 `position`/`rotation` 写成
  `director_spatial` 返回的 `origin` 与 `rotationRadians`。
- **不**动画手指握持，**不**编排拿起/放下的时机。

### 接触点（可坐 / 可躺 / 可放东西）

```json
{"operation":"update","id":"prop-chair","patch":{"contactAnchors":[
  {"id":"seat","role":"seat","position":[0,0.45,0],"normal":[0,1,0],"forward":[0,0,1]}]}}
```

- 最多 64 个；`role` 只能是 `seat` / `surface` / `bed`。
- `position` 是道具**局部米**，`normal` 是单位法线，`forward` 可选且垂直于法线。
- 空数组清空全部。`update` 里**不带** `contactAnchors` 就保持现状。
- 几何参数或源模型重新校准后，**手工标的局部点必须重新核对**。
- 用 `director_spatial` 读实际世界坐标。它是**用户复核过的几何提示，不是语义识别**。

### 群演

```json
{"operation":"add","asset":"crowd","id":"crowd-1","patch":{"count":40,"spacing":0.75,"seed":42}}
```

`count` 是 1~1000 的**整数**，`spacing` 是每人间距（米），`seed` 固定随机阵列。
超过约 40 人时逐个投影会关掉（性能）。群众不支持 `handBinding`。
`director_spatial` 可以按 `entityId` 查单个群演成员的位置。

### 建筑

- `structureLink={parentId,parentPort,ownPort,offset:[x,y,z],rotation:[x,y,z]}` 做父子变换传播，
  子件跟着父件动。`structureLink:null` 断开但**保留当前世界变换**。
- **删父件前先清掉所有子件链接**，否则残留引用会让操作失败。
- 场景层还有 `floors`（楼层）与 `zones`（分区），在 `project` 的 patch 里设置。

## 一个可信的场景要满足什么

- **有承托**：人要站/坐/躺的地方必须真有东西 → 椅子标 `seat`、床标 `bed`、桌面标 `surface`。
- **有前后景**：不要把所有东西平铺一层，纵深拉开。
- **不挡路径与视线**：用 `director_spatial` 查实际位置与包围盒，别靠估。
- **有周边陈设**：空房间里只有一张桌子不算完成场景。

## 不许承诺的

- 道具本身静态，不会自己动。要动就用角色的 `path`、`director_motions` + `motion` 操作，或绑到手上。
- 没有真实服装、表情、手指级动作、自由曲面雕刻、实时物理接触求解。
- 目录/几何都表达不出来的造型（特定品牌车、太师椅）：直说做不了并给最接近的替代。