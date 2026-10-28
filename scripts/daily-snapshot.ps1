# Loaded by launch.ps1. All program snapshots and staging stay below its private .local.

function Assert-PrivatePath([string] $Path) {
  $root = [IO.Path]::GetFullPath($LocalRoot).TrimEnd('\')
  $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  if (-not ($full.Equals($root, [StringComparison]::OrdinalIgnoreCase) -or $full.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase))) {
    throw ('路径不在启动器私有目录内：' + $full)
  }
  $current = $full
  while ($current.Length -ge $root.Length) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw ('启动器私有路径不能是目录联接或符号链接：' + $current)
      }
    }
    if ($current.Equals($root, [StringComparison]::OrdinalIgnoreCase)) { break }
    $current = Split-Path -Parent $current
  }
}

function Open-DailyLock([bool] $Exclusive) {
  Assert-PrivatePath $LocalRoot
  if (-not (Test-Path -LiteralPath $LocalRoot)) { [void](New-Item -ItemType Directory -Path $LocalRoot) }
  $sharing = [IO.FileShare]::ReadWrite
  if ($Exclusive) { $sharing = [IO.FileShare]::None }
  return [IO.File]::Open((Join-Path $LocalRoot 'daily.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, $sharing)
}

function Get-SnapshotFileHash([string] $Path) {
  $stream = [IO.File]::OpenRead($Path)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '') }
  finally { $algorithm.Dispose(); $stream.Dispose() }
}

<# 只核对快照身份：私有路径、清单可读、kind 与 schemaVersion 正确。
   更新器在替换旧快照前也用这一层，因此不断言新版本才有的文件。 #>
function Assert-DailySnapshotManifest {
  Assert-PrivatePath $DailyRoot
  $manifest = Join-Path $DailyRoot 'snapshot.json'
  if (-not (Test-Path -LiteralPath $manifest)) {
    Fail '尚未准备日用构建。' '请先执行 npm run build 并完成必要验证，再执行 update-daily.cmd。日用启动不会自动构建。'
  }
  try { $snapshot = ([IO.File]::ReadAllText($manifest)) | ConvertFrom-Json }
  catch { Fail '日用快照清单无法读取。' $_.Exception.Message }
  if ($snapshot.kind -ne 'aichat-daily' -or $snapshot.schemaVersion -ne 1) {
    Fail '无法识别此日用快照。' '不要把用户工作区放进 .local/daily；请用 update-daily.cmd 准备程序快照。'
  }
}

<# 日用启动前核对完整快照：身份 + 全部运行产物、根入口与程序手册。 #>
function Assert-DailySnapshot {
  Assert-DailySnapshotManifest
  foreach ($relative in @($RequiredOutputs) + @('package.json', 'package-lock.json', 'node_modules', 'skills\aichat-graph\SKILL.md')) {
    if (-not (Test-Path -LiteralPath (Join-Path $DailyRoot $relative))) {
      Fail ('日用快照不完整：' + $relative) '验证开发构建后执行 update-daily.cmd；启动器不会回退使用开发文件。'
    }
  }
}

function Assert-DailyNotRunning {
  # The shared launcher lock covers normal launches. Also detect direct CLI runs
  # which did not use the launcher; if process inspection fails, do not replace.
  $needle = ([IO.Path]::GetFullPath($DailyRoot).TrimEnd('\') + '\').ToLowerInvariant()
  $processes = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop)
  foreach ($process in $processes) {
    if ($process.CommandLine -and ([string]$process.CommandLine).Replace('/', '\').ToLowerInvariant().Contains($needle)) {
      throw ('日用快照正由 Node 进程使用，PID：' + $process.ProcessId + '。请先停止该服务，再更新；不会结束任何用户进程。')
    }
  }
}

function Remove-OwnedStage([string] $Path, [string] $ExpectedStage) {
  Assert-PrivatePath $Path
  $stageParent = [IO.Path]::GetFullPath((Join-Path $LocalRoot 'staging')).TrimEnd('\') + '\'
  $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  if (-not $full.Equals([IO.Path]::GetFullPath($ExpectedStage).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase) -or -not $full.StartsWith($stageParent, [StringComparison]::OrdinalIgnoreCase)) {
    throw ('拒绝清理不属于本次操作的暂存目录：' + $full)
  }
  if (Test-Path -LiteralPath $full) {
    $links = @(Get-ChildItem -LiteralPath $full -Recurse -Force | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 })
    if ($links.Count -gt 0) { throw '暂存目录含有链接，拒绝递归清理。' }
    $workspaceRuntime = @(Get-ChildItem -LiteralPath $full -Recurse -Directory -Force | Where-Object { $_.Name -eq '.aichat' })
    if ($workspaceRuntime.Count -gt 0) { throw '暂存目录含有工作区运行数据，拒绝清理，避免删除未恢复事务。' }
    Remove-Item -LiteralPath $full -Recurse -Force
  }
}

function Update-DailySnapshot {
  $updateLock = $null
  $stage = $null
  $preserveStage = $false
  $updateError = $null
  try {
    $updateLock = Open-DailyLock -Exclusive $true
    Assert-DailyNotRunning
    Assert-PrivatePath $DailyRoot
    if (Test-Path -LiteralPath $DailyRoot) {
      Assert-DailySnapshotManifest
      $allowed = @('dist', 'node_modules', 'package.json', 'package-lock.json', 'snapshot.json', 'skills', 'LICENSE', 'THIRD_PARTY_NOTICES.txt', 'aichat.cmd', 'docs')
      $unexpected = @(Get-ChildItem -LiteralPath $DailyRoot -Force | Where-Object { $_.Name -notin $allowed })
      if ($unexpected.Count -gt 0) { throw '日用快照包含预期以外的文件，不会移动或清理。' }
    }

    # 待分发的构建产物、根入口与程序手册必须先在工程里齐全。
    foreach ($relative in $RequiredOutputs) {
      $path = Join-Path $ProjectRoot $relative
      if (Test-Path -LiteralPath $path) { continue }
      if ($BuildOutputs -contains $relative) {
        throw ('缺少构建产物：' + $relative + '。请执行 npm ci 和 npm run build，完成验证后再更新。')
      }
      throw ('缺少分发文件：' + $relative + '。根入口 aichat.cmd 与 docs/cli.md 必须随程序一起提供。')
    }
    $oldest = [datetime]::MaxValue
    foreach ($relative in $BuildOutputs) {
      $stamp = (Get-Item -LiteralPath (Join-Path $ProjectRoot $relative)).LastWriteTime
      if ($stamp -lt $oldest) { $oldest = $stamp }
    }
    if ((Get-NewestWriteTime $InputPaths) -gt $oldest) {
      throw '源码比构建产物新。请先执行 npm run build 并完成必要验证；更新入口不自动构建。'
    }

    $stage = Join-Path $LocalRoot ('staging\' + [Guid]::NewGuid().ToString('N'))
    Assert-PrivatePath $stage
    $ready = Join-Path $stage 'ready'
    $previous = Join-Path $stage 'previous'
    [void](New-Item -ItemType Directory -Path $ready -Force)
    foreach ($relative in @('dist', 'package.json', 'package-lock.json', 'LICENSE', 'THIRD_PARTY_NOTICES.txt', 'aichat.cmd')) {
      Copy-Item -LiteralPath (Join-Path $ProjectRoot $relative) -Destination $ready -Recurse
    }
    # 根入口与程序手册随快照分发，使用者无需安装 Skill 即可调用和查阅。
    [void](New-Item -ItemType Directory -Path (Join-Path $ready 'docs'))
    Copy-Item -LiteralPath (Join-Path $ProjectRoot 'docs\cli.md') -Destination (Join-Path $ready 'docs\cli.md')
    [void](New-Item -ItemType Directory -Path (Join-Path $ready 'skills'))
    Copy-Item -LiteralPath (Join-Path $ProjectRoot 'skills\aichat-graph') -Destination (Join-Path $ready 'skills') -Recurse
    # local.env.json 是本机安装绑定（CLI／工作区绝对路径），不属于通用内容。
    # 源码树里混入时明确提示并剔除，避免随快照发布或覆盖使用者的实际配置。
    $strayConfig = Join-Path $ready 'skills\aichat-graph\local.env.json'
    if (Test-Path -LiteralPath $strayConfig) {
      Remove-Item -LiteralPath $strayConfig -Force
      Write-Info '源码树中的 local.env.json 属于本机绑定，已排除在快照之外。'
    }
    Write-Info '准备日用快照的独立运行依赖（npm ci --omit=dev --ignore-scripts）…'
    $npm = Get-NpmCommand
    Push-Location -LiteralPath $ready
    try {
      & $npm ci --omit=dev --ignore-scripts --no-audit --no-fund
      $installExit = $LASTEXITCODE
    } finally { Pop-Location }
    if ($installExit -ne 0) { throw ('日用运行依赖安装失败，退出码：' + $installExit + '；原快照保持不变。') }

    $originalCli = $script:CliPath
    $originalRuntime = $script:RuntimeRoot
    try {
      $script:CliPath = Join-Path $ready 'dist\next\cli.js'
      $script:RuntimeRoot = $ready
      $probe = Invoke-Cli -Arguments @('--help')
      if ($probe.ExitCode -ne 0) { throw ('准备的 CLI 未通过只读帮助检查：' + $probe.StdErr) }
    } finally {
      $script:CliPath = $originalCli
      $script:RuntimeRoot = $originalRuntime
    }
    $manifest = [ordered]@{
      kind = 'aichat-daily'; schemaVersion = 1; preparedAt = (Get-Date).ToString('o')
      nodeVersion = $nodeVersion
      packageLockHash = Get-SnapshotFileHash (Join-Path $ready 'package-lock.json')
      cliHash = Get-SnapshotFileHash (Join-Path $ready 'dist\next\cli.js')
    }
    [IO.File]::WriteAllText((Join-Path $ready 'snapshot.json'), ($manifest | ConvertTo-Json) + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))

    Assert-DailyNotRunning
    Assert-PrivatePath $ready
    Assert-PrivatePath $previous
    if (Test-Path -LiteralPath $DailyRoot) { [IO.Directory]::Move($DailyRoot, $previous) }
    try { [IO.Directory]::Move($ready, $DailyRoot) }
    catch {
      if (Test-Path -LiteralPath $previous) {
        try { [IO.Directory]::Move($previous, $DailyRoot) }
        catch { $preserveStage = $true; throw ('快照替换和回退均失败；原快照保留在：' + $previous + ': ' + $_.Exception.Message) }
      }
      throw
    }
    Write-Info ('日用快照已准备：' + $DailyRoot)
    # 旧快照中若有本机绑定，原样带回新快照；不生成、不改写其中的路径。
    $previousConfig = Join-Path $previous 'skills\aichat-graph\local.env.json'
    if (Test-Path -LiteralPath $previousConfig) {
      try {
        Copy-Item -LiteralPath $previousConfig -Destination (Join-Path $DailyRoot 'skills\aichat-graph\local.env.json') -Force
      } catch {
        $preserveStage = $true
        throw ('新快照已就位，但本机绑定 local.env.json 未能保留；旧文件仍在：' + $previousConfig + '：' + $_.Exception.Message)
      }
      Write-Info '已保留本机绑定 local.env.json（内容未修改）。'
    }
    Write-Info '仅更新程序文件、根入口、程序手册和 Skill，没有更改工作区或本机启动配置。'
  } catch { $updateError = $_.Exception.Message }
  finally {
    if ($stage -and -not $preserveStage) {
      try { Remove-OwnedStage $stage $stage }
      catch { Write-Info ('私有暂存目录已保留，供检查：' + $stage + ' (' + $_.Exception.Message + ')') }
    }
    if ($updateLock) { $updateLock.Dispose() }
  }
  if ($updateError) { Fail $updateError '请先停止日用服务，解决上述问题后重试 update-daily.cmd；更新器不会结束进程。' }
}
