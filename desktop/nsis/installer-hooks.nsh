!macro GENZOROOM_CHECK_APP_NOT_RUNNING CONTEXT
  ${CONTEXT}_check_again:
  nsExec::ExecToStack /TIMEOUT=5000 '"$SYSDIR\tasklist.exe" /FI "IMAGENAME eq ${MAINBINARYNAME}.exe" /FO CSV /NH'
  Pop $R8
  Pop $R9
  StrCmp $R8 "0" ${CONTEXT}_check_result
  MessageBox MB_ICONSTOP|MB_OK "$(GenzoRoomProcessCheckFailed)"
  Abort

  ${CONTEXT}_check_result:
  StrCpy $R7 $R9 1
  StrCmp $R7 $\" ${CONTEXT}_running ${CONTEXT}_done
  ${CONTEXT}_running:
  IfSilent ${CONTEXT}_silent_cancel ${CONTEXT}_prompt
  StrCmp $PassiveMode "1" ${CONTEXT}_silent_cancel ${CONTEXT}_prompt
  ${CONTEXT}_silent_cancel:
    SetErrorLevel 2
    Abort
  ${CONTEXT}_prompt:
    MessageBox MB_ICONEXCLAMATION|MB_RETRYCANCEL "$(GenzoRoomMustExit)" IDRETRY ${CONTEXT}_check_again IDCANCEL ${CONTEXT}_cancelled
  ${CONTEXT}_cancelled:
    Abort
  ${CONTEXT}_done:
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; Reinstalling in place must not retain files omitted by the clean staged build.
  RMDir /r "$INSTDIR\backend"
  RMDir /r "$INSTDIR\licenses"
  RMDir /r "$INSTDIR\source"
!macroend
