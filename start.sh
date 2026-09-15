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

wait_up() { # wait_up <url> <名称>
  for _ in $(seq 1 30); do
    curl -s -m 2 -o /dev/null "$1" && { echo "✓ $2 就绪"; return 0; }
    sleep 1
  done
  echo "✗ $2 启动超时，查看 $LOG_DIR/$3"; exit 1
}

start() {
  # 首次初始化：缺啥补啥，已装过则跳过
  [ -d "$REPO/.venv" ] || { echo "首次运行: uv sync 安装依赖..."; (cd "$REPO" && uv sync); }
  [ -d "$REPO/frontend/node_modules" ] || { echo "首次运行: pnpm install 安装前端依赖..."; (cd "$REPO/frontend" && pnpm install); }
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
  wait_up http://localhost:18780/api/status 网关 gateway.out

  echo "启动 DramaClaw API..."
  (cd "$REPO" && nohup uv run novelvideo api --port 8780 >"$LOG_DIR/api.out" 2>&1 &)
  wait_up http://localhost:8780/healthz API api.out

  echo "启动前端..."
  (cd "$REPO/frontend" && nohup pnpm dev >"$LOG_DIR/web.out" 2>&1 &)
  wait_up http://localhost:5173/ 前端 web.out

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
