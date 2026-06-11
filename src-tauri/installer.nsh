; azzip — custom NSIS installer hooks for Tauri v2
; Registers file associations on install, cleans up on uninstall.
; Tauri v2 expects: NSIS_HOOK_POSTINSTALL / NSIS_HOOK_POSTUNINSTALL

!define ASSOC_PROGID "azzip.AssocFile"
!define ASSOC_FRIENDLY "azzip archive"

; Helper: register one extension as default handler for azzip
!macro AssocSet EXT
  ; Backup previous default
  ReadRegStr $R0 HKCU "Software\Classes\${EXT}" ""
  ${If} $R0 != ""
    WriteRegStr HKCU "Software\Classes\${ASSOC_PROGID}\_backup\${EXT}" "" "$R0"
  ${EndIf}
  ; Set azzip as default handler
  WriteRegStr HKCU "Software\Classes\${EXT}" "" "${ASSOC_PROGID}"
  WriteRegStr HKCU "Software\Classes\${EXT}\OpenWithProgids" "${ASSOC_PROGID}" ""
!macroend

; Helper: restore one extension to its previous default (or clear)
!macro AssocRestore EXT
  ReadRegStr $R0 HKCU "Software\Classes\${ASSOC_PROGID}\_backup\${EXT}" ""
  ${If} $R0 != ""
    WriteRegStr HKCU "Software\Classes\${EXT}" "" "$R0"
  ${Else}
    DeleteRegValue HKCU "Software\Classes\${EXT}" ""
  ${EndIf}
  DeleteRegValue HKCU "Software\Classes\${EXT}\OpenWithProgids" "${ASSOC_PROGID}"
  DeleteRegKey /ifempty HKCU "Software\Classes\${EXT}\OpenWithProgids"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Register ProgID
  WriteRegStr HKCU "Software\Classes\${ASSOC_PROGID}" "" "${ASSOC_FRIENDLY}"
  WriteRegStr HKCU "Software\Classes\${ASSOC_PROGID}\DefaultIcon" "" '"$INSTDIR\azzip.exe",0'
  WriteRegStr HKCU "Software\Classes\${ASSOC_PROGID}\shell\open\command" "" '"$INSTDIR\azzip.exe" "%1"'

  ; Associate all archive extensions
  !insertmacro AssocSet ".zip"
  !insertmacro AssocSet ".7z"
  !insertmacro AssocSet ".rar"
  !insertmacro AssocSet ".tar"
  !insertmacro AssocSet ".gz"
  !insertmacro AssocSet ".tgz"
  !insertmacro AssocSet ".bz2"
  !insertmacro AssocSet ".tbz2"
  !insertmacro AssocSet ".xz"
  !insertmacro AssocSet ".txz"

  System::Call 'shell32.dll::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Restore previous associations
  !insertmacro AssocRestore ".zip"
  !insertmacro AssocRestore ".7z"
  !insertmacro AssocRestore ".rar"
  !insertmacro AssocRestore ".tar"
  !insertmacro AssocRestore ".gz"
  !insertmacro AssocRestore ".tgz"
  !insertmacro AssocRestore ".bz2"
  !insertmacro AssocRestore ".tbz2"
  !insertmacro AssocRestore ".xz"
  !insertmacro AssocRestore ".txz"

  ; Remove ProgID
  DeleteRegKey HKCU "Software\Classes\${ASSOC_PROGID}\_backup"
  DeleteRegKey HKCU "Software\Classes\${ASSOC_PROGID}\DefaultIcon"
  DeleteRegKey HKCU "Software\Classes\${ASSOC_PROGID}\shell\open\command"
  DeleteRegKey HKCU "Software\Classes\${ASSOC_PROGID}\shell\open"
  DeleteRegKey HKCU "Software\Classes\${ASSOC_PROGID}\shell"
  DeleteRegKey HKCU "Software\Classes\${ASSOC_PROGID}"

  System::Call 'shell32.dll::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
