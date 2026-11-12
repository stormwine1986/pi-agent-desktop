use std::{io, process::Child, sync::Mutex};

use super::job::ServerJob;
use crate::logging::log_desktop;

// Each platform's `stop()` path needs its own imports; the split out of
// lib.rs lost these, which only a Windows build notices.
#[cfg(windows)]
use std::{os::windows::process::CommandExt as _, process::Command};
#[cfg(unix)]
use std::{
    thread,
    time::{Duration, Instant},
};

pub struct DesktopServer {
    child: Mutex<Option<Child>>,
    /// Kept alive for the whole App run. Dropping it is what kills any
    /// surviving descendants on Windows (see job.rs).
    _job: ServerJob,
}

/// When true, closing the main window quits the app; otherwise it hides to tray.
pub struct CloseQuits(pub Mutex<bool>);

pub struct DesktopApiToken(pub String);

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

impl DesktopServer {
    #[cfg(not(feature = "custom-protocol"))]
    pub fn empty() -> Self {
        Self {
            child: Mutex::new(None),
            _job: ServerJob::none(),
        }
    }

    pub fn running(child: Child, job: ServerJob) -> Self {
        Self {
            child: Mutex::new(Some(child)),
            _job: job,
        }
    }

    pub fn try_wait_child(&self) -> io::Result<Option<std::process::ExitStatus>> {
        let Ok(mut guard) = self.child.lock() else {
            return Ok(None);
        };
        match guard.as_mut() {
            Some(child) => child.try_wait(),
            None => Ok(None),
        }
    }

    pub fn stop(&self) {
        let Ok(mut guard) = self.child.lock() else {
            return;
        };
        let Some(child) = guard.take() else { return };
        terminate_process_tree(child, self._job.is_attached());
    }
}

/// How the server (and everything it started) was taken down, in the same
/// `desktop.log` timeline the installer appends its own record to
/// (SSR-000095 AC-10).
///
/// There is no Restart Manager here and the shell reports that honestly: the
/// shell owns the child handle and a kill-on-close Job Object, and the path it
/// started is the one the installer record names. A force-killed or crashed
/// shell writes nothing at all — that case is covered from the other side, by
/// `server-launcher.cjs` ("desktop shell … is gone") in `server.log`.
fn record_cleanup(strategy: &str, pid: u32, job_attached: bool, code: &str) {
    log_desktop(&format!(
        "cleanup: strategy={strategy} pid={pid} job={} restart-manager=not-used-by-shell code={code}",
        if job_attached {
            "kill-on-close"
        } else {
            "none-watchdog-only"
        }
    ));
}

fn terminate_process_tree(mut child: Child, job_attached: bool) {
    #[cfg(unix)]
    {
        let pid = child.id();
        record_cleanup("kill-process-group", pid, job_attached, "pending");
        unsafe {
            // The Node server owns its process group, so this also stops any
            // agent/tool subprocesses that are active when the App quits.
            libc::kill(-(pid as i32), libc::SIGTERM);
        }

        // Reap on a detached thread so the quit/exit path never blocks on the
        // Node server's shutdown. The packaged server installs no SIGTERM
        // handler, so it normally dies immediately, but any child that ignores
        // SIGTERM must not stall the UI for the full grace window. If the main
        // process exits before this thread finishes, the server's own parent
        // watchdog (desktop/server-launcher.cjs) exits it within ~1 s, so no
        // orphan is left behind either way.
        thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(2);
            while Instant::now() < deadline {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        record_cleanup(
                            "kill-process-group",
                            pid,
                            job_attached,
                            &format!("exited ({status})"),
                        );
                        return;
                    }
                    Ok(None) => thread::sleep(Duration::from_millis(50)),
                    Err(_) => return,
                }
            }

            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
            let _ = child.kill();
            let _ = child.wait();
            record_cleanup(
                "kill-process-group",
                pid,
                job_attached,
                "sigkill-after-2000ms",
            );
        });
    }

    #[cfg(windows)]
    {
        let pid = child.id();
        // taskkill /T terminates the packaged Node server and any agent/tool
        // subprocesses it started. CREATE_NO_WINDOW avoids flashing a console.
        let status = Command::new("taskkill.exe")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
        let code = match status {
            Ok(status) => status.code().map_or_else(|| "terminated".to_string(), |code| code.to_string()),
            Err(error) => format!("spawn-failed ({error})"),
        };
        let _ = child.kill();
        let _ = child.wait();
        record_cleanup("taskkill-tree", pid, job_attached, &code);
    }
}

impl Drop for DesktopServer {
    fn drop(&mut self) {
        self.stop();
    }
}
