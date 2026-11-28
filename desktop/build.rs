fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "desktop_lifecycle",
            "set_native_menu_language",
            "set_native_edit_menu_state",
        ]),
    ))
    .expect("desktop build metadata failed")
}
