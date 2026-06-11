; azzip — custom NSIS installer hooks
; Registers file associations for common archive formats on install,
; with an opt-out checkbox. Cleans up on uninstall.

!define ASSOC_EXTENSIONS ".zip;.7z;.rar;.tar;.gz;.tgz;.bz2;.tbz2;.xz;.txz"
!define ASSOC_PROGID "azzip.assoc"

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
; ---------------------------------------------------------------------------
!macro post_install
  ${NSD_GetState} $SetDefaultCheckbox $0
  ${If} $0 == ${BST_UNCHECKED}
    Goto skip_assoc
  ${EndIf}

  ; Register ProgID — the friendly name shown in Explorer
  WriteRegStr HKLM "Software\Classes\${ASSOC_PROGID}" "" "azzip archive"
  WriteRegStr HKLM "Software\Classes\${ASSOC_PROGID}\DefaultIcon" "" '"$INSTDIR\azzip.exe",0'
  WriteRegStr HKLM "Software\Classes\${ASSOC_PROGID}\shell\open\command" "" '"$INSTDIR\azzip.exe" "%1"'

  ; Associate each extension with our ProgID
  ; We use OpenWithProgids so we don't hijack the user's existing default;
  ; the user can still choose azzip from "Open with..." and optionally
  ; set it as default via Windows Settings > Default apps.
  ${ForEach} $1 ${ASSOC_EXTENSIONS} ";"
    WriteRegStr HKLM "Software\Classes\$1\OpenWithProgids" "${ASSOC_PROGID}" ""
  ${Next}

  ; Notify the shell that associations have changed
  System::Call 'shell32.dll::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'

  skip_assoc:
!macroend

; ---------------------------------------------------------------------------
; Clean up file associations on uninstall
; ---------------------------------------------------------------------------
!macro post_uninstall
  ${ForEach} $1 ${ASSOC_EXTENSIONS} ";"
    DeleteRegValue HKLM "Software\Classes\$1\OpenWithProgids" "${ASSOC_PROGID}"
    ; Clean up if the extension key is now empty
    DeleteRegKey /ifempty HKLM "Software\Classes\$1\OpenWithProgids"
  ${Next}

  DeleteRegKey HKLM "Software\Classes\${ASSOC_PROGID}\DefaultIcon"
  DeleteRegKey HKLM "Software\Classes\${ASSOC_PROGID}\shell\open\command"
  DeleteRegKey HKLM "Software\Classes\${ASSOC_PROGID}\shell\open"
  DeleteRegKey HKLM "Software\Classes\${ASSOC_PROGID}\shell"
  DeleteRegKey HKLM "Software\Classes\${ASSOC_PROGID}"

  System::Call 'shell32.dll::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
