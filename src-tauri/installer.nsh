; Administrator chats register a scheduled task that starts this exe; uninstalling removes it (it fails quietly without the rights).
!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'schtasks.exe /Delete /TN "\Frugal Deck\Administrator helper" /F'
!macroend
