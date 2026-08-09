# 启动本地文件 MCP + 临时 HTTPS Tunnel
# 运行后复制 cloudflared 输出的 https://*.trycloudflare.com，拼接 /mcp 填入 ChatGPT 插件。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
if (!(Test-Path '.env')) { Copy-Item '.env.example' '.env'; Write-Host '已创建 .env；先修改 MCP_TOKEN 再重新运行。' -ForegroundColor Yellow; exit 1 }
$port = [int]((Get-Content '.env' | Where-Object { $_ -match '^PORT=' } | Select-Object -First 1) -replace '^PORT=', '')
if (!$port) { $port = 8787 }
$running = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
if (!$running) { Start-Process -FilePath node -ArgumentList 'src/server.js' -WorkingDirectory $root; Start-Sleep -Seconds 1 }
cloudflared tunnel --url "http://127.0.0.1:$port"
