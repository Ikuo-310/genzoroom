use std::mem::size_of;

use tauri::WebviewWindow;
use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::Graphics::Dwm::{
    DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_CAPTION_COLOR, DWMWA_COLOR_DEFAULT,
    DWMWA_TEXT_COLOR, DWMWA_USE_IMMERSIVE_DARK_MODE,
};

const TITLEBAR_COLOR: u32 = 0x001B_1818;
const TITLE_TEXT_COLOR: u32 = 0x00FF_FFFF;
const DARK_MODE: i32 = 1;
const LIGHT_MODE: i32 = 0;

pub fn apply_dark_theme(window: &WebviewWindow) {
    let hwnd = match window.hwnd() {
        Ok(hwnd) => hwnd.0,
        Err(_) => {
            eprintln!("GenzoRoom desktop: titlebar_theme_unavailable");
            return;
        }
    };

    let result = unsafe {
        set_attribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE as u32, &DARK_MODE)
            .and_then(|_| set_attribute(hwnd, DWMWA_CAPTION_COLOR as u32, &TITLEBAR_COLOR))
            .and_then(|_| set_attribute(hwnd, DWMWA_TEXT_COLOR as u32, &TITLE_TEXT_COLOR))
            .and_then(|_| set_attribute(hwnd, DWMWA_BORDER_COLOR as u32, &TITLEBAR_COLOR))
    };

    if result.is_err() {
        // Keep the native caption usable when an older Windows/DWM rejects these attributes.
        unsafe { reset_attributes(hwnd) };
        eprintln!("GenzoRoom desktop: titlebar_theme_unavailable");
    }
}

unsafe fn set_attribute<T>(hwnd: HWND, attribute: u32, value: &T) -> Result<(), ()> {
    let result = unsafe {
        DwmSetWindowAttribute(
            hwnd,
            attribute,
            (value as *const T).cast(),
            size_of::<T>() as u32,
        )
    };
    if result >= 0 {
        Ok(())
    } else {
        Err(())
    }
}

unsafe fn reset_attributes(hwnd: HWND) {
    let _ = unsafe { set_attribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE as u32, &LIGHT_MODE) };
    let _ = unsafe { set_attribute(hwnd, DWMWA_CAPTION_COLOR as u32, &DWMWA_COLOR_DEFAULT) };
    let _ = unsafe { set_attribute(hwnd, DWMWA_TEXT_COLOR as u32, &DWMWA_COLOR_DEFAULT) };
    let _ = unsafe { set_attribute(hwnd, DWMWA_BORDER_COLOR as u32, &DWMWA_COLOR_DEFAULT) };
}
