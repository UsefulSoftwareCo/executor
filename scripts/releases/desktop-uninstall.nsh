!macro customUnInstall
  ${ifNot} ${isUpdated}
    Delete "$APPDATA\Microsoft\Windows\Start Menu\Programs\Executor Apps\*.lnk"
    RMDir "$APPDATA\Microsoft\Windows\Start Menu\Programs\Executor Apps"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_ID}"
    ReadRegStr $0 HKCU "Software\Classes\executor\shell\open\command" ""
    ${if} $0 == '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
      DeleteRegKey HKCU "Software\Classes\executor"
    ${endIf}
  ${endIf}
!macroend
