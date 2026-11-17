; Colours from src/renderer/tokens.css (paper 0D1013, paper-2 15191C, paper-3 06080B, ink ECEFF2); the art is in installer/.
!define MUI_BGCOLOR 0D1013
!define MUI_TEXTCOLOR ECEFF2
!define MUI_HEADERIMAGE_RIGHT
!define MUI_INSTFILESPAGE_COLORS "ECEFF2 06080B"

; installer/installer.nsi (Tauri's template) calls DarkPage on every page: dark title bar, window and controls.
!macro FRUGAL_DARK UN
Function ${UN}DarkChildren ; $0 parent window
  StrCpy $1 0
  loop:
    FindWindow $1 "" "" $0 $1
    StrCmp $1 0 done
    System::Call 'user32::GetClassNameW(p r1, w .r2, i 64)'
    StrCmp $2 "Button" button
    StrCmp $2 "Edit" edit
    StrCmp $2 "Static" static
    StrCmp $2 "SysListView32" themed
    Goto loop
  button:
    System::Call 'user32::GetWindowLongW(p r1, i -16) i .r2'
    IntOp $2 $2 & 0xF
    IntCmp $2 1 themed themed ; push buttons take the dark theme
    ; Themed check boxes, radio buttons and group boxes ignore text colours.
    System::Call 'uxtheme::SetWindowTheme(p r1, w "", w "")'
  static:
    SetCtlColors $1 ECEFF2 0D1013
    Goto loop
  edit:
    SetCtlColors $1 ECEFF2 15191C
  themed:
    System::Call 'uxtheme::SetWindowTheme(p r1, w "DarkMode_Explorer", p 0)'
    Goto loop
  done:
FunctionEnd

Function ${UN}DarkPage
  Push $0
  Push $1
  Push $2
  ; DWMWA_USE_IMMERSIVE_DARK_MODE, then DWMWA_CAPTION_COLOR (Windows 11) set to paper.
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i 1, i 4)'
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 35, *i 0x0013100D, i 4)'
  SetCtlColors $HWNDPARENT ECEFF2 0D1013
  StrCpy $0 $HWNDPARENT
  Call ${UN}DarkChildren
  FindWindow $0 "#32770" "" $HWNDPARENT
  SetCtlColors $0 ECEFF2 0D1013
  Call ${UN}DarkChildren
  Pop $2
  Pop $1
  Pop $0
FunctionEnd
!macroend
!insertmacro FRUGAL_DARK ""
!insertmacro FRUGAL_DARK "un."

; Administrator chats register a scheduled task that starts this exe; uninstalling removes it (it fails quietly without the rights).
!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'schtasks.exe /Delete /TN "\Frugal Deck\Administrator helper" /F'
!macroend

; Frugal Deck Setup passes its own path in /SETUP=: a copy beside the Deck becomes the uninstaller Windows opens, in the
; Deck's style with the data choices; uninstall.exe stays as the quiet uninstaller.
!macro NSIS_HOOK_POSTINSTALL
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/SETUP=" $R1
  ${IfNot} ${Errors}
  ${AndIf} ${FileExists} "$R1"
    ${If} $R1 != "$INSTDIR\Frugal Deck Setup.exe"
      CopyFiles /SILENT "$R1" "$INSTDIR\Frugal Deck Setup.exe"
    ${EndIf}
    ${If} ${FileExists} "$INSTDIR\Frugal Deck Setup.exe"
      WriteRegStr SHCTX "${UNINSTKEY}" "UninstallString" "$\"$INSTDIR\Frugal Deck Setup.exe$\" --uninstall"
      WriteRegStr SHCTX "${UNINSTKEY}" "QuietUninstallString" "$\"$INSTDIR\uninstall.exe$\" /S"
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$INSTDIR\Frugal Deck Setup.exe"
  RMDir "$INSTDIR"
!macroend
