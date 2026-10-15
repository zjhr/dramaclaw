#!/usr/bin/env bash
# DramaClaw 本地一键启动：网关(:18780) + API(:8780) + 前端(:5173)
# 用法: ./start.sh          启动全部
#       ./start.sh stop     停止全部
set -euo pipefail

REPO="/Users/mac/ai/dramaclaw"
GATEWAY="/Users/mac/ai/dramaclaw-gateway"
LOG_DIR="$REPO/.local-logs"
mkdir -p "$LOG_DIR"

port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

wait_up() { # wait_up <url> <名称> <日志文件> [重试次数]
  local url="$1" name="$2" logfile="$3" attempts="${4:-30}"
  for _ in $(seq 1 "$attempts"); do
    curl -s -m 2 -o /dev/null "$url" && { echo "✓ $name 就绪"; return 0; }
    sleep 1
  done
  # 光说「超时」等于把真因（依赖没装完 / 端口被占 / 进程崩了）埋在日志里，
  # 这里直接把日志尾部打出来，省掉一轮「翻文件」。
  echo "✗ $name 启动超时（等待 ${attempts}s）"
  echo "── $LOG_DIR/$logfile 尾部 ──"
  tail -n 15 "$LOG_DIR/$logfile" 2>/dev/null | sed 's/^/    /'
  echo "────────────────────────────"
  exit 1
}

start() {
  # 依赖同步必须**先做完**再起服务。
  # 原因：`uv run` 会先同步依赖、再 exec 服务进程；而官方新增的 openai-codex 带着
  # 一个 ~105MB 的二进制 wheel，首次要下几分钟。若把它留在后面的就绪等待窗口里，
  # 表现就是「API 启动超时」，真因（下载慢/超时）反而看不见。
  # 已同步时 uv sync 是秒级空操作，所以这里不判断是否首次，一律跑一遍。
  echo "同步 Python 依赖 (uv sync)..."
  (cd "$REPO" && UV_HTTP_TIMEOUT="${UV_HTTP_TIMEOUT:-600}" uv sync)

  echo "同步前端依赖 (pnpm install)..."
  (cd "$REPO/frontend" && pnpm install)

  [ -d "$GATEWAY" ] || { echo "✗ 网关目录不存在: $GATEWAY"; exit 1; }

  # kill 后端口可能有 TIME_WAIT 残留，等它释放
  for port in 18780 8780 5173; do
    for _ in $(seq 1 10); do
      port_busy "$port" || break
      sleep 1
    done
    port_busy "$port" && { echo "✗ :$port 持续被占用"; exit 1; }
  done

  echo "启动网关..."
  (cd "$GATEWAY" && nohup ./newapi-bin --port 18780 --log-dir ./logs >"$LOG_DIR/gateway.out" 2>&1 &)
  wait_up http://localhost:18780/api/status 网关 gateway.out 30

  echo "启动 DramaClaw API..."
  (cd "$REPO" && nohup uv run novelvideo api --port 8780 >"$LOG_DIR/api.out" 2>&1 &)
  # 90s：API 冷启动要导入 Cognee，实测 15~25s 属正常，给足余量避免误判。
  wait_up http://localhost:8780/healthz API api.out 90

  echo "启动前端..."
  (cd "$REPO/frontend" && nohup pnpm dev >"$LOG_DIR/web.out" 2>&1 &)
  # 60s：首次 vite 需要预构建依赖（optimize deps），比后续启动慢。
  wait_up http://localhost:5173/ 前端 web.out 60

  echo ""
  echo "全部就绪:  http://localhost:5173  (API :8780 / 网关 :18780)"
  echo "日志目录:  $LOG_DIR"
}

stop() {
  for port in 5173 8780 18780; do
    pids=$(lsof -t -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
    [ -n "$pids" ] && kill $pids && echo "已停止 :$port (pid $pids)" || echo ":$port 未运行"
  done
}

case "${1:-start}" in
  start) start ;;
  stop)  stop  ;;
  *) echo "用法: $0 [start|stop]"; exit 1 ;;
esac
