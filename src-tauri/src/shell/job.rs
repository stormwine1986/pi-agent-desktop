//! Windows Job Object around the bundled Node server.
//!
//! `taskkill /T` on quit walks current parent links. A grandchild whose
//! intermediate parent already exited (an MCP server, a shell command) is no
//! longer in that tree, survives the App, and keeps `resources\node\node.exe`
//! mapped — the next overwrite install then fails on that file
//! (DEFECT-000086). Job membership follows the process, not the parent link:
//! closing this handle terminates every process still in the job, including
//! when the shell crashes or is force-terminated (the OS closes it for us).

#[cfg(windows)]
mod windows_impl {
    use std::io;
    use std::mem::size_of;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::process::Child;

    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// Owns the only handle to the job. Dropping it (on quit, panic unwind, or
    /// OS teardown) kills every process in the job.
    pub struct ServerJob {
        _handle: Option<OwnedHandle>,
    }

    impl ServerJob {
        /// No job: development mode, or a Windows API failure reported by the
        /// caller. `taskkill /T` and the launcher watchdog still apply.
        pub fn none() -> Self {
            Self { _handle: None }
        }

        /// Whether descendants are really guarded by a kill-on-close job. The
        /// exit record (SSR-000095 AC-10) says which of the two strategies
        /// applies, so a stray process after a crash can be explained instead of
        /// guessed at.
        pub fn is_attached(&self) -> bool {
            self._handle.is_some()
        }

        /// Puts `child` (and everything it spawns later) in a kill-on-close
        /// job. Must be called before the child spawns descendants.
        #[cfg(feature = "custom-protocol")]
        pub fn attach(child: &Child) -> io::Result<Self> {
            let raw_job = unsafe { CreateJobObjectW(None, PCWSTR::null()) }
                .map_err(|error| io::Error::other(format!("CreateJobObjectW: {error}")))?;
            let job = unsafe { OwnedHandle::from_raw_handle(raw_job.0) };
            let job_handle = HANDLE(job.as_raw_handle());

            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            unsafe {
                SetInformationJobObject(
                    job_handle,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
                .map_err(|error| io::Error::other(format!("SetInformationJobObject: {error}")))?;
                AssignProcessToJobObject(job_handle, HANDLE(child.as_raw_handle())).map_err(
                    |error| io::Error::other(format!("AssignProcessToJobObject: {error}")),
                )?;
            }
            Ok(Self { _handle: Some(job) })
        }
    }
}

#[cfg(windows)]
pub use windows_impl::ServerJob;

#[cfg(not(windows))]
mod other {
    use std::io;
    use std::process::Child;

    /// Unix already gets a killable process group from the shell
    /// (`command.process_group(0)`), so there is no job to own here.
    pub struct ServerJob;

    impl ServerJob {
        pub fn none() -> Self {
            Self
        }

        pub fn is_attached(&self) -> bool {
            false
        }

        #[cfg(feature = "custom-protocol")]
        pub fn attach(_child: &Child) -> io::Result<Self> {
            Ok(Self)
        }
    }
}

#[cfg(not(windows))]
pub use other::ServerJob;

#[cfg(all(test, windows, feature = "custom-protocol"))]
mod tests {
    use super::ServerJob;
    use std::process::{Command, Stdio};
    use std::thread::sleep;
    use std::time::{Duration, Instant};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    #[test]
    fn closing_the_job_kills_the_server_it_owns() {
        use std::os::windows::process::CommandExt as _;

        let mut child = Command::new("cmd.exe")
            .args(["/C", "ping -n 30 127.0.0.1 >NUL"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .expect("spawn a process to guard");

        let job = ServerJob::attach(&child).expect("attach the Job Object");
        drop(job);

        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if child
                .try_wait()
                .expect("poll the guarded process")
                .is_some()
            {
                return;
            }
            if Instant::now() > deadline {
                let _ = child.kill();
                panic!("closing the Job Object did not terminate its process");
            }
            sleep(Duration::from_millis(50));
        }
    }
}
