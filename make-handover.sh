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
for dir in "$REPO"/state/local/*/; do
  [ -d "$dir" ] && cp -R "$dir" "$STAGE/data/state-local/"
done

echo "▸ 拷贝生成产物 output/..."
cp -R "$REPO/output" "$STAGE/data/output"

echo "▸ 拷贝 .env（含敏感 Key，注意传输安全）..."
cp "$REPO/.env" "$STAGE/data/env"

# ---------- 3. 动态信息 ----------
DC_COMMIT="$(cd "$REPO" && git rev-parse --short HEAD)"
GW_COMMIT="$(cd "$GATEWAY" && git rev-parse --short HEAD)"
STAMP="$(date '+%Y-%m-%d %H:%M')"

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
newapi.exe            Windows amd64 网关二进制（含 public-proxy 补丁，Go 交叉编译）
data/one-api.db       网关 SQLite 库（渠道/上游 Key/额度/账号）
data/env              DramaClaw 的 .env 模板（原样拷自 macOS 环境）
data/state-local/     DramaClaw API 的本地状态（settings.db / projects.db / 项目数据）
data/output/          生成产物（画布图片/视频等）
\`\`\`

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

## 2. 前置安装（Windows）

1. **uv**（Python 管理）：\`winget install astral-sh.uv\` 或官网安装器
2. **Node.js + pnpm**：装 Node 20+，然后 \`npm i -g pnpm\`（前端 dev 需要）
3. **不需要 Go**——网关二进制已随包提供（\`newapi.exe\`）
4. git

## 3. 部署步骤（极简版：只 clone 主仓库）

主仓库必须 clone（API + 前端源码）；**网关不需要 clone**——\`newapi.exe\` 已带全部补丁，
建一个普通目录放二进制和库即可（源码留到将来要重编译网关时再 clone）。

\`\`\`powershell
# 1. clone 主仓库
cd C:\\Users\\<你>\\ai
git clone https://github.com/zjhr/dramaclaw.git

# 2. 建网关目录（不 clone），放入交接包里的两样东西
mkdir dramaclaw-gateway
copy <交接包>\\newapi.exe            dramaclaw-gateway\\newapi.exe
copy <交接包>\\data\\one-api.db       dramaclaw-gateway\\one-api.db

# 3. 放数据（本交接包的 data/）
copy <交接包>\\data\\env              dramaclaw\\.env
# state-local 整个目录内容放入 dramaclaw\\state\\local\\
# output 整个目录放入 dramaclaw\\output\\

# 4. 修改 .env（唯一必改项）
# 找到 NEWAPI_SQLITE_PATH，改为 Windows 实际路径，例如：
#   NEWAPI_SQLITE_PATH=C:/Users/<你>/ai/dramaclaw-gateway/one-api.db
# （原值是 macOS 绝对路径 /Users/mac/...，不改则"供应商渠道管理"弹窗会 502 空白）

# 5. 一键启动（首次会自动 uv sync + pnpm install）
cd dramaclaw
.\\start.ps1
\`\`\`

> 网关源码仓库（https://github.com/zjhr/dramaclaw-gateway.git）本次不需要；
> 将来若要重编译网关或同步上游（\`dramaclaw/dramaclaw-gateway\`），再 clone 它。
> 注意：上游合并冲突时必须保住 \`relay/relay_task.go\` / \`service/task_polling.go\` 的
> \`BuildPublicProxyURL\` 四处（视频下载免鉴权补丁）。

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
