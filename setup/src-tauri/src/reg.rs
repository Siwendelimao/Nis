//! 最小注册表写入（0915）
//!
//! 为什么不用 `reg.exe`：① 本机安全策略把 reg.exe 列了黑名单，外部进程不可靠；
//! ② 之前用 .reg 文件 + `reg import` 还要处理 UTF-16/转义，路径含中文用户名时容易踩坑。
//! 这里直接调 advapi32，零新依赖、零外部进程，写 HKCU 字符串值。
#![cfg(windows)]

use std::os::windows::ffi::OsStrExt;

type HKey = *mut std::ffi::c_void;

/// 预定义句柄必须按 LONG 符号扩展到指针宽度：0x80000001 → 0xFFFFFFFF80000001
const HKEY_CURRENT_USER: HKey = 0x8000_0001u32 as i32 as isize as HKey;
const KEY_SET_VALUE: u32 = 0x0002;
const REG_SZ: u32 = 1;

#[link(name = "advapi32")]
extern "system" {
    fn RegCreateKeyExW(
        hkey: HKey,
        sub_key: *const u16,
        reserved: u32,
        class: *const u16,
        options: u32,
        sam: u32,
        security: *mut std::ffi::c_void,
        result: *mut HKey,
        disposition: *mut u32,
    ) -> i32;
    fn RegSetValueExW(
        hkey: HKey,
        value_name: *const u16,
        reserved: u32,
        ty: u32,
        data: *const u8,
        cb_data: u32,
    ) -> i32;
    fn RegCloseKey(hkey: HKey) -> i32;
    fn RegDeleteTreeW(hkey: HKey, sub_key: *const u16) -> i32;
}

fn wide(s: &str) -> Vec<u16> {
    std::ffi::OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

/// 在 HKCU 下写一个 REG_SZ 值（键不存在则创建）
pub fn set_hkcu_string(sub_key: &str, value_name: &str, value: &str) -> Result<(), String> {
    let sub = wide(sub_key);
    let name = wide(value_name);
    let data = wide(value);
    unsafe {
        let mut hkey: HKey = std::ptr::null_mut();
        let mut disp: u32 = 0;
        let rc = RegCreateKeyExW(
            HKEY_CURRENT_USER,
            sub.as_ptr(),
            0,
            std::ptr::null(),
            0,
            KEY_SET_VALUE,
            std::ptr::null_mut(),
            &mut hkey,
            &mut disp,
        );
        if rc != 0 {
            return Err(format!("RegCreateKeyExW 失败 rc={}", rc));
        }
        // REG_SZ 的字节数包含结尾 NUL
        let cb = (data.len() * 2) as u32;
        let rc2 = RegSetValueExW(hkey, name.as_ptr(), 0, REG_SZ, data.as_ptr() as *const u8, cb);
        RegCloseKey(hkey);
        if rc2 != 0 {
            return Err(format!("RegSetValueExW 失败 rc={}", rc2));
        }
    }
    Ok(())
}

/// 删除 HKCU 下的整棵键树（键不存在视为成功）。
/// 用途：卸载兜底时清掉「应用和功能」条目与厂商键。
pub fn delete_key_hkcu(sub_key: &str) -> Result<(), String> {
    let sub = wide(sub_key);
    unsafe {
        let rc = RegDeleteTreeW(HKEY_CURRENT_USER, sub.as_ptr());
        // 2 = ERROR_FILE_NOT_FOUND：本来就没有 → 也算成功
        if rc != 0 && rc != 2 {
            return Err(format!("RegDeleteTreeW 失败 rc={}", rc));
        }
    }
    Ok(())
}
