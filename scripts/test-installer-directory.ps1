param(
  [string]$Makensis = "$env:LOCALAPPDATA\electron-builder\Cache\nsis\nsis-3.0.4.1\Bin\makensis.exe"
)

$ErrorActionPreference = 'Stop'
if (!(Test-Path -LiteralPath $Makensis -PathType Leaf)) {
  throw 'NSIS compiler not found. Supply its path with -Makensis.'
}

# 编译并执行真实 NSIS 函数；探针只写临时结果，不安装文件或修改注册表。
$cases = @(
  @('\\server\LyShell', '\\server\LyShell\LyShell'),
  @('\\server\lyshell\', '\\server\lyshell\LyShell'),
  @('\\server\LyShell\.', '\\server\LyShell\LyShell'),
  @('\\server\LyShell\folder\..', '\\server\LyShell\LyShell'),
  @('\\server\share', '\\server\share\LyShell'),
  @('\\server\share\LyShell', '\\server\share\LyShell'),
  @('\\server\LyShell\LyShell', '\\server\LyShell\LyShell'),
  @('D:\', 'D:\LyShell'),
  @('D:\tools', 'D:\tools\LyShell'),
  @('D:\tools\lyshell\', 'D:\tools\lyshell'),
  @('D:\LyShell-parent\tools', 'D:\LyShell-parent\tools\LyShell'),
  @('D:\项目 A & B\LyShell', 'D:\项目 A & B\LyShell')
)
$probeDirectory = Join-Path ([IO.Path]::GetTempPath()) ('lyshell-directory-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $probeDirectory | Out-Null
try {
  $source = @'
Unicode true
Name "LyShell directory tests"
OutFile "probe.exe"
RequestExecutionLevel user
SilentInstall silent
!define APP_FILENAME "LyShell"
!define APP_EXECUTABLE_FILENAME "LyShell.exe"
!define allowToChangeInstallationDirectory
!define isUpdated '0 == 1'
!include "__INSTALLER__"
!insertmacro customPageAfterChangeDir
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"
!macro CheckDirectory INPUT
  StrCpy $INSTDIR "${INPUT}"
  Call LyShellNormalizeInstallDirectory
  FileWriteUTF16LE $9 "$INSTDIR$\r$\n"
  ; 再次规范化不得重复追加目录。
  Call LyShellNormalizeInstallDirectory
  FileWriteUTF16LE $9 "$INSTDIR$\r$\n"
!macroend
Section
  FileOpen $9 "$EXEDIR\results.txt" w
'@
  $source = $source.Replace('__INSTALLER__', (Join-Path $PSScriptRoot 'installer.nsh'))
  foreach ($case in $cases) {
    $source += "`n  !insertmacro CheckDirectory `"$($case[0])`""
  }
  $source += "`n  FileClose `$9`nSectionEnd`n"
  $sourcePath = Join-Path $probeDirectory 'probe.nsi'
  [IO.File]::WriteAllText($sourcePath, $source, [Text.UTF8Encoding]::new($true))
  & $Makensis /V2 $sourcePath
  if ($LASTEXITCODE -ne 0) { throw 'NSIS test compilation failed.' }
  $probe = Start-Process -FilePath (Join-Path $probeDirectory 'probe.exe') -WindowStyle Hidden -Wait -PassThru
  if ($probe.ExitCode -ne 0) { throw "NSIS probe failed: $($probe.ExitCode)" }
  $results = @(Get-Content -LiteralPath (Join-Path $probeDirectory 'results.txt') -Encoding Unicode)
  if ($results.Count -ne $cases.Count * 2) { throw 'Unexpected NSIS result count.' }
  for ($index = 0; $index -lt $cases.Count; $index++) {
    foreach ($offset in 0, 1) {
      $actual = $results[$index * 2 + $offset]
      if ($actual -cne $cases[$index][1]) {
        throw "Input '$($cases[$index][0])': expected '$($cases[$index][1])', got '$actual'."
      }
    }
  }
  Write-Output "Passed $($cases.Count) directory cases, including repeated normalization."
} finally {
  # 删除前确认目标仍是本次创建的临时目录。
  $resolvedProbe = [IO.Path]::GetFullPath($probeDirectory)
  $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\lyshell-directory-test-'
  if (!$resolvedProbe.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to remove a directory outside the test temporary path.'
  }
  Remove-Item -LiteralPath $resolvedProbe -Recurse -Force
}
