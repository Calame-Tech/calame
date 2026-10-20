; Calame NSIS installer hooks (bundle.windows.nsis.installerHooks in tauri.conf.json).
;
; Optional deletion of the user's Calame data on uninstall. The Tauri template already
; draws an unchecked "delete app data" box on the uninstall confirm page (label overridden
; by `deleteAppData` in windows/nsis/*.nsh), never shows it in update mode, and only wipes
; $APPDATA\${BUNDLEID} + $LOCALAPPDATA\${BUNDLEID}. The Calame server does NOT keep its data
; there: in packaged mode its dataDir is %APPDATA%\Calame (getPackagedDataDir in
; packages/cli/src/config.ts), holding calame.db (+ -wal/-shm) and .calame-secret. These
; hooks extend that same box to that folder, with these guarantees:
;   - unchecked (default), silent, passive or /UPDATE: nothing is deleted;
;   - run in place by a setup.exe (reinstall/upgrade page, `_?=$INSTDIR`, so $EXEDIR is
;     the install dir instead of the %TEMP% copy of a normal uninstall): nothing is
;     deleted either, although the template shows the box there without /UPDATE;
;   - a junction, symbolic link or other reparse point is never followed nor deleted;
;   - the user confirms a second time, after reading what is lost (default answer: No);
;   - only the profile of the Windows account that installed Calame (per-user HKCU
;     uninstall key present) is targeted, never an elevation account's profile;
;   - the Node sidecar ($INSTDIR\node.exe, matched by full path, not by name) is stopped
;     here before the template stops the app and deletes the install dir, and the folder
;     is renamed before being deleted, so calame.db and .calame-secret go away together
;     or not at all.
; Hook points and variables ($DeleteAppDataCheckboxState, $UpdateMode, UNINSTKEY) are
; those of the tauri-bundler 2.x template used by @tauri-apps/cli 2.11.

!define MUI_UNCONFIRMPAGE_TEXT_TOP "$(calameUninstallConfirmTop)"

!define CALAME_DATA_DIRNAME "Calame"
!define CALAME_SIDECAR_EXE "node.exe"
!define CALAME_FILE_ATTRIBUTE_REPARSE_POINT 0x400

Var CalameDataTrash

!macro NSIS_HOOK_PREUNINSTALL
  ; Launched in place by an installer, which goes on installing afterwards: this is a
  ; reinstall or an upgrade, the data must stay (the template's own $APPDATA\${BUNDLEID}
  ; removal is skipped too, since it reads the same variable).
  ${If} $EXEDIR == $INSTDIR
  ${AndIf} $DeleteAppDataCheckboxState = 1
    StrCpy $DeleteAppDataCheckboxState 0
    MessageBox MB_OK|MB_ICONINFORMATION "$(calameDeleteDataReinstall)" /SD IDOK
  ${EndIf}

  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    SetShellVarContext current
    ; Owner check: a per-user install registers its uninstall key in the installing
    ; user's HKCU. Under another account (e.g. "Run as administrator" with an admin's
    ; credentials) the key is missing and $APPDATA would be the wrong profile.
    !if "${INSTALLMODE}" == "currentUser"
      ReadRegStr $0 HKCU "${UNINSTKEY}" "UninstallString"
    !else
      StrCpy $0 ""
    !endif
    ${If} $0 == ""
    ${OrIf} $APPDATA == ""
      StrCpy $DeleteAppDataCheckboxState 0
      MessageBox MB_OK|MB_ICONINFORMATION "$(calameDeleteDataNotOwner)" /SD IDOK
    ${Else}
      MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "$(calameDeleteDataConfirm)" /SD IDNO IDYES calame_delete_confirmed
        StrCpy $DeleteAppDataCheckboxState 0
      calame_delete_confirmed:
    ${EndIf}
  ${EndIf}

  ; The template then stops ${MAINBINARYNAME}.exe (forcefully, so the app cannot stop its
  ; Node sidecar itself) and deletes $INSTDIR, node.exe included: stop the sidecar first,
  ; in every mode, so that node.exe and calame.db are no longer open. Only the one living
  ; in $INSTDIR, never another Node process.
  System::Call 'kernel32::SetEnvironmentVariable(t "CALAME_UNINSTALL_SIDECAR", t "$INSTDIR\${CALAME_SIDECAR_EXE}")'
  nsExec::Exec 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { $$_.Path -ieq $$env:CALAME_UNINSTALL_SIDECAR } | Stop-Process -Force -ErrorAction SilentlyContinue"'
  Pop $0
  Sleep 1000
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
  ${AndIf} $EXEDIR != $INSTDIR
    SetShellVarContext current
    ${If} ${FileExists} "$APPDATA\${CALAME_DATA_DIRNAME}\*.*"
      ; A junction, symbolic link or any other reparse point leads somewhere else: it is
      ; left intact, like calame-uninstall-data.ps1 does (exit 4). Unreadable attributes
      ; (-1) have the bit set too, so they are treated the same way.
      StrCpy $CalameDataTrash "$APPDATA\${CALAME_DATA_DIRNAME}"
      System::Call 'kernel32::GetFileAttributes(t "$CalameDataTrash") i .r2'
      IntOp $2 $2 & ${CALAME_FILE_ATTRIBUTE_REPARSE_POINT}
      ${If} $2 <> 0
        MessageBox MB_OK|MB_ICONEXCLAMATION "$(calameDeleteDataReparsePoint)" /SD IDOK
      ${Else}
        System::Call 'kernel32::GetTickCount() i .r1'
        StrCpy $CalameDataTrash "$APPDATA\${CALAME_DATA_DIRNAME}.uninstall-$1"
        ; Renaming fails while any file inside is still open: the data is then left
        ; untouched instead of half-deleted (e.g. the secret gone but not the database).
        ClearErrors
        Rename "$APPDATA\${CALAME_DATA_DIRNAME}" "$CalameDataTrash"
        ${If} ${Errors}
          MessageBox MB_OK|MB_ICONEXCLAMATION "$(calameDeleteDataLocked)" /SD IDOK
        ${Else}
          ; Checked again on the renamed folder, right before the recursive delete.
          System::Call 'kernel32::GetFileAttributes(t "$CalameDataTrash") i .r2'
          IntOp $2 $2 & ${CALAME_FILE_ATTRIBUTE_REPARSE_POINT}
          ${If} $2 <> 0
            MessageBox MB_OK|MB_ICONEXCLAMATION "$(calameDeleteDataReparsePoint)" /SD IDOK
          ${Else}
            RMDir /r "$CalameDataTrash"
            ${If} ${FileExists} "$CalameDataTrash\*.*"
              MessageBox MB_OK|MB_ICONINFORMATION "$(calameDeleteDataLeftover)" /SD IDOK
            ${EndIf}
          ${EndIf}
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend
