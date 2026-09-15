# DramaClaw 本地一键启动 (Windows): 网关(:18780) + API(:8780) + 前端(:5173)
# 用法: .\start.ps1          启动全部
#       .\start.ps1 -Action stop    停止全部
param([string]$Action = "start")

$ErrorActionPreference = "Stop"

# 脚本放在仓库根目录；网关目录可用 $env:DRAMACLAW_GATEWAY 覆盖
$Repo = $PSScriptRoot
$Gateway = if ($env:DRAMACLAW_GATEWAY) { $env:DRAMACLAW_GATEWAY } else { Join-Path (Split-Path $Repo -Parent) "dramaclaw-gateway" }
$LogDir = Join-Path $Repo ".local-logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Test-PortBusy([int]$Port) {
    return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Wait-Up([string]$Url, [string]$Name, [string]$LogFile) {
    for ($i = 0; $i -lt 30; $i++) {
        try {
            Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2 | Out-Null
            Write-Host "✓ $Name 就绪"
            return
        } catch { Start-Sleep -Seconds 1 }
    }
    Write-Host "✗ $Name 启动超时，查看 $LogDir\$LogFile"
    exit 1
}

function Start-All {
    # 首次初始化：缺啥补啥，已装过则跳过
    if (-not (Test-Path (Join-Path $Repo ".venv"))) {
        Write-Host "首次运行: uv sync 安装依赖..."
        Start-Process -FilePath "uv" -ArgumentList "sync" -WorkingDirectory $Repo -Wait -NoNewWindow
    }
    if (-not (Test-Path (Join-Path $Repo "frontend\node_modules"))) {
        Write-Host "首次运行: pnpm install 安装前端依赖..."
        Start-Process -FilePath "pnpm" -ArgumentList "install" -WorkingDirectory (Join-Path $Repo "frontend") -Wait -NoNewWindow
    }
    if (-not (Test-Path $Gateway)) { Write-Host "✗ 网关目录不存在: $Gateway (可用环境变量 DRAMACLAW_GATEWAY 指定)"; exit 1 }

    # kill 后端口可能有 TIME_WAIT 残留，等它释放
    foreach ($port in 18780, 8780, 5173) {
        for ($i = 0; $i -lt 10 -and (Test-PortBusy $port); $i++) { Start-Sleep -Seconds 1 }
        if (Test-PortBusy $port) { Write-Host "✗ :$port 持续被占用"; exit 1 }
    }

    # 网关二进制: Windows 为 newapi.exe，mac/linux 为 newapi-bin
    $gatewayBin = Join-Path $Gateway "newapi.exe"
    if (-not (Test-Path $gatewayBin)) { $gatewayBin = Join-Path $Gateway "newapi-bin" }

    Write-Host "启动网关..."
    Start-Process -FilePath $gatewayBin -ArgumentList "--port", "18780", "--log-dir", "./logs" `
        -WorkingDirectory $Gateway -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $LogDir "gateway.out") -RedirectStandardError (Join-Path $LogDir "gateway.err")
    Wait-Up "http://localhost:18780/api/status" "网关" "gateway.out"

    Write-Host "启动 DramaClaw API..."
    Start-Process -FilePath "uv" -ArgumentList "run", "novelvideo", "api", "--port", "8780" `
        -WorkingDirectory $Repo -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $LogDir "api.out") -RedirectStandardError (Join-Path $LogDir "api.err")
    Wait-Up "http://localhost:8780/healthz" "API" "api.out"

    Write-Host "启动前端..."
    Start-Process -FilePath "pnpm" -ArgumentList "dev" `
        -WorkingDirectory (Join-Path $Repo "frontend") -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $LogDir "web.out") -RedirectStandardError (Join-Path $LogDir "web.err")
    Wait-Up "http://localhost:5173/" "前端" "web.out"

    Write-Host ""
    Write-Host "全部就绪:  http://localhost:5173  (API :8780 / 网关 :18780)"
    Write-Host "日志目录:  $LogDir"
}

function Stop-All {
    foreach ($port in 5173, 8780, 18780) {
        $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        if ($conns) {
            $conns | Select-Object -ExpandProperty OwningProcess -Unique |
                ForEach-Object { Stop-Process -Id $_ -Force; Write-Host "已停止 :$port (pid $_)" }
        } else {
            Write-Host ":$port 未运行"
        }
    }
}

switch ($Action) {
    "start" { Start-All }
    "stop"  { Stop-All }
    default { Write-Host "用法: .\start.ps1 [-Action start|stop]"; exit 1 }
}
