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

!define /ifndef EA_NODE_RUNTIME "$INSTDIR\resources\node\node.exe"

; CheckIfAppIsRunning + Restart Manager shutdown by full path, then verify the
; file can actually be opened for writing. `$R9` carries the RM status for the
; log line; the message names the exact file so a support report is actionable.
!macro EA_ReleaseBundledRuntime
  ; The app is the only supported process that starts this runtime. Killing it
  ; here is safe: it is our own bundled binary, matched by full path (never by
  ; process name — other programs ship a node.exe too, e.g. WorkBuddy PID 14712).
  !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"

  ${If} ${FileExists} "${EA_NODE_RUNTIME}"
    !insertmacro RestartManager_ShutdownFile "${EA_NODE_RUNTIME}" $R9
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
      !define EA_RUNTIME_UID ${__LINE__}
      IfSilent ea_runtime_busy_silent_${EA_RUNTIME_UID} ea_runtime_busy_ui_${EA_RUNTIME_UID}
      ea_runtime_busy_ui_${EA_RUNTIME_UID}:
        MessageBox MB_ICONSTOP|MB_OK "Entity Assistant is still running. Close Entity Assistant completely (including the tray icon), then start the installer again. If it keeps happening, end this process in Task Manager and retry: ${EA_NODE_RUNTIME}"
        Abort
      ea_runtime_busy_silent_${EA_RUNTIME_UID}:
        DetailPrint "Entity Assistant: cannot open ${EA_NODE_RUNTIME} for writing (still locked after Restart Manager shutdown, status $R9). Aborting this silent install; close Entity Assistant completely and run the installer again."
        Abort
      !undef EA_RUNTIME_UID
    ${Else}
      FileClose $R9
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; Order matters: release first, delete caches second. Aborting after the
  ; RMDirs would leave the still-installed app without its node_modules.
  !insertmacro EA_ReleaseBundledRuntime

  RMDir /r "$INSTDIR\resources\server\node_modules"
  RMDir /r "$INSTDIR\resources\server\.next-desktop\server\route-cache"
!macroend

; Uninstall deletes resources\node\node.exe while a server left behind by a
; crashed shell can still hold it (same lock, same failure). Do the same
; release before the generated check and any Delete.
!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro EA_ReleaseBundledRuntime
!macroend
