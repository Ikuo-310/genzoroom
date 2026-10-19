#[cfg(windows)]
pub fn acquire() -> Result<std::os::windows::io::OwnedHandle, &'static str> {
    // The old WebView must exit before another host can share its cookie store and origin.
    acquire_named("Local\\GenzoRoom.WindowsPoC")
}

#[cfg(windows)]
fn acquire_named(name: &str) -> Result<std::os::windows::io::OwnedHandle, &'static str> {
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
    if last_error == ERROR_ALREADY_EXISTS {
        return Err("desktop_already_running");
    }
    Ok(handle)
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
}
