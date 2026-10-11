// Prevents an extra console window on Windows in release mode
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    nis_ui_lib::run()
}
