!macro GENZOROOM_REQUIRE_INSTALLATION_MUTEX CONTEXT
  StrCmp $GenzoRoomInstallerMutex "" ${CONTEXT}_lock_acquire ${CONTEXT}_lock_ready
  ${CONTEXT}_lock_acquire:
  ; The host and installer share this handle name, so neither can begin while the other is alive.
  System::Call 'kernel32::SetLastError(i 0)'
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "Local\GenzoRoom.WindowsPoC") p .r9'
  System::Call 'kernel32::GetLastError() i .r8'
  StrCmp $9 0 ${CONTEXT}_lock_failed
  StrCmp $8 183 ${CONTEXT}_lock_busy
  StrCpy $GenzoRoomInstallerMutex $9
  Goto ${CONTEXT}_lock_ready

  ${CONTEXT}_lock_busy:
  IfSilent ${CONTEXT}_busy_silent ${CONTEXT}_busy_ui
  ${CONTEXT}_busy_silent:
    SetErrorLevel 2
    Abort
  ${CONTEXT}_busy_ui:
    MessageBox MB_ICONSTOP|MB_OK "$(GenzoRoomInstallBlocked)"
    Abort

  ${CONTEXT}_lock_failed:
  IfSilent ${CONTEXT}_failed_silent ${CONTEXT}_failed_ui
  ${CONTEXT}_failed_silent:
    SetErrorLevel 3
    Abort
  ${CONTEXT}_failed_ui:
    MessageBox MB_ICONSTOP|MB_OK "$(GenzoRoomInstallLockFailed)"
    Abort

  ${CONTEXT}_lock_ready:
!macroend

Var GenzoRoomInstallerMutex

!macro NSIS_HOOK_PREINSTALL
  !insertmacro GENZOROOM_REQUIRE_INSTALLATION_MUTEX install
  ; Reinstalling in place must not retain DLLs or notices omitted by the clean staged build.
  RMDir /r "$INSTDIR\backend"
  RMDir /r "$INSTDIR\licenses"
  RMDir /r "$INSTDIR\source"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro GENZOROOM_REQUIRE_INSTALLATION_MUTEX uninstall
!macroend
