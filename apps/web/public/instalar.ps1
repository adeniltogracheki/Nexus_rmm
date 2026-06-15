# ============================================================================
#  Nexus RMM -- Instalador do Agente (PowerShell)
#  Uso (o painel gera este comando com o token):
#    iex ((New-Object System.Net.WebClient).DownloadString('https://rmm.gmtec.tec.br/instalar.ps1'))
#    Instalar-Nexus -Token "<token-do-painel>"
# ============================================================================

function Instalar-Nexus {
  param(
    [string]$Token,
    [switch]$Clean
  )
  $ErrorActionPreference = "Stop"
  $base = "https://rmm.gmtec.tec.br"
  $dir = Join-Path $env:LOCALAPPDATA "NexusAgente"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null

  # Node.js DEDICADO do agente (versao fixa v24 p/ casar com o binario nativo do node-pty/ConPTY).
  $nodeExe = Join-Path $dir "node.exe"
  $precisaNode = $true
  if (Test-Path $nodeExe) {
    try { $vNode = (& $nodeExe --version) 2>$null; if ($vNode -like "v24.*") { $precisaNode = $false } } catch {}
  }
  if ($precisaNode) {
    Write-Host "Baixando Node.js 24 dedicado do agente..." -ForegroundColor Cyan
    try {
      Invoke-WebRequest "https://nodejs.org/dist/v24.15.0/win-x64/node.exe" -OutFile $nodeExe -UseBasicParsing
      if (Get-Command Unblock-File -ErrorAction SilentlyContinue) { Unblock-File -Path $nodeExe }
      Write-Host "Node.js 24 baixado em: $nodeExe" -ForegroundColor Green
    } catch {
      Write-Host "Erro ao baixar o Node.js: $($_.Exception.Message)" -ForegroundColor Red
      return
    }
  } else {
    Write-Host "Node.js 24 do agente ja presente: $nodeExe" -ForegroundColor Green
  }

  # Verifica VC++ Runtime (necessario para node.exe)
  $hasVc = $false
  foreach ($p in @("$env:SystemRoot\System32\vcruntime140.dll", "$env:SystemRoot\SysWOW64\vcruntime140.dll")) {
    if (Test-Path $p) { $hasVc = $true }
  }
  if (-not $hasVc) {
    Write-Host "VC++ Redistributable nao encontrado. Instalando..." -ForegroundColor Cyan
    $vcUrl  = "https://aka.ms/vs/17/release/vc_redist.x64.exe"
    $vcPath = Join-Path $dir "vc_redist.x64.exe"
    try {
      Invoke-WebRequest $vcUrl -OutFile $vcPath -UseBasicParsing
      $vcProc = Start-Process -FilePath $vcPath -ArgumentList "/quiet /norestart" -PassThru -Wait
      if ($vcProc.ExitCode -eq 0 -or $vcProc.ExitCode -eq 3010) {
        Write-Host "VC++ instalado com sucesso." -ForegroundColor Green
      } else {
        Write-Host "Aviso: VC++ retornou codigo $($vcProc.ExitCode)." -ForegroundColor Yellow
      }
    } catch {
      Write-Host "Aviso: nao foi possivel instalar VC++: $($_.Exception.Message)" -ForegroundColor Yellow
    } finally {
      Remove-Item $vcPath -Force -ErrorAction SilentlyContinue
    }
  }

  # -------------------------------------------------------------------------
  # Encerrar agente anterior (3 camadas, cross-session, Windows 10/11 sem wmic)
  # -------------------------------------------------------------------------
  Write-Host "Encerrando agente anterior (se houver)..." -ForegroundColor Cyan

  # Camada 1: PID salvo pelo proprio agente
  $pidFile = Join-Path $dir "agent.pid"
  if (Test-Path $pidFile) {
    try {
      $oldPid = (Get-Content $pidFile -Raw).Trim()
      if ($oldPid -match '^\d+$') {
        $proc = Get-Process -Id ([int]$oldPid) -ErrorAction SilentlyContinue
        if ($proc -and $proc.ProcessName -eq "node") {
          Write-Host "  Parando PID $oldPid (do agent.pid)..." -ForegroundColor Yellow
          Stop-Process -Id ([int]$oldPid) -Force -ErrorAction SilentlyContinue
        }
      }
    } catch {}
  }

  # Camada 2: CIM Terminate() -- cross-session, funciona no Windows 11 sem wmic
  try {
    $procs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
               Where-Object { $_.CommandLine -like "*NexusAgente*" }
    foreach ($p in $procs) {
      Write-Host "  Encerrando node.exe PID $($p.ProcessId) via CIM..." -ForegroundColor Yellow
      $p | Invoke-CimMethod -MethodName Terminate -ErrorAction SilentlyContinue | Out-Null
    }
    $svcProcs = Get-CimInstance Win32_Process -Filter "Name = 'wscript.exe'" |
                  Where-Object { $_.CommandLine -like "*iniciar.vbs*" }
    foreach ($p in $svcProcs) {
      Write-Host "  Encerrando wscript.exe PID $($p.ProcessId) via CIM..." -ForegroundColor Yellow
      $p | Invoke-CimMethod -MethodName Terminate -ErrorAction SilentlyContinue | Out-Null
    }
  } catch {}

  # Camada 3: Stop-Process direto -- admin pode matar SYSTEM
  try {
    $targets = Get-Process -Name node -ErrorAction SilentlyContinue |
                 Where-Object { $_.Path -like "*NexusAgente*" }
    foreach ($p in $targets) {
      Write-Host "  Stop-Process node PID $($p.Id)..." -ForegroundColor Yellow
      $p | Stop-Process -Force -ErrorAction SilentlyContinue
    }
  } catch {}

  # Aguarda processos encerrarem antes de sobrescrever arquivos
  $waited = 0
  while ($waited -lt 5) {
    $still = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
               Where-Object { $_.CommandLine -like "*NexusAgente*" }
    if (-not $still) { break }
    Start-Sleep -Seconds 1
    $waited++
  }

  # Remover servico NSSM anterior (se existir)
  $nssmExe = Join-Path $dir "nssm.exe"
  if (Test-Path $nssmExe) {
    try {
      & $nssmExe stop NexusAgente 2>$null | Out-Null
      Start-Sleep -Seconds 1
      & $nssmExe remove NexusAgente confirm 2>$null | Out-Null
      Start-Sleep -Seconds 1
    } catch {}
  }

  # Remover tarefa agendada anterior (fallback legado)
  try {
    if (Get-ScheduledTask -TaskName "NexusAgente" -ErrorAction SilentlyContinue) {
      Write-Host "Removendo tarefa agendada anterior (NexusAgente)..." -ForegroundColor Yellow
      Unregister-ScheduledTask -TaskName "NexusAgente" -Confirm:$false -ErrorAction SilentlyContinue
    }
  } catch {
    Write-Host "Aviso: nao foi possivel remover tarefa agendada antiga." -ForegroundColor Yellow
  }

  # -------------------------------------------------------------------------
  # Validar cadastro existente
  # -------------------------------------------------------------------------
  $stateFile = Join-Path $dir "agent-state.json"
  $cadastroValido = $false
  if (Test-Path $stateFile) {
    if ($Clean) {
      Write-Host "Limpeza forcada (-Clean). Removendo estado anterior..." -ForegroundColor Yellow
      Remove-Item $stateFile -Force -ErrorAction SilentlyContinue
    } else {
      try {
        $state = Get-Content $stateFile -Raw | ConvertFrom-Json
        if ($state.machineId -and $state.cert -and $state.key) {
          $cadastroValido = $true
          Write-Host "Cadastro existente encontrado (Machine ID: $($state.machineId)). Preservando chaves." -ForegroundColor Green
        }
      } catch {
        Write-Host "Arquivo de estado corrompido. Sera recriado." -ForegroundColor Yellow
        Remove-Item $stateFile -Force -ErrorAction SilentlyContinue
      }
    }
  }

  if (-not $cadastroValido) {
    if (-not $Token) {
      Write-Host "Erro: Nenhum cadastro valido e -Token nao informado." -ForegroundColor Red
      return
    }
    Write-Host "Novo cadastro sera realizado usando o Token..." -ForegroundColor Cyan
  }

  # -------------------------------------------------------------------------
  # Download de arquivos
  # -------------------------------------------------------------------------
  Write-Host "Baixando o agente Nexus..." -ForegroundColor Cyan
  Invoke-WebRequest "$base/agente/agent.js" -OutFile (Join-Path $dir "agent.js") -UseBasicParsing
  if (Get-Command Unblock-File -ErrorAction SilentlyContinue) { Unblock-File -Path (Join-Path $dir "agent.js") }

  # Garante package.json com "type":"commonjs" -- agent.js e bundle CJS, nao ES module.
  Set-Content -Path (Join-Path $dir "package.json") -Value '{"type":"commonjs"}' -Encoding UTF8

  Push-Location $dir
  try {
    # ConPTY (terminal real) -- best-effort, agente funciona sem ele
    try {
      $ptyZip = Join-Path $dir "node-pty.zip"
      $nmDir  = Join-Path $dir "node_modules"
      Write-Host "Baixando componente de terminal real (ConPTY)..." -ForegroundColor Cyan
      Invoke-WebRequest "$base/agente/node-pty.zip" -OutFile $ptyZip -UseBasicParsing
      if (Test-Path $nmDir) { Remove-Item $nmDir -Recurse -Force -ErrorAction SilentlyContinue }
      Expand-Archive -Path $ptyZip -DestinationPath $nmDir -Force
      Remove-Item $ptyZip -Force -ErrorAction SilentlyContinue
      Write-Host "ConPTY instalado." -ForegroundColor Green
    } catch {
      Write-Host "ConPTY nao instalado (terminal usara modo pipe): $($_.Exception.Message)" -ForegroundColor Yellow
    }

    $agentScript = Join-Path $dir "agent.js"
    $stdoutLog   = Join-Path $dir "agent-output.log"
    $stderrLog   = Join-Path $dir "agent-error.log"

    # -----------------------------------------------------------------------
    # NSSM -- cria Servico Windows real (services.msc), roda como SYSTEM,
    # boot automatico, reinicio automatico, sem janela, log rotativo 10 MB.
    # -----------------------------------------------------------------------
    $nssmOk = $false
    try {
      if (-not (Test-Path $nssmExe)) {
        Write-Host "Baixando NSSM (gerenciador de servico Windows)..." -ForegroundColor Cyan
        Invoke-WebRequest "$base/agente/nssm.exe" -OutFile $nssmExe -UseBasicParsing
        if (Get-Command Unblock-File -ErrorAction SilentlyContinue) { Unblock-File -Path $nssmExe }
      }
      if ((Test-Path $nssmExe) -and ((Get-Item $nssmExe).Length -gt 100kb)) {
        $nssmOk = $true
      }
    } catch {
      Write-Host "NSSM nao disponivel, usando Tarefa Agendada como fallback." -ForegroundColor Yellow
    }

    if ($nssmOk) {
      & $nssmExe install NexusAgente $nodeExe "`"$agentScript`"" 2>$null | Out-Null
      & $nssmExe set NexusAgente AppDirectory $dir 2>$null | Out-Null
      & $nssmExe set NexusAgente AppStdout $stdoutLog 2>$null | Out-Null
      & $nssmExe set NexusAgente AppStderr $stderrLog 2>$null | Out-Null
      & $nssmExe set NexusAgente AppStdoutCreationDisposition 4 2>$null | Out-Null
      & $nssmExe set NexusAgente AppStderrCreationDisposition 4 2>$null | Out-Null
      & $nssmExe set NexusAgente AppRotateFiles 1 2>$null | Out-Null
      & $nssmExe set NexusAgente AppRotateBytes 10485760 2>$null | Out-Null
      & $nssmExe set NexusAgente Start SERVICE_AUTO_START 2>$null | Out-Null
      & $nssmExe set NexusAgente ObjectName LocalSystem 2>$null | Out-Null
      & $nssmExe set NexusAgente DisplayName "Nexus RMM Agent" 2>$null | Out-Null
      & $nssmExe set NexusAgente Description "Agente Nexus RMM - GMTec" 2>$null | Out-Null
      Write-Host "Servico Windows instalado (NexusAgente) - visivel em services.msc." -ForegroundColor Green
    } else {
      # Fallback: Tarefa Agendada como SYSTEM
      try {
        $action    = New-ScheduledTaskAction -Execute $nodeExe -Argument "`"$agentScript`"" -WorkingDirectory $dir
        $trigger   = New-ScheduledTaskTrigger -AtStartup
        $settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
        $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
        Register-ScheduledTask -TaskName "NexusAgente" -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
        Write-Host "Tarefa agendada registrada (NexusAgente) - sobe no boot como SYSTEM." -ForegroundColor Green
      } catch {
        try {
          $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -RunLevel Highest
          $trigger2  = New-ScheduledTaskTrigger -AtLogOn
          Register-ScheduledTask -TaskName "NexusAgente" -Action $action -Trigger $trigger2 -Settings $settings -Principal $principal -Force | Out-Null
          Write-Host "Tarefa de logon registrada (sem admin completo)." -ForegroundColor Yellow
        } catch {
          Write-Host "Aviso: nao foi possivel registrar tarefa de persistencia." -ForegroundColor Yellow
        }
      }
    }

    # Remove logs anteriores
    Remove-Item $stdoutLog -Force -ErrorAction SilentlyContinue
    Remove-Item $stderrLog -Force -ErrorAction SilentlyContinue

    if ($cadastroValido) {
      Write-Host "Iniciando agente RMM principal com chaves preservadas..." -ForegroundColor Cyan
      if ($nssmOk) {
        & $nssmExe start NexusAgente 2>$null | Out-Null
      } else {
        Start-Process -FilePath $nodeExe -ArgumentList "`"$agentScript`"" -WorkingDirectory $dir `
          -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -WindowStyle Hidden | Out-Null
      }
      Start-Sleep -Seconds 5
      Write-Host ""
      Write-Host "Pronto! A maquina deve aparecer ONLINE no painel em alguns segundos." -ForegroundColor Green
      if (Test-Path $stderrLog) {
        $errContent = Get-Content $stderrLog -Raw -ErrorAction SilentlyContinue
        if ($null -ne $errContent -and $errContent.Trim()) {
          Write-Host "Log inicial:" -ForegroundColor DarkGray
          Write-Host ($errContent -split "`n" | Select-Object -First 10 | Out-String).Trim() -ForegroundColor Gray
        }
      }
    } else {
      Write-Host "Iniciando agente RMM para realizacao de cadastro..." -ForegroundColor Cyan
      $env:NEXUS_ENROLL_TOKEN = $Token
      $processoAgente = Start-Process -FilePath $nodeExe -ArgumentList "`"$agentScript`" --token=$Token" `
        -WorkingDirectory $dir -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog `
        -WindowStyle Hidden -PassThru

      Write-Host "Aguardando confirmacao de cadastro (5 segundos)..." -ForegroundColor DarkGray
      Start-Sleep -Seconds 5

      $cadastroSucedido = Test-Path $stateFile
      if (-not $cadastroSucedido) {
        Write-Host "Erro: O cadastro da maquina falhou." -ForegroundColor Red
        if (Test-Path $stderrLog) {
          $errContent = Get-Content $stderrLog -Raw -ErrorAction SilentlyContinue
          if ($null -ne $errContent -and $errContent.Trim()) {
            Write-Host "Erro capturado:" -ForegroundColor Red
            Write-Host $errContent -ForegroundColor Yellow
          }
        }
        if (Test-Path $stdoutLog) {
          $outContent = Get-Content $stdoutLog -Raw -ErrorAction SilentlyContinue
          if ($null -ne $outContent -and $outContent.Trim()) {
            Write-Host "Output:" -ForegroundColor DarkGray
            Write-Host $outContent -ForegroundColor Gray
          }
        }
        return
      }

      Write-Host ""
      Write-Host "Pronto! A maquina foi cadastrada." -ForegroundColor Green
      Write-Host "Iniciando agente em modo permanente..." -ForegroundColor Cyan
      if ($nssmOk) {
        & $nssmExe start NexusAgente 2>$null | Out-Null
      } else {
        Start-Process -FilePath $nodeExe -ArgumentList "`"$agentScript`"" -WorkingDirectory $dir `
          -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -WindowStyle Hidden | Out-Null
      }
      Start-Sleep -Seconds 3
      Write-Host "Agente iniciado. A maquina deve aparecer ONLINE no painel em alguns segundos." -ForegroundColor Green
    }
  } finally {
    Pop-Location
  }
}
