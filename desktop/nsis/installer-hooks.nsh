!macro GENZOROOM_REQUIRE_NAMED_MUTEX CONTEXT MUTEX_NAME HANDLE
  StrCmp ${HANDLE} "" ${CONTEXT}_lock_acquire ${CONTEXT}_lock_ready
  ${CONTEXT}_lock_acquire:
  ; Holding the named-object handle makes the check and later file changes one lifetime.
  System::Call 'kernel32::SetLastError(i 0)'
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "${MUTEX_NAME}") p .r9'
  System::Call 'kernel32::GetLastError() i .r8'
  StrCmp $9 0 ${CONTEXT}_lock_failed
  StrCmp $8 183 ${CONTEXT}_lock_busy
  StrCpy ${HANDLE} $9
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

!macro GENZOROOM_REQUIRE_INSTALLATION_MUTEX CONTEXT
  !insertmacro GENZOROOM_REQUIRE_NAMED_MUTEX ${CONTEXT} "Local\GenzoRoom.WindowsPoC" $GenzoRoomInstallerMutex
!macroend

!macro GENZOROOM_REQUIRE_INSTALLER_GATE CONTEXT
  !insertmacro GENZOROOM_REQUIRE_NAMED_MUTEX ${CONTEXT} "Local\GenzoRoom.InstallerGate" $GenzoRoomInstallerGateMutex
!macroend

!macro GENZOROOM_RELEASE_NAMED_MUTEX HANDLE FAILURE_LABEL CONTEXT
  StrCmp ${HANDLE} "" ${CONTEXT}_released
  System::Call 'kernel32::CloseHandle(p ${HANDLE}) i .r8'
  StrCmp $8 0 ${FAILURE_LABEL}
  StrCpy ${HANDLE} ""
  ${CONTEXT}_released:
!macroend

Var GenzoRoomInstallerMutex
Var GenzoRoomInstallerGateMutex

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
