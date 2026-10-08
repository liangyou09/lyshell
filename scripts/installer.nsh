!ifndef BUILD_UNINSTALLER
  !include LogicLib.nsh
  !include FileFunc.nsh

  ; 替换默认目录页：浏览选择完成后就回填最终路径，而不是等到复制文件。
  !ifdef allowToChangeInstallationDirectory
    !undef allowToChangeInstallationDirectory
    !define LYSHELL_CUSTOM_DIRECTORY
    !include MUI2.nsh
    !include nsDialogs.nsh
    !insertmacro MUI_INTERFACE

    Var LyShellDirectoryDialog
    Var LyShellDirectoryEdit
    Var LyShellDirectoryLastPath

    LangString LyShellDirectoryTitle 2052 "选择安装位置"
    LangString LyShellDirectoryTitle 1033 "Choose Install Location"
    LangString LyShellDirectoryHint 2052 "请选择安装目录。选择父目录后会自动追加 ${APP_FILENAME}；同名目录不重复追加（不区分大小写）。网络共享根目录始终追加子目录。"
    LangString LyShellDirectoryHint 1033 "A ${APP_FILENAME} subfolder is added unless the folder already has that name (case-insensitive). Network share roots always get a subfolder."
    LangString LyShellDirectoryLabel 2052 "目标文件夹"
    LangString LyShellDirectoryLabel 1033 "Destination Folder"
    LangString LyShellDirectoryBrowse 2052 "浏览..."
    LangString LyShellDirectoryBrowse 1033 "Browse..."
  !endif

  ; 只比较最后一级目录，避免父目录中的 LyShell 字样阻止追加。
  ; 此函数只处理路径，不创建目录，也不更改用户已有安装记录。
  Function LyShellNormalizeInstallDirectory
    Push $0
    Push $1

    ; 先消除 . / ..，避免共享根目录通过其它路径写法绕过检查。
    StrCmp $INSTDIR "" normalizeDone
    StrCpy $1 $INSTDIR
    ; NSIS 的 $INSTDIR 会去掉根目录末尾反斜杠；避免把 D: 解析为该盘当前目录。
    StrCpy $0 $1 "" 1
    ${If} $0 == ":"
      StrCpy $1 "$1\"
    ${EndIf}
    ; 直接使用 Win32 的词法解析，不要求目录已存在，也不访问网络共享。
    System::Call 'kernel32::GetFullPathName(t "$1", i ${NSIS_MAX_STRLEN}, t .r1, p 0) i.r0'
    ${If} $0 > 0
    ${AndIf} $0 < ${NSIS_MAX_STRLEN}
      StrCpy $INSTDIR $1
    ${EndIf}

    trimTrailingSeparator:
      StrCmp $INSTDIR "" normalizeDone
      StrCpy $0 $INSTDIR 1 -1
      ${If} $0 == "\"
      ${OrIf} $0 == "/"
        StrCpy $INSTDIR $INSTDIR -1
        Goto trimTrailingSeparator
      ${EndIf}

    ${GetFileName} "$INSTDIR" $1
    ; 自定义目录页没有 NSIS 原生目录页的共享根目录保护。
    ; 即使共享名为 LyShell，也必须安装到子目录，避免卸载递归删除整个共享。
    System::Call 'shlwapi::PathIsUNCServerShare(t "$INSTDIR") i.r0'
    ; LogicLib 的字符串比较使用 StrCmp，不区分大小写，保留原目录拼写。
    ${If} $1 != "${APP_FILENAME}"
    ${OrIf} $0 != 0
      StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
    ${EndIf}

    normalizeDone:
      Pop $1
      Pop $0
  FunctionEnd

  ; 延迟到页面宏展开时编译回调，确保 electron-builder 已加载插件目录。
  !macro customPageAfterChangeDir
    !ifdef LYSHELL_CUSTOM_DIRECTORY
    Function LyShellDirectoryShow
      ${If} ${isUpdated}
        Abort
      ${EndIf}
      !insertmacro MUI_HEADER_TEXT "$(LyShellDirectoryTitle)" "$(LyShellDirectoryLabel)"
      nsDialogs::Create 1018
      Pop $LyShellDirectoryDialog
      ${If} $LyShellDirectoryDialog == error
        Abort
      ${EndIf}
      ${NSD_CreateLabel} 0 0 100% 42u "$(LyShellDirectoryHint)"
      Pop $0
      ${NSD_CreateGroupBox} 0 52u 100% 54u "$(LyShellDirectoryLabel)"
      Pop $0
      Call LyShellNormalizeInstallDirectory
      StrCpy $LyShellDirectoryLastPath $INSTDIR
      ${NSD_CreateText} 8u 72u 72% 13u "$INSTDIR"
      Pop $LyShellDirectoryEdit
      ${NSD_OnChange} $LyShellDirectoryEdit LyShellDirectoryChanged
      ${NSD_CreateButton} 77% 71u 21% 15u "$(LyShellDirectoryBrowse)"
      Pop $0
      ${NSD_OnClick} $0 LyShellDirectoryBrowseClicked
      ; 手动输入时不改写正在编辑的文本，离开输入框后再回填。
      ${NSD_CreateTimer} LyShellDirectoryRefresh 200
      nsDialogs::Show
      ${NSD_KillTimer} LyShellDirectoryRefresh
    FunctionEnd

    Function LyShellDirectoryBrowseClicked
      Pop $0
      nsDialogs::SelectFolderDialog "$(LyShellDirectoryLabel)" "$INSTDIR"
      Pop $0
      ${If} $0 != error
        StrCpy $INSTDIR $0
        Call LyShellNormalizeInstallDirectory
        ${NSD_SetText} $LyShellDirectoryEdit "$INSTDIR"
        StrCpy $LyShellDirectoryLastPath $INSTDIR
      ${EndIf}
    FunctionEnd

    Function LyShellDirectoryChanged
      Pop $0
      ${NSD_GetText} $LyShellDirectoryEdit $INSTDIR
      GetDlgItem $0 $HWNDPARENT 1
      System::Call 'shlwapi::PathIsRelative(t "$INSTDIR") i.r1'
      ${If} $INSTDIR == ""
      ${OrIf} $1 != 0
        EnableWindow $0 0
      ${Else}
        EnableWindow $0 1
      ${EndIf}
    FunctionEnd

    Function LyShellDirectoryRefresh
      Push $0
      System::Call 'user32::GetFocus() p.r0'
      ${If} $0 != $LyShellDirectoryEdit
        ${NSD_GetText} $LyShellDirectoryEdit $0
        ${If} $0 != ""
        ${AndIf} $0 != $LyShellDirectoryLastPath
          StrCpy $INSTDIR $0
          Call LyShellNormalizeInstallDirectory
          ${NSD_SetText} $LyShellDirectoryEdit "$INSTDIR"
          StrCpy $LyShellDirectoryLastPath $INSTDIR
        ${EndIf}
      ${EndIf}
      Pop $0
    FunctionEnd

    Function LyShellDirectoryLeave
      ${NSD_GetText} $LyShellDirectoryEdit $INSTDIR
      Call LyShellNormalizeInstallDirectory
      ${NSD_SetText} $LyShellDirectoryEdit "$INSTDIR"
    FunctionEnd
      ; 静默安装仍在复制前规范化路径；自动更新沿用已登记的安装目录。
      Page custom LyShellDirectoryShow LyShellDirectoryLeave
      !define MUI_PAGE_CUSTOMFUNCTION_PRE LyShellInstallFilesPre
      Function LyShellInstallFilesPre
        ; 自动更新沿用已经登记的安装目录。
        ${If} ${isUpdated}
          Return
        ${EndIf}
        Call LyShellNormalizeInstallDirectory
      FunctionEnd
    !endif
  !macroend
!endif

; 使用安装上下文登记：当前用户安装不需要管理员权限，全用户安装写入 HKLM。
LangString LyShellExplorerOpen 2052 "使用 LyShell 打开"
LangString LyShellExplorerOpen 1033 "Open in LyShell"

!macro LyShellRegisterExplorerMenu KEY DIRECTORY
  WriteRegStr SHELL_CONTEXT "Software\Classes\${KEY}\shell\LyShell" "" "$(LyShellExplorerOpen)"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${KEY}\shell\LyShell" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  ; 末尾追加 \.，防根目录反斜杠紧邻闭引号时被 Windows 当作转义字符。
  WriteRegStr SHELL_CONTEXT "Software\Classes\${KEY}\shell\LyShell\command" "" '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" --open-directory $\"${DIRECTORY}\.$\"'
!macroend

!macro customInstall
  !insertmacro LyShellRegisterExplorerMenu "Directory" "%1"
  !insertmacro LyShellRegisterExplorerMenu "Directory\Background" "%V"
  !insertmacro LyShellRegisterExplorerMenu "Drive" "%1"
  ; ShellExecute 可用名称 lyshell / lyshell.exe 找到应用（资源管理器地址栏、Win+R）。
  WriteRegStr SHELL_CONTEXT "Software\Microsoft\Windows\CurrentVersion\App Paths\lyshell.exe" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
!macroend

!macro LyShellUnregisterExplorerMenu KEY
  ReadRegStr $0 SHELL_CONTEXT "Software\Classes\${KEY}\shell\LyShell" "Icon"
  StrCmp $0 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 +2
    DeleteRegKey SHELL_CONTEXT "Software\Classes\${KEY}\shell\LyShell"
!macroend

!macro customUnInstall
  !insertmacro LyShellUnregisterExplorerMenu "Directory"
  !insertmacro LyShellUnregisterExplorerMenu "Directory\Background"
  !insertmacro LyShellUnregisterExplorerMenu "Drive"
  ReadRegStr $0 SHELL_CONTEXT "Software\Microsoft\Windows\CurrentVersion\App Paths\lyshell.exe" ""
  StrCmp $0 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 +2
    DeleteRegKey SHELL_CONTEXT "Software\Microsoft\Windows\CurrentVersion\App Paths\lyshell.exe"
!macroend
