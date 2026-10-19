#[cfg(windows)]
pub fn acquire() -> Result<std::os::windows::io::OwnedHandle, &'static str> {
    acquire_with_names(
        "Local\\GenzoRoom.WindowsPoC",
        "Local\\GenzoRoom.InstallerGate",
    )
}

#[cfg(windows)]
fn acquire_with_names(
    application_name: &str,
    installer_gate_name: &str,
) -> Result<std::os::windows::io::OwnedHandle, &'static str> {
    // Keep the probe handle until the app mutex exists, so installer startup cannot race this check.
    let (gate, gate_existed) = create_named(installer_gate_name)?;
    if gate_existed {
        return Err("desktop_install_in_progress");
    }
    let application = acquire_named(application_name)?;
    drop(gate);
    Ok(application)
}

#[cfg(windows)]
fn acquire_named(name: &str) -> Result<std::os::windows::io::OwnedHandle, &'static str> {
    let (handle, existed) = create_named(name)?;
    if existed {
        return Err("desktop_already_running");
    }
    Ok(handle)
}

#[cfg(windows)]
fn create_named(name: &str) -> Result<(std::os::windows::io::OwnedHandle, bool), &'static str> {
    use std::os::windows::io::{FromRawHandle, OwnedHandle};
    use windows_sys::Win32::{
        Foundation::{GetLastError, SetLastError, ERROR_ALREADY_EXISTS, ERROR_SUCCESS},
        System::Threading::CreateMutexW,
    };

    let name: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
    unsafe { SetLastError(ERROR_SUCCESS) };
    let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
    let last_error = unsafe { GetLastError() };
    if handle.is_null() {
        return Err("desktop_instance_lock_failed");
    }
    let handle = unsafe { OwnedHandle::from_raw_handle(handle.cast()) };
    Ok((handle, last_error == ERROR_ALREADY_EXISTS))
}

#[cfg(not(windows))]
pub fn acquire() -> Result<(), &'static str> {
    Err("windows_required")
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn a_second_host_cannot_share_the_live_webview_profile() {
        let name = format!(
            "Local\\GenzoRoom.Tests.{}",
            crate::backend_process::identifier().unwrap()
        );
        let first = acquire_named(&name).unwrap();
        assert_eq!(acquire_named(&name).err(), Some("desktop_already_running"));
        drop(first);
        assert!(acquire_named(&name).is_ok());
    }

    #[test]
    fn an_active_installer_gate_blocks_host_startup_and_releases_cleanly() {
        let suffix = crate::backend_process::identifier().unwrap();
        let application = format!("Local\\GenzoRoom.Tests.App.{suffix}");
        let installer_gate = format!("Local\\GenzoRoom.Tests.Installer.{suffix}");
        let gate = acquire_named(&installer_gate).unwrap();

        assert_eq!(
            acquire_with_names(&application, &installer_gate).err(),
            Some("desktop_install_in_progress")
        );
        drop(gate);

        let host = acquire_with_names(&application, &installer_gate).unwrap();
        assert_eq!(
            acquire_with_names(&application, &installer_gate).err(),
            Some("desktop_already_running")
        );
        drop(host);
        assert!(acquire_with_names(&application, &installer_gate).is_ok());
    }
}
