//! Own only a suspended, job-assigned child; ordinary shutdown never kills it.
use crate::connection::Connection;
use serde::Deserialize;
#[cfg(windows)]
use std::os::windows::{
    io::{AsRawHandle, FromRawHandle, OwnedHandle},
    process::CommandExt,
};
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver},
    time::{Duration, Instant},
};

pub fn identifier() -> Result<String, &'static str> {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).map_err(|_| "random_generation_failed")?;
    Ok(bytes.iter().map(|value| format!("{value:02x}")).collect())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Event {
    event: String,
    request_id: Option<String>,
    error_code: Option<String>,
}

pub struct BackendProcess {
    // Keep the job alive through Child::wait; dropping it is an abnormal teardown boundary.
    #[cfg(windows)]
    _job: OwnedHandle,
    child: Child,
    input: ChildStdin,
    events: Receiver<Event>,
}

impl BackendProcess {
    pub fn start() -> Result<(Self, Connection), &'static str> {
        Self::start_mode(false, false)
    }

    pub fn start_mode(
        environment: bool,
        recovery: bool,
    ) -> Result<(Self, Connection), &'static str> {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .ok_or("repository_missing")?;
        Self::start_at(root, Duration::from_secs(30), environment, recovery)
    }

    fn start_at(
        root: &Path,
        timeout: Duration,
        environment: bool,
        recovery: bool,
    ) -> Result<(Self, Connection), &'static str> {
        let python = root.join(".venv/Scripts/python.exe");
        let backend = root.join("backend");
        if !python.is_file() || !backend.join("windows_local.py").is_file() {
            return Err("backend_python_or_entry_missing");
        }
        let launch_id = identifier()?;
        let mut command = Command::new(python);
        command
            .args(["windows_local.py", "--desktop", "--managed"])
            .current_dir(backend)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if environment {
            command.arg("--environment");
        }
        if recovery {
            command.arg("--connection-recovery");
        }
        #[cfg(windows)]
        let job = create_job()?;
        #[cfg(windows)]
        command.creation_flags(0x00000004 | 0x08000000); // CREATE_SUSPENDED | CREATE_NO_WINDOW
        let mut child = command.spawn().map_err(|_| "backend_spawn_failed")?;
        #[cfg(windows)]
        if assign_and_resume(&job, &child).is_err() {
            // This process is still suspended, so no persistence or Export work has started.
            let _ = child.kill();
            let _ = child.wait();
            return Err("backend_job_assignment_failed");
        }
        let mut input = child.stdin.take().ok_or("backend_control_unavailable")?;
        writeln!(input, "{}", serde_json::json!({"launchId": launch_id}))
            .map_err(|_| "backend_control_unavailable")?;
        input.flush().map_err(|_| "backend_control_unavailable")?;
        let output = child.stdout.take().ok_or("backend_control_unavailable")?;
        let (sender, events) = mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(output);
            loop {
                let mut bytes = Vec::new();
                if reader
                    .by_ref()
                    .take(4097)
                    .read_until(b'\n', &mut bytes)
                    .unwrap_or(0)
                    == 0
                    || bytes.len() > 4096
                {
                    break;
                }
                if let Some(payload) = bytes.strip_prefix(b"GENZOROOM_CONTROL ") {
                    if let Ok(event) = serde_json::from_slice(payload) {
                        if sender.send(event).is_err() {
                            break;
                        }
                    }
                }
            }
        });
        let mut owner = Self {
            #[cfg(windows)]
            _job: job,
            child,
            input,
            events,
        };
        let deadline = Instant::now() + timeout;
        loop {
            if let Ok(event) = owner.events.try_recv() {
                if event.event == "startup_failed" {
                    let code = if event.error_code.as_deref() == Some("local_port_unavailable") {
                        "local_port_unavailable"
                    } else {
                        "backend_startup_failed"
                    };
                    let _ = owner.child.wait();
                    return Err(code);
                }
            }
            if owner.exited()? {
                // Pipe delivery can trail process exit; retain the explicit conflict error.
                if owner
                    .events
                    .recv_timeout(Duration::from_millis(200))
                    .is_ok_and(|event| {
                        event.event == "startup_failed"
                            && event.error_code.as_deref() == Some("local_port_unavailable")
                    })
                {
                    return Err("local_port_unavailable");
                }
                return Err("backend_startup_failed");
            }
            if let Ok(connection) = Connection::load() {
                // A stale/manual instance is never probed or reused for an automatic launch.
                if connection.launch_id.as_deref() == Some(&launch_id)
                    && connection.verify_backend().is_ok()
                {
                    return Ok((owner, connection));
                }
            }
            if Instant::now() >= deadline {
                return Err("backend_startup_timeout");
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    pub fn exited(&mut self) -> Result<bool, &'static str> {
        self.child
            .try_wait()
            .map(|status| status.is_some())
            .map_err(|_| "backend_status_failed")
    }

    #[cfg(feature = "webview-smoke")]
    pub fn process_smoke(&mut self) -> Result<(), &'static str> {
        println!("GenzoRoom process smoke: ready {}", self.child.id());
        std::io::stdout()
            .flush()
            .map_err(|_| "smoke_output_failed")?;
        let mut line = String::new();
        std::io::stdin()
            .read_line(&mut line)
            .map_err(|_| "smoke_input_failed")?;
        let id = identifier()?;
        self.prepare(&id)?;
        self.shutdown(&id)
    }

    fn send(&mut self, command: &str, request_id: &str) -> Result<(), &'static str> {
        writeln!(
            self.input,
            "{}",
            serde_json::json!({"command": command, "requestId": request_id})
        )
        .and_then(|_| self.input.flush())
        .map_err(|_| "backend_control_failed")
    }

    pub fn prepare(&mut self, request_id: &str) -> Result<(), &'static str> {
        if self.exited()? {
            return Ok(());
        }
        self.send("prepare", request_id)?;
        self.await_event("prepared", request_id, Some(Duration::from_secs(15)))
    }

    pub fn resume(&mut self, request_id: &str) {
        let _ = self.send("resume", request_id);
    }

    pub fn shutdown(&mut self, request_id: &str) -> Result<(), &'static str> {
        if self.exited()? {
            return Ok(());
        }
        self.send("shutdown", request_id)?;
        // No deadline can truncate the current encoder/registration or abandon ownership.
        self.await_event("drained", request_id, None)?;
        let status = self.child.wait().map_err(|_| "backend_wait_failed")?;
        if status.success() {
            Ok(())
        } else {
            Err("backend_exited_unexpectedly")
        }
    }

    fn await_event(
        &mut self,
        expected: &str,
        request_id: &str,
        timeout: Option<Duration>,
    ) -> Result<(), &'static str> {
        let start = Instant::now();
        loop {
            if let Ok(event) = self.events.recv_timeout(Duration::from_millis(100)) {
                if event.request_id.as_deref() == Some(request_id) {
                    if event.event == expected {
                        return Ok(());
                    }
                    if event.event == "failed" {
                        return Err("backend_shutdown_failed");
                    }
                }
            }
            if self.exited()? {
                return Err("backend_exited_unexpectedly");
            }
            if timeout.is_some_and(|limit| start.elapsed() >= limit) {
                return Err("backend_prepare_timeout");
            }
        }
    }
}

#[cfg(windows)]
fn create_job() -> Result<OwnedHandle, &'static str> {
    use windows_sys::Win32::System::JobObjects::*;
    unsafe {
        let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if handle.is_null() {
            return Err("backend_job_creation_failed");
        }
        let job = OwnedHandle::from_raw_handle(handle);
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            handle,
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of_val(&limits) as u32,
        ) == 0
        {
            return Err("backend_job_configuration_failed");
        }
        Ok(job)
    }
}

#[cfg(windows)]
fn assign_and_resume(job: &OwnedHandle, child: &Child) -> Result<(), ()> {
    use windows_sys::Win32::{
        Foundation::INVALID_HANDLE_VALUE,
        System::{Diagnostics::ToolHelp::*, JobObjects::AssignProcessToJobObject, Threading::*},
    };
    unsafe {
        if AssignProcessToJobObject(job.as_raw_handle(), child.as_raw_handle()) == 0 {
            return Err(());
        }
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(());
        }
        let snapshot = OwnedHandle::from_raw_handle(snapshot);
        let mut entry: THREADENTRY32 = std::mem::zeroed();
        entry.dwSize = std::mem::size_of_val(&entry) as u32;
        let mut found = Thread32First(snapshot.as_raw_handle(), &mut entry);
        while found != 0 {
            if entry.th32OwnerProcessID == child.id() {
                let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                if thread.is_null() {
                    return Err(());
                }
                let thread = OwnedHandle::from_raw_handle(thread);
                return if ResumeThread(thread.as_raw_handle()) == u32::MAX {
                    Err(())
                } else {
                    Ok(())
                };
            }
            found = Thread32Next(snapshot.as_raw_handle(), &mut entry);
        }
        Err(())
    }
}
