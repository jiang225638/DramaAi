<#
rename-to-single-entry.ps1  ·  漫剧老李套装 · 单入口重排工具
================================================================
用途：把「多技能套装」（13 个目录各带 SKILL.md）重排为「单入口套装」
      （只有根 SKILL.md 一个入口，13 个子目录正文改名为 RULES.md）。

它会做四件事（按顺序）：
  1) 备份整包为 zip（默认放在包根的上级目录，可用 -BackupDir 改）
  2) 把 13 个子目录的 SKILL.md → RULES.md（不覆盖已存在的 RULES.md）
  3) 字节级把子目录内 .md/.py/.json/.txt/.yml/.yaml 里的 "SKILL.md" 改成 "RULES.md"
     （latin-1 直通读写，UTF-8/BOM/行尾/其他字符一个字节不动）
  4) 根 README.md / SKILL.md 里只改「子目录/SKILL.md」这类路径写法，
     不动根文件对"自己"的 SKILL.md 自指（那是对的）
最后自校验：SKILL.md 数量必须 = 1、子目录零残留、check_package.py 必须 exit 0。

常用：
  pwsh -File .\rename-to-single-entry.ps1 -VerifyOnly   # 只看状态，不改文件
  pwsh -File .\rename-to-single-entry.ps1 -WhatIf       # 预演：列出将要做的改动
  pwsh -File .\rename-to-single-entry.ps1               # 真正执行（幂等，可重复跑）
  pwsh -File .\rename-to-single-entry.ps1 -Root D:\pkg  # 指定别的包根

退出码：0 = 已是单入口且校验全通过；1 = 仍有问题（看末尾 FAIL 行）
#>

[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [string]$Root = '',
    [string]$BackupDir = '',
    [switch]$SkipBackup,
    [switch]$VerifyOnly
)

$ErrorActionPreference = 'Stop'
$TextExt = @('.md', '.py', '.json', '.txt', '.yml', '.yaml')
$Expected = @(
    'short-drama-director', 'sd-decision-engine', 'sd-recon-engine', 'sd-script-engine',
    'sd-overseas-engine', 'sd-jieshuo-engine', 'sd-asset-engine', 'sd-storyboard-engine',
    'sd-combat-engine', 'sd-xuanhuan-engine', 'sd-real-engine', 'sd-feed-engine', 'sd-qc-engine'
)

# ---------- 0. 定位包根 ----------
if ([string]::IsNullOrWhiteSpace($Root)) { $Root = $PSScriptRoot }
if ([string]::IsNullOrWhiteSpace($Root)) { throw '无法确定包根，请用 -Root 指定' }
$Root = (Resolve-Path -LiteralPath $Root).Path
if (-not (Test-Path -LiteralPath $Root -PathType Container)) { throw "包根不是目录：$Root" }
$RootLeaf = Split-Path -Leaf $Root
if ([string]::IsNullOrWhiteSpace($BackupDir)) { $BackupDir = Split-Path -Parent $Root }

Write-Host ''
Write-Host "包根：$Root"
Write-Host ("模式：" + $(if ($VerifyOnly) { '仅校验（不改文件）' } elseif ($WhatIfPreference) { '预演（-WhatIf）' } else { '执行' }))
Write-Host ''

# ---------- 工具函数 ----------
function Get-Rel([string]$Base, [string]$Full) {
    # 兼容 Windows PowerShell 5.1（无 [IO.Path]::GetRelativePath）
    if ($Full.StartsWith($Base, [StringComparison]::OrdinalIgnoreCase)) {
        return $Full.Substring($Base.Length).TrimStart([char[]]@('\', '/'))
    }
    return $Full
}

function Get-Latin1Text([string]$Path) {
    $enc = [Text.Encoding]::GetEncoding(28591)
    return $enc.GetString([IO.File]::ReadAllBytes($Path))
}

function Measure-Contains([string]$Path, [string]$Needle) {
    try { $t = Get-Latin1Text $Path } catch { return 0 }
    return ([regex]::Matches($t, [regex]::Escape($Needle))).Count
}

function Replace-Bytes([string]$Path, [string]$Old, [string]$New) {
    $enc = [Text.Encoding]::GetEncoding(28591)
    $text = $enc.GetString([IO.File]::ReadAllBytes($Path))
    $n = ([regex]::Matches($text, [regex]::Escape($Old))).Count
    if ($n -le 0) { return 0 }
    $text = $text.Replace($Old, $New)
    [IO.File]::WriteAllBytes($Path, $enc.GetBytes($text))
    return $n
}

# ---------- 1. 盘点：目录 / 待改名 / 待改引用 ----------
$dirs = @()
$missing = @()
foreach ($n in $Expected) {
    $p = Join-Path $Root $n
    if (Test-Path -LiteralPath $p -PathType Container) { $dirs += $p } else { $missing += $n }
}
if ($missing.Count -gt 0) { Write-Warning ("缺少预期目录：" + ($missing -join '、')) }

# 兼容上游新增引擎：任何一级子目录若自带 SKILL.md 且不在登记表里，同样纳入处理
foreach ($sub in (Get-ChildItem -LiteralPath $Root -Directory)) {
    $sp = Join-Path $sub.FullName 'SKILL.md'
    if ((Test-Path -LiteralPath $sp -PathType Leaf) -and ($dirs -notcontains $sub.FullName)) {
        Write-Warning ("发现未登记的子技能目录（按同样规则处理）：" + $sub.Name)
        $dirs += $sub.FullName
    }
}
if ($dirs.Count -eq 0) { throw '一个子技能目录都没找到，确认 -Root 是否指对了包根' }

$toRename = @()
$toSkipRename = @()
foreach ($d in $dirs) {
    $src = Join-Path $d 'SKILL.md'
    $dst = Join-Path $d 'RULES.md'
    if (Test-Path -LiteralPath $src -PathType Leaf) {
        if (Test-Path -LiteralPath $dst -PathType Leaf) { $toSkipRename += $src } else { $toRename += $src }
    }
}

$toRewrite = @()
foreach ($d in $dirs) {
    $files = Get-ChildItem -LiteralPath $d -Recurse -File
    foreach ($f in $files) {
        if ($TextExt -contains $f.Extension.ToLower()) {
            if ((Measure-Contains $f.FullName 'SKILL.md') -gt 0) { $toRewrite += $f.FullName }
        }
    }
}

$rootFiles = @()
foreach ($name in @('README.md', 'SKILL.md')) {
    $p = Join-Path $Root $name
    if (Test-Path -LiteralPath $p -PathType Leaf) { $rootFiles += $p }
}

Write-Host ("子技能目录：{0} 个 | 待改名：{1} | 已有 RULES.md 冲突：{2} | 待改引用文件：{3}" -f `
    $dirs.Count, $toRename.Count, $toSkipRename.Count, $toRewrite.Count)
if ($toSkipRename.Count -gt 0) {
    Write-Warning '以下目录同时存在 SKILL.md 和 RULES.md，按"不覆盖"原则跳过改名，请人工确认内容以哪份为准：'
    foreach ($s in $toSkipRename) { Write-Warning "  $s" }
}

# ---------- 2. 备份 ----------
$didChange = $false
if (-not $VerifyOnly) {
    if ($toRename.Count -eq 0 -and $toRewrite.Count -eq 0) {
        Write-Host '无需改动（已是单入口状态），跳过备份。'
    }
    elseif ($SkipBackup) {
        Write-Warning '已指定 -SkipBackup，本次不生成备份（不可回滚，请谨慎）'
    }
    else {
        if (-not (Test-Path -LiteralPath $BackupDir -PathType Container)) {
            New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
        }
        $stamp = Get-Date -Format 'yyyyMMddHHmmss'
        $zip = Join-Path $BackupDir ("$RootLeaf-backup-$stamp.zip")
        if ($PSCmdlet.ShouldProcess($zip, '备份整包为 zip')) {
            Compress-Archive -LiteralPath $Root -DestinationPath $zip -CompressionLevel Optimal
            if (-not (Test-Path -LiteralPath $zip) -or (Get-Item -LiteralPath $zip).Length -lt 1000) {
                throw "备份失败或文件过小：$zip"
            }
            Write-Host ("备份：{0}（{1:N0} 字节）" -f $zip, (Get-Item -LiteralPath $zip).Length)
        }
    }

    # ---------- 3. 改名 ----------
    foreach ($src in $toRename) {
        $dst = Join-Path (Split-Path -Parent $src) 'RULES.md'
        if ($PSCmdlet.ShouldProcess($src, "改名为 RULES.md")) {
            Move-Item -LiteralPath $src -Destination $dst
            Write-Host "改名：$(Split-Path -Parent $src | Split-Path -Leaf)\SKILL.md → RULES.md"
            $didChange = $true
        }
    }

    # ---------- 4. 字节级改引用 ----------
    $totalHits = 0
    foreach ($fp in $toRewrite) {
        $rel = (Get-Rel $Root $fp)
        if ($PSCmdlet.ShouldProcess($fp, 'SKILL.md → RULES.md')) {
            $n = Replace-Bytes $fp 'SKILL.md' 'RULES.md'
            if ($n -gt 0) {
                $totalHits += $n
                Write-Host ("改引用：{0}（{1} 处）" -f $rel, $n)
                $didChange = $true
            }
        }
    }
    Write-Host ("子目录内共替换 {0} 处" -f $totalHits)

    # ---------- 5. 根文件：只改「子目录/SKILL.md」路径 ----------
    $pathPat = '(?i)((?:short-drama-director|sd-[a-z0-9\-]+-engine)[\\/])SKILL\.md'
    foreach ($rf in $rootFiles) {
        $text = Get-Latin1Text $rf
        $hits = ([regex]::Matches($text, $pathPat)).Count
        if ($hits -gt 0) {
            if ($PSCmdlet.ShouldProcess($rf, "路径写法改为 RULES.md（$hits 处）")) {
                $fixed = [regex]::Replace($text, $pathPat, '$1RULES.md')
                [IO.File]::WriteAllBytes($rf, [Text.Encoding]::GetEncoding(28591).GetBytes($fixed))
                Write-Host ("根文件路径修正：{0}（{1} 处，仅子目录路径，未动自指）" -f (Split-Path -Leaf $rf), $hits)
                $didChange = $true
            }
        }
    }
}

# ---------- 6. 自校验 ----------
Write-Host ''
Write-Host '================ 校验 ================'
$fails = New-Object System.Collections.Generic.List[string]
$notices = New-Object System.Collections.Generic.List[string]

$skillFiles = @(Get-ChildItem -LiteralPath $Root -Recurse -File -Filter 'SKILL.md')
$skillFiles = @($skillFiles | Where-Object { $_.FullName -notlike '*\.git\*' -and $_.FullName -notlike '*\.sessions\*' })
Write-Host ("SKILL.md 数量：{0}" -f $skillFiles.Count)
foreach ($s in $skillFiles) { Write-Host ("  - " + (Get-Rel $Root $s.FullName)) }
if ($skillFiles.Count -ne 1) {
    $fails.Add("SKILL.md 数量为 $($skillFiles.Count)，应为 1（只保留根 SKILL.md）")
}
elseif ([IO.Path]::GetDirectoryName($skillFiles[0].FullName) -ne $Root) {
    $fails.Add('唯一的 SKILL.md 不在包根')
}

$residual = @()
foreach ($d in $dirs) {
    foreach ($f in (Get-ChildItem -LiteralPath $d -Recurse -File)) {
        if ($TextExt -contains $f.Extension.ToLower()) {
            if ((Measure-Contains $f.FullName 'SKILL.md') -gt 0) { $residual += (Get-Rel $Root $f.FullName) }
        }
    }
}
Write-Host ("子目录 SKILL.md 残留：{0}" -f $residual.Count)
foreach ($r in $residual) { Write-Host "  ! $r" }
if ($residual.Count -gt 0) { $fails.Add("子目录仍有 $($residual.Count) 个文件提到 SKILL.md") }

foreach ($d in $dirs) {
    $rules = Join-Path $d 'RULES.md'
    if (-not (Test-Path -LiteralPath $rules -PathType Leaf)) {
        $fails.Add("缺少正文：$((Get-Rel $Root $rules))")
    }
}

foreach ($rf in $rootFiles) {
    $left = @()
    $i = 0
    foreach ($line in (Get-Content -LiteralPath $rf -Encoding utf8)) {
        $i++
        if ($line -match 'SKILL\.md' -and $line -notmatch '(?:short-drama-director|sd-[a-z0-9\-]+-engine)[\\/]SKILL\.md') {
            $left += "L$i"
        }
    }
    if ($left.Count -gt 0) { $notices.Add("$(Split-Path -Leaf $rf) 仍有 $($left.Count) 处 SKILL.md 自指（正常，仅提示）：$($left -join ',')") }
}

# check_package.py
$cp = Join-Path $Root 'short-drama-director\scripts\check_package.py'
$py = Get-Command python -ErrorAction SilentlyContinue
if (-not $py) { $py = Get-Command python3 -ErrorAction SilentlyContinue }
if ((Test-Path -LiteralPath $cp -PathType Leaf) -and $py) {
    Push-Location -LiteralPath $Root
    try {
        $out = & $py.Source 'short-drama-director/scripts/check_package.py' 2>&1 | Out-String
        $code = $LASTEXITCODE
    }
    finally { Pop-Location }
    $lastLine = ($out -split "`n" | Where-Object { $_.Trim() -ne '' } | Select-Object -Last 1)
    Write-Host ("check_package.py exit={0} | {1}" -f $code, $lastLine.Trim())
    if ($code -ne 0) { $fails.Add("check_package.py 返回 $code") }
}
elseif (-not $py) { Write-Warning '未找到 python，跳过 check_package.py 自检' }
else { Write-Warning '未找到 check_package.py，跳过包级自检' }

# ---------- 7. 结论 ----------
Write-Host ''
foreach ($n in $notices) { Write-Host "[提示] $n" }
if ($fails.Count -eq 0) {
    if ($didChange) { Write-Host '[PASS] 已重排为单入口套装，且校验全部通过。' }
    else { Write-Host '[PASS] 已是单入口套装，无需改动。' }
    exit 0
}
foreach ($f in $fails) { Write-Host "[FAIL] $f" }
Write-Host '未通过。可解压最近的备份 zip 回滚，或按上面 FAIL 行逐条修。'
exit 1
