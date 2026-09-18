#!/usr/bin/env bash
# 一键生成 Windows 迁移交接包（桌面 dramaclaw-windows-handover.zip）
#
# 流程：交叉编译 Windows 网关 → SQLite 安全快照 → 汇集数据 →
#       生成 HANDOVER.md（动态注入当前提交号）→ zip 到桌面
#
# 用法: ./make-handover.sh
set -euo pipefail

REPO="/Users/mac/ai/dramaclaw"
GATEWAY="/Users/mac/ai/dramaclaw-gateway"
ZIP_PATH="$HOME/Desktop/dramaclaw-windows-handover.zip"

STAGE="$(mktemp -d)/dramaclaw-handover"
mkdir -p "$STAGE/data"

cleanup() { rm -rf "$(dirname "$STAGE")"; }
trap cleanup EXIT

# ---------- 0. 前置检查 ----------
command -v go >/dev/null 2>&1 || { echo "✗ 需要 Go 工具链（编译 Windows 网关）"; exit 1; }
command -v sqlite3 >/dev/null 2>&1 || { echo "✗ 需要 sqlite3"; exit 1; }
[ -d "$GATEWAY" ] || { echo "✗ 网关目录不存在: $GATEWAY"; exit 1; }
[ -f "$REPO/.env" ] || { echo "✗ 找不到 $REPO/.env"; exit 1; }

# 网关工作区有未提交改动时提醒（补丁是否已入库）
if [ -n "$(cd "$GATEWAY" && git status --short -- relay service)" ]; then
  echo "⚠ 网关 relay/service 有未提交改动，exe 将包含它们（提交后更可追溯）"
fi

# 主仓库有未推送提交时警告：Windows 端靠 git clone 拿代码，未推送 = 效果不一致
UNPUSHED="$(cd "$REPO" && git log origin/main..HEAD --oneline 2>/dev/null | wc -l | tr -d ' ')"
if [ "$UNPUSHED" -gt 0 ]; then
  echo "✗ 主仓库有 ${UNPUSHED} 个未推送提交，Windows 端 git clone 拿不到，效果必然不一致！"
  (cd "$REPO" && git log origin/main..HEAD --oneline | sed 's/^/    /')
  echo "  → 请先 cd $REPO && git push origin main 再重新生成交接包"
  exit 1
fi

# 已跟踪文件有未提交改动时提醒（Windows 端 clone 同样拿不到，如 start.ps1 本身）
DIRTY="$(cd "$REPO" && git status --short --untracked-files=no | wc -l | tr -d ' ')"
if [ "$DIRTY" -gt 0 ]; then
  echo "⚠ 主仓库有 ${DIRTY} 个已跟踪文件未提交，Windows 端 clone 拿不到："
  (cd "$REPO" && git status --short --untracked-files=no | sed 's/^/    /')
fi

# ---------- 1. 交叉编译 Windows 网关 ----------
echo "▸ 编译 Windows amd64 网关..."
(cd "$GATEWAY" && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
  go build -o "$STAGE/newapi.exe" .)

# ---------- 2. 数据快照 ----------
# 服务运行中直接 cp 可能撞写锁或拿到半写状态，db 一律走 sqlite3 .backup
echo "▸ 快照网关库 one-api.db..."
sqlite3 "$GATEWAY/one-api.db" ".backup '$STAGE/data/one-api.db'"

echo "▸ 快照 DramaClaw 状态库..."
mkdir -p "$STAGE/data/state-local"
for db in "$REPO"/state/local/*.db; do
  sqlite3 "$db" ".backup '$STAGE/data/state-local/$(basename "$db")'"
done
# 项目数据目录（画布/生成索引等非 db 文件）直接拷贝
# 注意用 ${dir%/} 去掉 glob 带来的尾斜杠 —— cp -R "src/" 是拷*内容*，
# 会把 agent_test/ 里的 data.db / freezone/ 拍平进 state-local 根，导致项目数据错位
for dir in "$REPO"/state/local/*/; do
  [ -d "$dir" ] && cp -R "${dir%/}" "$STAGE/data/state-local/"
done

echo "▸ 拷贝生成产物 output/..."
cp -R "$REPO/output" "$STAGE/data/output"

# 任务信封签名密钥环（state/ 直属文件，不在 state/local/ 下，漏了签名校验会失败）
[ -f "$REPO/state/task_envelope_keyring.json" ] \
  && cp "$REPO/state/task_envelope_keyring.json" "$STAGE/data/state-keyring.json"

# 前端本地状态（settings.db + 密钥环，在 .gitignore 里，不入库）
[ -d "$REPO/frontend/state" ] && cp -R "$REPO/frontend/state" "$STAGE/data/frontend-state"

# 风格图墙素材（225 张图，不在 git 也不在客户端里，前端 public 目录）
[ -d "$REPO/frontend/public/style-gallery" ] \
  && cp -R "$REPO/frontend/public/style-gallery" "$STAGE/data/style-gallery"

# 运行时目录（agent_test 等，多为空骨架，带上保持结构一致）
[ -d "$REPO/runtime" ] && cp -R "$REPO/runtime" "$STAGE/data/runtime"

echo "▸ 拷贝 .env（含敏感 Key，注意传输安全）..."
cp "$REPO/.env" "$STAGE/data/env"

# ---------- 3. 动态信息 ----------
DC_COMMIT="$(cd "$REPO" && git rev-parse --short HEAD)"
GW_COMMIT="$(cd "$GATEWAY" && git rev-parse --short HEAD)"
STAMP="$(date '+%Y-%m-%d %H:%M')"

# 网关未提交改动数（exe 会带上它们，但 git 里没有 → 将来重编译会丢）
GW_DIRTY="$(cd "$GATEWAY" && git status --short | wc -l | tr -d ' ')"
GW_DIRTY_NOTE=""
if [ "$GW_DIRTY" -gt 0 ]; then
  GW_DIRTY_NOTE="⚠ 注意：本包的 newapi.exe 交叉编译自 macOS 端网关工作区，除 public-proxy 补丁外还包含 ${GW_DIRTY} 个未提交改动（DeepSeek 视觉能力、Agnes 时长/画幅字段映射、elevenlabs/senseaudio 渠道适配器等）。这些改动尚未进入 git——Windows 端若重编译网关会全部丢失，需要时请回 macOS 端提交推送后再编译。"
fi

# ---------- 4. 交接文档 ----------
echo "▸ 生成 HANDOVER.md..."
cat > "$STAGE/HANDOVER.md" <<EOF
# DramaClaw Windows 环境交接文档

> 交接目标：在一台 Windows 电脑上，从零复刻一套可用的 DramaClaw 本地环境
> （网关 + API + 前端三件套，含全部数据与配置）。
> 本文档面向执行迁移的 agent / 工程师，按步骤执行即可，末尾有验证清单。
> 包生成时间：${STAMP}（dramaclaw @ ${DC_COMMIT} / dramaclaw-gateway @ ${GW_COMMIT}）

## 0. 本交接包内容

\`\`\`
newapi.exe                    Windows amd64 网关二进制（含 public-proxy 补丁，Go 交叉编译）
data/one-api.db               网关 SQLite 库（渠道/上游 Key/额度/账号）
data/env                      DramaClaw 的 .env 模板（原样拷自 macOS 环境）
data/state-local/             DramaClaw API 的本地状态（settings.db / projects.db / 项目数据）
data/state-keyring.json       任务信封签名密钥环 → 还原为 state/task_envelope_keyring.json
data/output/                  生成产物（画布图片/视频等）
data/frontend-state/          前端本地状态 → 还原为 frontend/state/（settings.db + 密钥环）
data/style-gallery/           风格图墙素材 225 张 → 还原为 frontend/public/style-gallery/
data/runtime/                 运行时目录 → 还原为 runtime/
\`\`\`

> 这份包的目标是**和 macOS 端当前状态逐字节一致**：凡是不在 git 里的本地数据
> （.gitignore 覆盖的 .env / state / runtime / output / frontend/state / style-gallery），
> 全部都在包内，按第 3 节还原即可。
>
> **两类用途，别走错**：
> - **首次部署**（目标机器是空的）→ 走 **第 3 节**，全量还原 data/。
> - **功能更新**（机器已部署过，只是想跟上 macOS 的新代码/新功能）
>   → 走 **第 3b 节**，只拉代码 + 换 exe，**数据全部保留不动**。

注意：\`data/\` 里含**上游 API Key 等敏感信息**，仅在可信设备间传输使用。

## 1. 架构总览（复刻后的目标形态）

| 组件 | 仓库 | 端口 | 启动 |
|---|---|---|---|
| 网关（newapi fork） | https://github.com/zjhr/dramaclaw-gateway.git | 18780 | \`newapi.exe --port 18780 --log-dir ./logs\` |
| DramaClaw API | https://github.com/zjhr/dramaclaw.git | 8780 | 仓库根 \`uv run novelvideo api --port 8780\`（必须在仓库根跑，否则 DATA_ROOT 错位） |
| 前端 | 同上仓库 frontend/ | 5173 | \`pnpm dev\` |

代码已全部推到主人自己的 GitHub（zjhr），Windows 端**只需 clone 主仓库**：
- dramaclaw main @ ${DC_COMMIT}
- dramaclaw-gateway main @ ${GW_COMMIT}——本次**不用 clone**，补丁已编进随包的 \`newapi.exe\`

网关的 public-proxy 补丁说明：Sora 任务适配器不透传上游 URL，result_url 走网关私有代理需鉴权，
而 DramaClaw 裸下载无鉴权头会 401。补丁把 4 处 \`BuildProxyURL\` 改为 \`BuildPublicProxyURL\`
（HMAC 签名 24h 有效免鉴权）。**若日后从上游 \`dramaclaw/dramaclaw-gateway\` 同步代码，
冲突时必须保住 \`relay/relay_task.go\` 和 \`service/task_polling.go\` 里的 \`BuildPublicProxyURL\` 四处。**

${GW_DIRTY_NOTE}

## 2. 前置安装（Windows）

1. **uv**（Python 管理）：\`winget install astral-sh.uv\` 或官网安装器
2. **Node.js + pnpm**：装 Node 20+，然后 \`npm i -g pnpm\`（前端 dev 需要）
3. **不需要 Go**——网关二进制已随包提供（\`newapi.exe\`）
4. git
5. **磁盘空间**：\`uv sync --extra world\` 会拉 torch 等大包（数 GB），首次较慢；
   这段由 \`start.ps1\` 自动执行，无需手动。若 Windows 端不跑 3D 导演台可自行跳过。

## 3. 部署步骤（首次部署：目标机器是空的）

主仓库必须 clone（API + 前端源码）；**网关不需要 clone**——\`newapi.exe\` 已带全部补丁，
建一个普通目录放二进制和库即可（源码留到将来要重编译网关时再 clone）。

\`\`\`powershell
# 1. clone 主仓库
cd C:\\Users\\<你>\\ai
git clone https://github.com/zjhr/dramaclaw.git
cd dramaclaw
git log --oneline -1        # 应为本包生成时的提交号，见文档开头

# 2. 建网关目录（不 clone），放入交接包里的两样东西
mkdir dramaclaw-gateway
copy <交接包>\\newapi.exe            dramaclaw-gateway\\newapi.exe
copy <交接包>\\data\\one-api.db       dramaclaw-gateway\\one-api.db

# 3. 还原数据（本交接包的 data/）——逐项对应，缺一项效果就不一致
copy <交接包>\\data\\env                   dramaclaw\\.env
copy <交接包>\\data\\state-keyring.json    dramaclaw\\state\\task_envelope_keyring.json
# 以下目录整份递归覆盖（xcopy /E /I 会自动建目标目录）
xcopy /E /I /Y <交接包>\\data\\state-local     dramaclaw\\state\\local
xcopy /E /I /Y <交接包>\\data\\output          dramaclaw\\output
xcopy /E /I /Y <交接包>\\data\\frontend-state  dramaclaw\\frontend\\state
xcopy /E /I /Y <交接包>\\data\\style-gallery   dramaclaw\\frontend\\public\\style-gallery
xcopy /E /I /Y <交接包>\\data\\runtime         dramaclaw\\runtime

# 4. 修改 .env（唯一必改项）
# 找到 NEWAPI_SQLITE_PATH，改为 Windows 实际路径，例如：
#   NEWAPI_SQLITE_PATH=C:/Users/<你>/ai/dramaclaw-gateway/one-api.db
# （原值是 macOS 绝对路径 /Users/mac/...，不改则"供应商渠道管理"弹窗会 502 空白）

# 5. 一键启动（首次自动: uv sync --extra world + pnpm install + 装 splat-transform）
cd dramaclaw
.\\start.ps1
\`\`\`

> 网关源码仓库（https://github.com/zjhr/dramaclaw-gateway.git）本次不需要；
> 将来若要重编译网关或同步上游（\`dramaclaw/dramaclaw-gateway\`），再 clone 它。
> 注意：上游合并冲突时必须保住 \`relay/relay_task.go\` / \`service/task_polling.go\` 的
> \`BuildPublicProxyURL\` 四处（视频下载免鉴权补丁）。

## 3b. 二次迁移：Windows 已部署过，只更新功能

> 适用场景：Windows 上已按第 3 节部署并跑起来过，之后 macOS 端更新了代码/网关，
> 想同步过去。**原则：数据以 Windows 端为准，全部保留；只更新代码与网关二进制。**

macOS 端重新生成包后，在 Windows 上执行以下步骤（**不要**重复第 3 节的 data/ 还原）：

\`\`\`powershell
cd dramaclaw
.\\start.ps1 -Action stop                     # 1. 停服务（避免文件占用与 SQLite 写锁）

git pull origin main                          # 2. 更新代码
git log --oneline -1                          #    与文档开头的提交号核对

uv sync --extra world                         # 3. 补齐 Python 依赖（幂等，新功能加了依赖必须跑）
cd frontend; pnpm install; cd ..              # 4. 补齐前端依赖（同上）

copy <新包>\\newapi.exe <网关目录>\\newapi.exe    # 5. 换网关二进制

.\\start.ps1                                  # 6. 重启三件套
\`\`\`

**明确不要做的**：不要执行第 3 节的 \`data/\` 还原 —— xcopy 是整文件覆盖，
settings.db / one-api.db / 画布 JSON 会被 macOS 版本替换，**Windows 端积累的数据会全部丢失**；
也不要覆盖 \`.env\`。

**两个不会被自动同步的项（需手动确认）**：

1. **\`.env\` 新增变量**：新功能若引入新环境变量，本机旧 \`.env\` 里没有。先比对：
   \`\`\`powershell
   # 列出新包 env 里有、而本机 .env 里没有的键
   $new = (Get-Content <新包>\\data\\env) -replace '=.*$' | Where-Object { $_ -match '^[A-Z_]+$' }
   $old = (Get-Content .env)          -replace '=.*$' | Where-Object { $_ -match '^[A-Z_]+$' }
   Compare-Object $old $new | Where-Object SideIndicator -eq '=>'
   \`\`\`
   有输出就把对应行补进 \`.env\`，重启 API 生效。
2. **网关新增渠道**：macOS 端新配的渠道（channels + abilities 表）**不会**同步，
   新功能若依赖新渠道会报 503 "No available channel"。在网关管理台
   （http://127.0.0.1:18780）手动补，或对照第 4 节渠道布局。

> 为什么不做自动合并：settings.db / one-api.db 是整库文件，覆盖只能单向 ——
> 两端都写过必然丢一边。渠道这类低频配置手动同步，比引入双向同步机制划算得多。

## 4. 环境关键状态（迁移后应当保持的事实）

- **网关管理台**：http://127.0.0.1:18780 ，账号 \`root\` / 密码 \`123456\`
- **额度**：所有已配模型按次 \$0（options 表 ModelPrice），root quota 1e15——记账不挡路，
  新模型也无需配置额度
- **ServerAddress** 已在 one-api.db 的 options 表设为 \`http://127.0.0.1:18780\`（默认 localhost:3000 是错的）
- **渠道布局**（one-api.db channels，以库内实际为准）：
  - DC-openai：LLM（gpt-5.6-luna 等），key 为 LLM 专用（无图片权限，403）
  - DC-yyds-image：图片（gpt-image-2.5-flare 等），key 为图片专用
  - DC-agnes-openai：视频（agnes-video-2.5-flash）
  - DC-deepseek / DC-siliconflow(Embedding) / DC-sharellm(cognee) / DC-stepfun(TTS)
  - DC-fal_ai / DC-replicate 已禁用（适配器对 OpenAI 兼容中转拼错 URL，勿启用）
- **DC 逻辑模型**：LingShan-G2 / LingShan-NB-2 映射到 gpt-image-2.5-flare（网关渠道的
  model_mapping + abilities + models 三处都有才路由，缺了 503）
- **媒体模型映射**（settings.db custom_newapi_media_model_mappings）：provider 必须指向
  **启用状态**的渠道，指向禁用渠道的映射完全不生效且 UI 无提示
- **自定义渠道名**仅支持小写英文/数字/中划线/下划线（store 归一化约束，中文会被静默替换）

## 5. 已知问题（非配置错误，无需排查）

1. **yyds 上游 images/edits 间歇性故障**：同请求时成时败（502 "Please retry later"），
   属中转站侧问题。曾配过自动重试容灾，主人明确要求撤除（"不是根源问题"）。失败让用户手动重试。
2. 画布模型清单里的 \`seedance-*\` / \`LingShan-NB-Pro\` 是官方目录模型，自定义渠道模式下不可选。
3. **3D 导演台在 Windows 上可能装不上**：world extra 依赖 \`sharp\`（apple/ml-sharp 源码构建）
   与 \`gsplat\`（CUDA 扩展），Windows 侧 wheel 匹配不保证。\`start.ps1\` 已做降级——
   装失败会退回基础依赖并提示，**不影响其余全部功能**。macOS 端（Metal/MPS）是验证过可用的。

## 6. 验证清单（部署完成后逐项过）

\`\`\`powershell
# 1. 三件套就绪（start.ps1 会自动等待并提示）
curl http://127.0.0.1:18780/api/status        # 网关
curl http://127.0.0.1:8780/healthz            # API
curl http://127.0.0.1:5173/                    # 前端

# 2. 渠道类型接口（验证 NEWAPI_SQLITE_PATH 正确）
# 应返回 {"ok":true,"data":{"items":[...渠道类型列表...]}}
curl http://127.0.0.1:8780/api/v1/model-gateway/custom/newapi/channel-types

# 3. 浏览器打开 http://localhost:5173
#    - 进入项目 → 虾画 → 应能看到已有画布节点（output/ 数据就位）
#    - 设置 → 模型配置 → 高级：渠道行应有 yyds-image / openai 等
#    - "供应商渠道管理"弹窗应有渠道类型列表（不再是空白）

# 4. 生成验证（真实链路）
#    - 画布图片节点生成一张（走 LingShan-G2 → flare）
#    - 模型输入框点"拉取模型"应返回上游真实模型列表

# 5. 视频验证（验证 public-proxy 补丁在 exe 里生效）
#    - 画布视频节点生成（agnes-video-2.5-flash），完成后能正常播放
#    - 若下载 401，说明 exe 不是带补丁的版本

# 6. 风格图墙 / 提示词画廊（验证 style-gallery 数据就位）
#    - 打开提示词画廊（风格图墙）应能看到 225 张风格图，不是空白/裂图

# 7. 3D 导演台（验证 --extra world 装好了）
#    在仓库根跑下面这条，两个都应为 True：
#      uv run python -c "from novelvideo.director_world import pano_sharp; print(pano_sharp.sharp_available(), pano_sharp.da2_available())"
#    - False 说明 world extra 没装上：重跑 uv sync --extra world
#    - 另需 splat-transform 在 PATH：Get-Command splat-transform
#    - 首次做全景世界会在首次推理时下载模型权重（Apple CDN + HuggingFace），属正常
#    - Windows 上 gsplat/torch 的 wheel 匹配不保证（见第 5 节已知问题 3）
\`\`\`

## 7. 常见坑速查

| 症状 | 原因 | 解法 |
|---|---|---|
| 供应商渠道管理弹窗空白/502 | \`.env\` 的 \`NEWAPI_SQLITE_PATH\` 还是 macOS 路径 | 改成 Windows 实际路径，重启 API |
| API 报 DATA_ROOT/找不到项目 | API 不在仓库根目录启动 | \`cd dramaclaw && uv run novelvideo api --port 8780\` |
| 视频生成成功但下载 401 | 网关二进制无 public-proxy 补丁 | 用本包的 newapi.exe（或从 zjhr/dramaclaw-gateway main 重编译） |
| 图片生成 403 permission_error | 请求路由到了 LLM 渠道（key 无图片权限） | 检查媒体映射 provider 是否指向 yyds-image |
| 图片生成 503 no available channel | 逻辑模型没挂到任何启用渠道 | 网关渠道补 models + model_mapping + abilities 三处 |
| start.ps1 找不到网关 | 网关目录与主仓库不同级 | 设 \`\$env:DRAMACLAW_GATEWAY\` 指向网关目录 |

## 8. 数据备份提醒

\`one-api.db\`、\`state/local/\`、\`output/\`、\`.env\` 均不在 git 内，机器间迁移只能靠拷贝。
建议 Windows 端就位后再做一份冷备份。
EOF

# ---------- 5. 打包 ----------
echo "▸ 打包 → $ZIP_PATH"
rm -f "$ZIP_PATH"
(cd "$(dirname "$STAGE")" && zip -r -q "$ZIP_PATH" "$(basename "$STAGE")")

echo ""
echo "✓ 交接包已生成: $ZIP_PATH"
ls -lh "$ZIP_PATH" | awk '{print "  大小: "$5}'
echo "  提交版本: dramaclaw @ ${DC_COMMIT} / gateway @ ${GW_COMMIT}"
echo "  ⚠ 包内含上游 API Key 等敏感信息，请用可信渠道传输"
