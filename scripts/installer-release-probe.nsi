; Fixture for scripts/installer-release-record.test.mjs (SSR-000095 AC-10).
;
; Tauri expands `src-tauri/installer-hooks.nsh` into its generated installer.nsi.
; This script expands the same file into a throwaway installer so the release
; logic and its log record can be run against a fixture file: no product
; install, no uninstall, no user directory involved.
;
; Required defines: EA_PROBE_TARGET (the file to release), EA_PROBE_LOG (the
; desktop.log to append to). Both are absolute paths passed by the test.

Unicode true
!include "LogicLib.nsh"
!include "Win\RestartManager.nsh"

!ifndef EA_PROBE_TARGET
  !error "EA_PROBE_TARGET is required"
!endif
!ifndef EA_PROBE_LOG
  !error "EA_PROBE_LOG is required"
!endif

Name "Entity Assistant clean-up probe"
!ifndef EA_PROBE_OUTFILE
  !define EA_PROBE_OUTFILE "release-record-probe.exe"
!endif
OutFile "${EA_PROBE_OUTFILE}"
SilentInstall silent
RequestExecutionLevel user
ShowInstDetails hide

; The hook starts with Tauri's generated running-app check; the probe has no
; product binary to check, and its fixture file is what this run is about.
!macro CheckIfAppIsRunning path product
!macroend

!define MAINBINARYNAME "pi-agent-desktop"
!define PRODUCTNAME "Entity Assistant"
InstallDir "$EXEDIR\install"

!define EA_NODE_RUNTIME "${EA_PROBE_TARGET}"
!define EA_LOG_FILE "${EA_PROBE_LOG}"

!include "${__FILEDIR__}\..\src-tauri\installer-hooks.nsh"

Section
  !insertmacro NSIS_HOOK_PREINSTALL
SectionEnd
