; Tauri's NSIS installer only adds files: an overwrite install never clears
; the previous payload, so a stale resources/server/node_modules keeps
; shadowing the freshly installed one through Node's nearest-module
; resolution and crashes the server at import time (issue #72).
;
; The same goes for the page cache (issue #149): the package ships no
; server\route-cache, Next writes one at runtime from the build's prerendered
; pages and reads it before them, so an upgrade would keep serving the old UI.
; desktop-server.cjs repeats this check on start for installs made before the
; hook existed.
;
; DEFECT-000086: the installer's own running-app check (CheckIfAppIsRunning,
; generated into installer.nsi) registers only the main executable. The payload
; ships a second executable, resources\node\node.exe, which the server and the
; agent/tool processes it spawns keep mapped for their whole lifetime. An
; overwrite install therefore got past the "app is running" check and failed
; halfway through with "Error opening file for writing: ...\node.exe",
; leaving the new server payload next to the old runtime. This hook asks for
; the main app first (Tauri's localized prompt; silent/passive installs kill it
; without asking), then releases the bundled runtime by full path through the
; Restart Manager, and refuses to touch any payload if the file is still held.
; It runs before the generated check and before any file below is written, so
; an abort here leaves the installed version untouched.
;
; SSR-000095 AC-10: every one of those decisions is recorded — which file was
; held, what the Restart Manager reported, which PIDs held it, which strategy
; the hook took and which code it ended with — in the details pane and, when
; the app already has one, in desktop.log. See EA_RecordCleanup below.

!define /ifndef EA_NODE_RUNTIME "$INSTDIR\resources\node\node.exe"

; Where the record lands: the log the shell already writes, so installer and
; app actions form one timeline. The installer only ever *appends* to an
; existing file — it must create no directory (AC-11) and write nothing inside
; $INSTDIR, because an aborted install has to leave the installed directory
; byte-identical (AC-6).
!define /ifndef EA_LOG_FILE "$LOCALAPPDATA\com.abcwyc.pi-agent\logs\desktop.log"

; The exit code of a refused install. 1603 is ERROR_INSTALL_FAILURE, the code
; Windows reports for an install that could not complete; without it a `/S` run
; would end with whatever NSIS' Abort happens to produce, which an unattended
; deployment cannot branch on (AC-3 depends on a deterministic exit code).
!define /ifndef EA_EXIT_RUNTIME_LOCKED 1603

; One line per clean-up decision, in two places: DetailPrint (what the details
; pane shows while the installer runs) and desktop.log (what survives the
; window). Fields, in order: the action (install/uninstall), the full path, the
; Restart Manager status, the PIDs that held it, the strategy and the code.
;
; `holders` takes what EA_ListHolders returned, so a run that could not name
; the processes says why instead of inventing a PID.
!macro EA_RecordCleanup action path status holders strategy code
  DetailPrint "Entity Assistant: ${action} ${path} (Restart Manager status ${status}) pids=${holders} strategy=${strategy} code=${code}"
  ${If} ${FileExists} "${EA_LOG_FILE}"
    ClearErrors
    FileOpen $R8 "${EA_LOG_FILE}" a
    ${IfNot} ${Errors}
      ; NSIS' append mode opens without seeking: position matters, or the new
      ; line overwrites whatever the shell wrote last (measured).
      FileSeek $R8 0 END
      FileWrite $R8 "installer: action=${action} path=${path} restart-manager=${status} pids=${holders} strategy=${strategy} code=${code}$\r$\n"
      FileClose $R8
    ${EndIf}
  ${EndIf}
!macroend

; Which processes hold `fullpath` right now. RmShutdown returns a status and
; nothing else, so naming the holders — the thing a support report needs — takes
; a Restart Manager session of its own: RmRegisterResources then RmGetList.
;
; Returns "none", "pid:53228" / "pid:53228,4100", or
; "unavailable (<what failed, with its code>)". Never fails the install: the
; record is evidence, the install is the job.
;
; Clobbers $0-$9. Uses no $R register, so the caller keeps its own.
!macro EA_ListHolders fullpath outvar
  !define EA_HOLDERS_UID ${__LINE__}
  StrCpy ${outvar} "none"

  System::Call 'RSTRTMGR::RmStartSession(*i-1s, i0, w)i.r0'
  ${If} $0 == error
    StrCpy ${outvar} "unavailable (RmStartSession failed)"
    Goto ea_holders_done_${EA_HOLDERS_UID}
  ${EndIf}

  System::Call 'RSTRTMGR::RmRegisterResources(ir0, i1, *w "${fullpath}", i0, p0, i0, p0)i.r1'
  ${If} $1 <> 0
    StrCpy ${outvar} "unavailable (RmRegisterResources code $1)"
    Goto ea_holders_close_${EA_HOLDERS_UID}
  ${EndIf}

  System::Alloc 4
  Pop $3
  System::Alloc 4
  Pop $4
  System::Alloc 64
  Pop $5
  ; RM_PROCESS_INFO is 668 bytes on both architectures we ship; room for 8.
  System::Alloc 5360
  Pop $6
  System::Call '*$3(i 0)'
  System::Call '*$4(i 8)'
  System::Call 'RSTRTMGR::RmGetList(ir0, pr3, pr4, pr6, pr5)i.r1'
  System::Call '*$4(i.r2)'
  ${If} $1 <> 0
    StrCpy ${outvar} "unavailable (RmGetList code $1)"
  ${Else}
    StrCpy ${outvar} ""
    StrCpy $8 0
    StrCpy $9 $6
    ${While} $8 < $2
      ; dwProcessId is the first field of RM_PROCESS_INFO.
      System::Call '*$9(i.r7)'
      ${If} ${outvar} == ""
        StrCpy ${outvar} "pid:$7"
      ${Else}
        StrCpy ${outvar} "${outvar},$7"
      ${EndIf}
      IntOp $9 $9 + 668
      IntOp $8 $8 + 1
    ${EndWhile}
    ${If} ${outvar} == ""
      StrCpy ${outvar} "none"
    ${EndIf}
  ${EndIf}
  System::Free $3
  System::Free $4
  System::Free $5
  System::Free $6

  ea_holders_close_${EA_HOLDERS_UID}:
  System::Call 'RSTRTMGR::RmEndSession(ir0)'
  ea_holders_done_${EA_HOLDERS_UID}:
  !undef EA_HOLDERS_UID
!macroend

; CheckIfAppIsRunning + Restart Manager shutdown by full path, then verify the
; file can actually be opened for writing. `$R9` carries the RM status for the
; log line; the message names the exact file so a support report is actionable.
; `action` is "install" or "uninstall" and only labels the record.
!macro EA_ReleaseBundledRuntime action
  ; The app is the only supported process that starts this runtime. Killing it
  ; here is safe: it is our own bundled binary, matched by full path (never by
  ; process name — other programs ship a node.exe too, e.g. WorkBuddy PID 14712).
  !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"

  ${IfNot} ${FileExists} "${EA_NODE_RUNTIME}"
    ; Nothing to release: this is a first install, or a package without the
    ; bundled runtime. Say so instead of leaving a silent gap in the log.
    !insertmacro EA_RecordCleanup "${action}" "${EA_NODE_RUNTIME}" "not-run" "none" "no-bundled-runtime" "0"
  ${Else}
    ; Name the holders before RmShutdown ends them: afterwards there is nothing
    ; left to ask, and "which process was it" is the first question a failed
    ; install raises.
    !insertmacro EA_ListHolders "${EA_NODE_RUNTIME}" $R7
    !insertmacro RestartManager_ShutdownFile "${EA_NODE_RUNTIME}" $R9
    ; Keep the RM status: $R9 is reused for the writability probe below.
    StrCpy $R6 $R9
    DetailPrint "Entity Assistant: released ${EA_NODE_RUNTIME} (Restart Manager status $R9)"
    ; RmShutdown is synchronous, but process teardown can still be in flight.
    Sleep 500

    ClearErrors
    FileOpen $R9 "${EA_NODE_RUNTIME}" a
    ${If} ${Errors}
      ; A `/S` install has nobody to click OK, so a dialog here would hang an
      ; unattended deployment forever (SSR-000095 AC-3). Tauri's own generated
      ; CheckIfAppIsRunning takes the same branch on /S (utils.nsh: `IfSilent` →
      ; log line + Abort, no MessageBox); follow that precedent exactly. The
      ; interactive prompt below is unchanged.
      SetErrorLevel ${EA_EXIT_RUNTIME_LOCKED}
      !insertmacro EA_RecordCleanup "${action}" "${EA_NODE_RUNTIME}" "$R6" "$R7" "abort-locked" "${EA_EXIT_RUNTIME_LOCKED}"
      !define EA_RUNTIME_UID ${__LINE__}
      IfSilent ea_runtime_busy_silent_${EA_RUNTIME_UID} ea_runtime_busy_ui_${EA_RUNTIME_UID}
      ea_runtime_busy_ui_${EA_RUNTIME_UID}:
        MessageBox MB_ICONSTOP|MB_OK "Entity Assistant is still running. Close Entity Assistant completely (including the tray icon), then start the installer again. If it keeps happening, end this process in Task Manager and retry: ${EA_NODE_RUNTIME}"
        Abort
      ea_runtime_busy_silent_${EA_RUNTIME_UID}:
        DetailPrint "Entity Assistant: cannot open ${EA_NODE_RUNTIME} for writing (still locked after Restart Manager shutdown, status $R6, pids $R7). Aborting this ${action} with code ${EA_EXIT_RUNTIME_LOCKED}; close Entity Assistant completely and run the installer again."
        Abort
      !undef EA_RUNTIME_UID
    ${Else}
      FileClose $R9
      !insertmacro EA_RecordCleanup "${action}" "${EA_NODE_RUNTIME}" "$R6" "$R7" "shutdown-and-overwrite" "0"
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; Order matters: release first, delete caches second. Aborting after the
  ; RMDirs would leave the still-installed app without its node_modules.
  !insertmacro EA_ReleaseBundledRuntime "install"

  RMDir /r "$INSTDIR\resources\server\node_modules"
  RMDir /r "$INSTDIR\resources\server\.next-desktop\server\route-cache"
!macroend

; Uninstall deletes resources\node\node.exe while a server left behind by a
; crashed shell can still hold it (same lock, same failure). Do the same
; release before the generated check and any Delete.
!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro EA_ReleaseBundledRuntime "uninstall"
!macroend
