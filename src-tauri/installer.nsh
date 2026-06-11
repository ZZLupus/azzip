; azzip — custom NSIS installer hooks
; Registers file associations for common archive formats on install,
; with an opt-out checkbox. Cleans up on uninstall.

!define ASSOC_EXTENSIONS ".zip;.7z;.rar;.tar;.gz;.tgz;.bz2;.tbz2;.xz;.txz"
!define ASSOC_PROGID "azzip.AssocFile"

Var SetDefaultCheckbox

; ---------------------------------------------------------------------------
; Show a checkbox page after the directory selection page
; ---------------------------------------------------------------------------
Function AssocPage
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateCheckbox} 0 0 100% 12u "Set azzip as the default app for archive files (.zip, .7z, .rar, .tar, .gz, ...)"
  Pop $SetDefaultCheckbox
  ${NSD_Check} $SetDefaultCheckbox

  nsDialogs::Show
FunctionEnd

!macro custom_page_after_change_programs_directory
  Page custom AssocPage
!macroend

; ---------------------------------------------------------------------------
; Register file associations after installation
; Uses HKCU (no admin needed, works with currentUser install mode).
; Makes azzip the *default* handler by setting each extension's default value.
; ---------------------------------------------------------------------------
!macro post_install
  ${NSD_GetState} $SetDefaultCheckbox $0
  ${If} $0 == ${BST_UNCHECKED}
    Goto skip_assoc
  ${EndIf}

  ; Backup existing defaults so we can restore on uninstall
  ${ForEach} $1 ${ASSOC_EXTENSIONS} ";"
    ReadRegStr $2 HKCU "Software\Classes\$1" ""
    ${If} $2 != ""
      WriteRegStr HKCU "Software\Classes\${ASSOC_PROGID}\_backup\$1" "" "$2"
    ${EndIf}
  ${Next}

  ; Register ProgID under HKCU
  WriteRegStr HKCU "Software\Classes\${ASSOC_PROGID}" "" "azzip archive"
  WriteRegStr HKCU "Software\Classes\${ASSOC_PROGID}\DefaultIcon" "" '"$INSTDIR\azzip.exe",0'
  WriteRegStr HKCU "Software\Classes\${ASSOC_PROGID}\shell\open\command" "" '"$INSTDIR\azzip.exe" "%1"'
  WriteRegStr HKCU "Software\Classes\${ASSOC_PROGID}\shell\open" "FriendlyAppName" "azzip"

  ; Make azzip the DEFAULT handler for each extension
  ${ForEach} $1 ${ASSOC_EXTENSIONS} ";"
    ; Set the extension's default to our ProgID (makes it the double-click handler)
    WriteRegStr HKCU "Software\Classes\$1" "" "${ASSOC_PROGID}"
    ; Also add to OpenWithProgids for the "Open with" menu
    WriteRegStr HKCU "Software\Classes\$1\OpenWithProgids" "${ASSOC_PROGID}" ""
  ${Next}

  ; Register with Default Programs (optional, shows azzip in Settings > Default Apps)
  WriteRegStr HKCU "Software\RegisteredApplications" "azzip" "Software\Classes\${ASSOC_PROGID}\Capabilities"
  WriteRegStr HKCU "Software\Classes\${ASSOC_PROGID}\Capabilities" "ApplicationName" "azzip"
  WriteRegStr HKCU "Software\Classes\${ASSOC_PROGID}\Capabilities" "ApplicationDescription" "A modern, ad-free archive manager"
  ${ForEach} $1 ${ASSOC_EXTENSIONS} ";"
    WriteRegStr HKCU "Software\Classes\${ASSOC_PROGID}\Capabilities\FileAssociations" "$1" "${ASSOC_PROGID}"
  ${Next}

  ; Notify shell
  System::Call 'shell32.dll::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'

  skip_assoc:
!macroend

; ---------------------------------------------------------------------------
; Restore previous associations on uninstall
; ---------------------------------------------------------------------------
!macro post_uninstall
  ; Restore each extension's previous default (if we backed it up)
  ${ForEach} $1 ${ASSOC_EXTENSIONS} ";"
    ReadRegStr $2 HKCU "Software\Classes\${ASSOC_PROGID}\_backup\$1" ""
    ${If} $2 != ""
      WriteRegStr HKCU "Software\Classes\$1" "" "$2"
    ${Else}
      DeleteRegValue HKCU "Software\Classes\$1" ""
    ${EndIf}
    DeleteRegValue HKCU "Software\Classes\$1\OpenWithProgids" "${ASSOC_PROGID}"
    DeleteRegKey /ifempty HKCU "Software\Classes\$1\OpenWithProgids"
  ${Next}

  ; Remove backup keys
  DeleteRegKey HKCU "Software\Classes\${ASSOC_PROGID}\_backup"

  ; Remove Capabilities
  DeleteRegKey HKCU "Software\Classes\${ASSOC_PROGID}\Capabilities\FileAssociations"
  DeleteRegKey HKCU "Software\Classes\${ASSOC_PROGID}\Capabilities"
  DeleteRegValue HKCU "Software\RegisteredApplications" "azzip"

  ; Remove ProgID
  DeleteRegKey HKCU "Software\Classes\${ASSOC_PROGID}\DefaultIcon"
  DeleteRegKey HKCU "Software\Classes\${ASSOC_PROGID}\shell\open\command"
  DeleteRegKey HKCU "Software\Classes\${ASSOC_PROGID}\shell\open"
  DeleteRegKey HKCU "Software\Classes\${ASSOC_PROGID}\shell"
  DeleteRegKey HKCU "Software\Classes\${ASSOC_PROGID}"

  System::Call 'shell32.dll::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
