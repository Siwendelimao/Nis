//! NIS 自绘安装/卸载向导（0915）
//!
//! 形态：无边框 WebView 壳（界面 = docs/installer-mock.html 那套深色沉浸 UI + 中英双语）。
//! 真安装动作仍然交给内嵌的 Tauri NSIS 引擎（`/S` 静默 + `/D=` 指定目录），
//! 壳只负责：挑目录 → 起引擎 → 用「目标目录真实体积」驱动进度 → 落地自绘卸载器 + 改写卸载入口。
//!
//! 这样既拿到了设计稿的观感，又不丢 NSIS 久经考验的安装/快捷方式/注册表/WebView2 引导。
//!
//! 卸载对称：安装目录里的 `NIS-Uninstall.exe` 就是本壳截出来的「无载荷版」，
//! 运行时先把自己搬到 %TEMP% 再干活（否则删不掉自己），然后驱动 `uninstall.exe /S`。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod payload;
#[cfg(windows)]
mod reg;

use payload::Manifest;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const PRODUCT: &str = "NIS";
const DEFAULT_DIR_NAME: &str = "NIS";
/// 与 `frontend/src-tauri/tauri.conf.json` 的 `identifier` 一致 ——
/// Tauri 用它当 WebView2 用户数据目录名（`%LOCALAPPDATA%\<identifier>`），卸载时要清掉
const IDENTIFIER: &str = "com.nis.interface";
/// 安装器自己（`setup/src-tauri`）的 identifier —— 它也有一个 WebView2 目录要清
const SETUP_IDENTIFIER: &str = "com.nis.setup";

// ────────────────────────────── 状态 ──────────────────────────────

#[derive(Default)]
struct AppState {
    busy: AtomicBool,
    cancel: AtomicBool,
    child: Mutex<Option<Child>>,
    mode: Mutex<String>, // "install" | "uninstall"
    root: Mutex<String>, // 卸载模式下的安装目录
    delete_data: AtomicBool,
}

// ────────────────────────────── 小工具 ──────────────────────────────

fn log(msg: &str) {
    let dir = std::env::temp_dir().join("nis-setup");
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("setup.log"))
    {
        use std::io::Write;
        let _ = writeln!(f, "{}", msg);
    }
}

fn exe_path() -> PathBuf {
    std::env::current_exe().unwrap_or_else(|_| PathBuf::from("nis-setup.exe"))
}

fn is_uninstall_invocation() -> bool {
    if std::env::args().any(|a| a == "--uninstall") {
        return true;
    }
    exe_path()
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase().contains("uninstall"))
        .unwrap_or(false)
}

fn resolve_uninstall_root() -> PathBuf {
    if let Ok(v) = std::env::var("NIS_UNINST_ROOT") {
        if !v.trim().is_empty() {
            return PathBuf::from(v);
        }
    }
    exe_path().parent().map(|p| p.to_path_buf()).unwrap_or_default()
}

fn default_install_dir() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".into());
    PathBuf::from(base).join("Programs").join(DEFAULT_DIR_NAME)
}

/// %APPDATA%\nis —— 与主应用 lib.rs 里的 app_base_dir() 同一个位置
/// （打包版与开发版共用这份配置；安装收尾的「全新空装」重置也写这里）
fn app_base_dir() -> PathBuf {
    let appdata = std::env::var("APPDATA").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(appdata).join("nis")
}

// ─────────────────── 卸载清理（0918 重做：残留清理）───────────────────

/// 卸载时要清掉的「运行期缓存」—— **不是**用户数据，删掉无副作用（运行时会自动重建）：
/// * `%LOCALAPPDATA%\com.nis.interface` —— 主应用的 WebView2 用户数据目录（按 identifier 命名）。
///   ★ 0918 修：此前写的是 `%APPDATA%\com.nis.interface`，**路径是错的** ——
///   于是每次卸载都留下一个 ~67MB 的 Chromium 档案（Cache/GPUCache/Code Cache 就占 37MB）。
/// * `%LOCALAPPDATA%\com.nis.setup` —— **安装器自己**的 WebView2 目录（identifier = `com.nis.setup`），
///   实测同样会留下 ~17MB。0918 补：这一条是盘点残留时现场发现的，别漏。
/// * 不碰 `%LOCALAPPDATA%\nis` —— 那不是我们的目录（本应用用的是 `%APPDATA%\nis`），
///   万一有别的软件占用同名目录，删了就成事故。
fn cache_dirs() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Ok(la) = std::env::var("LOCALAPPDATA") {
        v.push(PathBuf::from(&la).join(IDENTIFIER));
        v.push(PathBuf::from(&la).join(SETUP_IDENTIFIER));
    }
    v
}

/// 递归删除的**安全闸门**：盘根 / 用户主目录 / %TEMP% / Windows / Program Files / 桌面·文档
/// 一个都不许删。防的是「路径解析歪掉 → remove_dir_all 把不该删的删了」。
fn is_protected_dir(p: &Path) -> bool {
    let norm = |s: &str| s.trim_end_matches(['\\', '/']).to_lowercase();
    if p.components().count() <= 1 {
        return true; // 盘根 "D:\"
    }
    let cur = norm(&p.to_string_lossy());
    if cur.len() <= 2 {
        return true; // "c:" / "d:"
    }
    for k in [
        "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ProgramData",
        "SystemRoot", "windir", "ProgramFiles", "ProgramFiles(x86)", "PUBLIC",
    ] {
        if let Ok(v) = std::env::var(k) {
            let g = norm(&v);
            if !g.is_empty() && g == cur {
                return true;
            }
        }
    }
    if let Ok(sr) = std::env::var("SystemRoot") {
        if cur.starts_with(&(norm(&sr) + "\\")) {
            return true; // Windows 目录内部
        }
    }
    for bad in ["\\desktop", "\\documents", "\\downloads", "\\桌面", "\\文档"] {
        if cur.ends_with(bad) {
            return true;
        }
    }
    false
}

/// 看起来像 NIS 安装目录吗？不像就**绝不整目录删**（宁可留一点空壳，也不误删用户自己的东西）。
fn looks_like_nis_install(p: &Path) -> bool {
    p.join("NIS.exe").is_file()
        || p.join("uninstall.exe").is_file()
        || p.join("NIS-Uninstall.exe").is_file()
        || p.join("pack").is_dir()
}

/// 目录可写探针：真建一个文件再删（Windows 上靠权限位判断不准）。
/// 用 `create_dir_all` + 写探针，是为了把"能建目录但写不进文件"也一起抓到（`C:\Program Files` 就是这种）。
fn probe_dir_writable(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("建目录失败：{}", e))?;
    let probe = dir.join(".nis-write-probe");
    match std::fs::write(&probe, b"1") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            Ok(())
        }
        Err(e) => Err(format!("写入被拒绝：{}", e)),
    }
}

/// ★1010：清扫历史遗留的 `*.nis-deleting-<ts>` 目录（`fast_rm` 改名后的产物）。
/// 装上/卸下都先扫一遍 —— 否则它们会被后来的卸载当成"卸载残留"钉在用户目录里
/// （`fast_rm` 的注释里早写着这条隐患，这里把它闭环掉）。
fn sweep_deleting_dirs(root: &Path) {
    if !root.is_dir() {
        return;
    }
    let Ok(rd) = std::fs::read_dir(root) else { return };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !name.contains(".nis-deleting-") {
            continue;
        }
        let p = e.path();
        log(&format!("[cleanup] 清扫待删目录：{}", p.display()));
        if p.is_dir() {
            spawn_bg_delete(&p, "历史待删目录");
        } else {
            let _ = std::fs::remove_file(&p);
        }
    }
}

/// 带闸门的删目录 + 日志
fn rm_dir_safe(p: &Path, what: &str) {
    if !p.exists() {
        return;
    }
    if is_protected_dir(p) {
        log(&format!("[cleanup] ⚠ 跳过受保护目录（{}）：{}", what, p.display()));
        return;
    }
    match std::fs::remove_dir_all(p) {
        Ok(()) => log(&format!("[cleanup] 已删 {} → {}", what, p.display())),
        Err(e) => log(&format!(
            "[cleanup] 删 {} 失败（多半被占用）：{} → {}",
            what,
            p.display(),
            e
        )),
    }
}

/* ── 大目录的"快删"（0919：老大反馈卸载时「清理运行环境」卡很久）────────────
 * 为什么慢：本机**删除单个文件要 ~200ms**（腾讯内核驱动 TFsFlt/QQSysMonX64 收税，见长期记忆），
 * WebView2 档案 / env 里的 venv 动辄**上万个文件** → remove_dir_all 就是几十分钟级的卡顿。
 * 做法：**同盘改名是瞬时的** → 先改名成 `xxx.nis-deleting-<时间戳>`，再由一个 detached 的 cmd 慢慢删。
 *      界面那一步立刻就能过；万一后台删失败，只会留下一个 `.nis-deleting-*` 名字的目录（无害，下次卸载会再扫到）。
 * ⚠️ 只用在"纯缓存/一次性数据"上；安装目录本身仍走 rm_dir_safe —— 那个必须真删掉，
 *    留个改名目录会被当成新的残留。 */
fn fast_rm(p: &Path, what: &str) {
    if !p.exists() {
        return;
    }
    if is_protected_dir(p) {
        log(&format!("[cleanup] ⚠ 跳过受保护目录（{}）：{}", what, p.display()));
        return;
    }
    let parent = p.parent().map(|q| q.to_path_buf()).unwrap_or_else(|| PathBuf::from("."));
    let name = p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "nis-tmp".into());
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let tmp = parent.join(format!("{}.nis-deleting-{}", name, secs));
    match std::fs::rename(p, &tmp) {
        Ok(()) => {
            log(&format!("[cleanup] {} 已改名待后台删除：{}", what, tmp.display()));
            spawn_bg_delete(&tmp, what);
        }
        Err(e) => {
            log(&format!("[cleanup] {} 改名失败（{}）→ 退回直接删", what, e));
            rm_dir_safe(p, what);
        }
    }
}

/// 起一个脱离进程的 cmd 去慢慢删目录（Windows 下 `rd /s /q`）
fn spawn_bg_delete(p: &Path, what: &str) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        /* ⚠️ 0920 修「卸载完成时会闪一个命令行窗口」（老大反馈）：
         *  原来传的是 `CREATE_NO_WINDOW | DETACHED_PROCESS` —— 而 MSDN 白纸黑字写着
         *  **CREATE_NO_WINDOW 与 DETACHED_PROCESS / CREATE_NEW_CONSOLE 同时用时会被忽略**
         *  （"This flag is ignored if ... used with either CREATE_NEW_CONSOLE or DETACHED_PROCESS"）。
         *  于是 cmd.exe 拿到了一个**可见的**控制台窗口 → 用户看到一个黑框一闪。
         *  现在只留 CREATE_NO_WINDOW：控制台照样建，但**不显示窗口**；
         *  子进程不再随父进程走（父进程是无控制台的 GUI），继续用一个新进程组保命。 */
        let script = std::env::temp_dir().join(format!(
            "nis-clean-{}.cmd",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ));
        let body = format!("@echo off\r\nping -n 3 127.0.0.1 >nul\r\nrd /s /q \"{}\"\r\n", p.display());
        if let Err(e) = std::fs::write(&script, body) {
            log(&format!("[cleanup] 写清理脚本失败（{}）→ 退回直接删", e));
            rm_dir_safe(p, what);
            return;
        }
        // raw_arg：别让 Rust 去转义引号（cmd.exe 不认 `\"` 那套，会把命令拆坏）
        let mut c = Command::new("cmd");
        c.raw_arg("/C").raw_arg(format!("\"{}\"", script.display()));
        c.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
        match c.spawn() {
            Ok(ch) => log(&format!("[cleanup] 后台删除已拉起 pid={}（{}）", ch.id(), what)),
            Err(e) => {
                log(&format!("[cleanup] 后台删除拉起失败（{}）→ 退回直接删", e));
                rm_dir_safe(p, what);
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = what;
        rm_dir_safe(p, what);
    }
}

/// ★ 单实例闸门（0919 老大要求：装了/卸了一个，再开一个要提示"已经有一个在运行中"）——
/// 两个同时跑会抢同一个安装目录 / 同一个引擎临时文件，是"装到一半失败"的经典来源。
/// 用命名互斥体（`Global\` 前缀 = 跨会话；同一用户下第二个进程会拿到 ERROR_ALREADY_EXISTS）。
/// 返回 false = 已有实例，调用方应直接退出。
fn single_instance_guard() -> bool {
    #[cfg(windows)]
    unsafe {
        #[link(name = "kernel32")]
        extern "system" {
            fn CreateMutexW(attr: *const core::ffi::c_void, owner: i32, name: *const u16) -> isize;
            fn GetLastError() -> u32;
            fn MessageBoxW(hwnd: isize, text: *const u16, caption: *const u16, ty: u32) -> i32;
        }
        const ERROR_ALREADY_EXISTS: u32 = 183;
        const MB_OK: u32 = 0x0;
        const MB_ICONINFORMATION: u32 = 0x40;
        let name: Vec<u16> = "Global\\NIS-Setup-SingleInstance\0".encode_utf16().collect();
        let h = CreateMutexW(core::ptr::null(), 0, name.as_ptr());
        if h == 0 {
            return true; // 建不出来就别拦人（宁可重复也不能把人挡在门外）
        }
        if GetLastError() == ERROR_ALREADY_EXISTS {
            let text: Vec<u16> = "NIS 安装程序已经有一个在运行中。\r\n请先关掉那个窗口，再重新打开。\0"
                .encode_utf16()
                .collect();
            let cap: Vec<u16> = "NIS 安装程序\0".encode_utf16().collect();
            MessageBoxW(0, text.as_ptr(), cap.as_ptr(), MB_OK | MB_ICONINFORMATION);
            return false;
        }
        /* 刻意不 CloseHandle：句柄随进程结束释放。
           提前关掉会让闸门在"还没干完活"时失效 —— 泄漏一个句柄远比误放行安全。 */
        true
    }
    #[cfg(not(windows))]
    {
        true
    }
}

/// 卸载前先结束主程序 —— 它锁着 `NIS.exe` / `pack\node.exe` / sqlite 库，
/// 不杀就会出现「删不掉的安装目录残骸」（用户反馈的残留主因）。
/// 只针对 `NIS.exe` 及其子进程树（/T），**不动系统上别的 node.exe**（开发版后端也在跑）。
fn kill_running_app(root: &Path) {
    if root.join("NIS.exe").exists() {
        let mut c = Command::new("taskkill");
        c.args(["/F", "/T", "/IM", "NIS.exe"]);
        #[cfg(windows)]
        c.creation_flags(CREATE_NO_WINDOW);
        match c.status() {
            Ok(s) => log(&format!("[cleanup] 结束 NIS.exe 进程 success={}", s.success())),
            Err(e) => log(&format!("[cleanup] 结束 NIS.exe 进程失败（继续卸载）：{}", e)),
        }
    }
    kill_procs_under(root);
    std::thread::sleep(Duration::from_millis(900));
}

/// 结束「可执行文件位于安装目录内」的进程 —— 主要是 sidecar `pack\node.exe`。
///
/// ★ 0919（老大实测：卸载后剩一个删不掉的 `D:\nis\pack`）：
///   `taskkill /IM NIS.exe /T` 靠**父子关系**找子树，而 sidecar 在壳被强杀 / 壳自重启之后
///   **会变成孤儿**（父进程已经不在了）→ `/T` 找不到它 → 它锁着自己的 exe 与 `pack\backend\`，
///   结果就是"删一半留一半"：`pack\dist` 删掉了、`pack\node.exe` 和 `pack\backend` 留着。
///   这里按**可执行路径**再杀一轮。taskkill 没有按路径过滤的能力；wmic 从 Win11 24H2 起已被移除，
///   所以用 PowerShell（所有受支持 Windows 都自带）。拿不到就跳过 —— 这只是兜底。
fn kill_procs_under(root: &Path) {
    #[cfg(windows)]
    {
        let ps_exe = std::env::var("SystemRoot")
            .map(|r| format!("{}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", r))
            .unwrap_or_else(|_| "powershell".to_string());
        if !Path::new(&ps_exe).exists() {
            log("[cleanup] 找不到 powershell → 跳过「按路径清理进程」");
            return;
        }
        let pat = root.display().to_string().replace('\'', "''");
        let ps = format!(
            "Get-CimInstance Win32_Process | Where-Object {{ $_.ExecutablePath -like '{pat}\\*' }} \
             | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }}"
        );
        let mut c = Command::new(&ps_exe);
        c.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &ps]);
        c.creation_flags(CREATE_NO_WINDOW);
        match c.status() {
            Ok(s) => log(&format!("[cleanup] 按路径清理安装目录内进程 success={}", s.success())),
            Err(e) => log(&format!("[cleanup] 按路径清理进程失败（继续卸载）：{}", e)),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = root;
    }
}

/// 快捷方式：开始菜单（单文件 + 同名子目录两种形态）与桌面（用户 + 公共）
fn remove_shortcuts() {
    if let Ok(appdata) = std::env::var("APPDATA") {
        let sm = PathBuf::from(&appdata).join("Microsoft\\Windows\\Start Menu\\Programs");
        let _ = std::fs::remove_file(sm.join(format!("{}.lnk", PRODUCT)));
        let _ = std::fs::remove_file(sm.join(format!("{}.url", PRODUCT)));
        let sub = sm.join(PRODUCT);
        // 同名子目录只在「确实是装出来的」情况下删（里面有它的快捷方式）
        if sub.join(format!("{}.lnk", PRODUCT)).exists() {
            rm_dir_safe(&sub, "开始菜单目录");
        }
    }
    if let Ok(profile) = std::env::var("USERPROFILE") {
        let d = PathBuf::from(&profile).join("Desktop");
        let _ = std::fs::remove_file(d.join(format!("{}.lnk", PRODUCT)));
        let _ = std::fs::remove_file(d.join(format!("{}.url", PRODUCT)));
    }
    if let Ok(pubd) = std::env::var("PUBLIC") {
        let d = PathBuf::from(&pubd).join("Desktop");
        let _ = std::fs::remove_file(d.join(format!("{}.lnk", PRODUCT)));
    }
}

/// 安装目录里**确定属于 NIS** 的顶层条目。卸载只按这份名单删，其它一律当"用户自己放的东西"保留。
/// 0919：安装版的数据现在**就在安装目录里**（data / skills / memory / logs + config.json），
/// 其中 `config.json` 与 `logs/` 是应用自己生成的 → 无条件删（会重新生成）；
/// `data` / `skills` / `memory` 是**用户数据** → 只在勾了「删除用户数据」时才删（见 cleanup_after_uninstall）。
const OWNED_TOP: &[&str] = &[
    "NIS.exe",
    "NIS-Uninstall.exe",
    "NIS-Uninstall.exe.old",
    "uninstall.exe",
    "pack",
    "dist",
    "config.json",
    "config.dev-backup.json",
    "logs",
];

/// 清安装目录：**只删 NIS 自己的东西** + 收敛空目录 + 目录空了才删目录。
///
/// ★ 0919 改（老大实测反馈："我把 NIS 放 D:\nis，卸载的时候连 D:\nis 这个文件夹也删了"）：
///   之前这里直接 `remove_dir_all(root)` —— 太狠了。安装目录是**用户自己选的路径**，
///   他完全可能在同一个文件夹里放别的东西（放着别的软件的文件夹）。
///   标准安装器（NSIS / Inno）的做法也是：只删自己登记的文件、只在目录空时才删目录。
///   所以现在两头都占：删干净自己的（保证没残留）+ 一个字节都不动别人的（保证不误删）。
fn clean_install_dir(root: &Path) {
    if !root.is_dir() {
        return;
    }
    for name in OWNED_TOP {
        let p = root.join(name);
        if !p.exists() || is_protected_dir(&p) {
            continue;
        }
        if p.is_dir() {
            match std::fs::remove_dir_all(&p) {
                Ok(()) => log(&format!("[cleanup] 已删 {}\\（NIS 自己的目录）", name)),
                Err(e) => log(&format!("[cleanup] 删 {}\\ 失败（多半被占用）：{}", name, e)),
            }
        } else {
            let _ = std::fs::remove_file(&p);
            log(&format!("[cleanup] 已删 {}", name));
        }
    }
    /* ★ 0919：「删一半留一半」的兜底重试。
       Windows 上被占用的文件删不掉是常态：sidecar 刚被杀、句柄还没释放时，
       `pack\dist` 能删掉、`pack\node.exe` + `pack\backend` 留着 → 残留一个残缺的 pack\（老大实测）。
       这里再杀一轮目录内进程 + 重试几轮，给句柄释放留出窗口。 */
    for attempt in 1..=6 {
        let left: Vec<&str> = OWNED_TOP.iter().copied().filter(|n| root.join(n).exists()).collect();
        if left.is_empty() {
            break;
        }
        log(&format!(
            "[cleanup] 第 {} 轮重试删除，仍占用：{}",
            attempt,
            left.join(" , ")
        ));
        kill_procs_under(root);
        std::thread::sleep(Duration::from_millis(500));
        for name in left {
            let p = root.join(name);
            if p.is_dir() {
                let _ = std::fs::remove_dir_all(&p);
            } else {
                let _ = std::fs::remove_file(&p);
            }
        }
    }
    // 运行期产生的自家杂项：`.nis-history` 这类以 `.nis` 开头的
    if let Ok(rd) = std::fs::read_dir(root) {
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if n.starts_with(".nis") {
                let p = e.path();
                if p.is_dir() {
                    let _ = std::fs::remove_dir_all(&p);
                } else {
                    let _ = std::fs::remove_file(&p);
                }
                log(&format!("[cleanup] 已删运行期杂项 {}", n));
            }
        }
    }
    // 空目录收敛；根目录彻底空了才删（非空 = 用户自己的东西，保留）
    remove_empty_dirs(root);
    let remain: Vec<String> = std::fs::read_dir(root)
        .map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect())
        .unwrap_or_default();
    if remain.is_empty() {
        match std::fs::remove_dir(root) {
            Ok(()) => log("[cleanup] 安装目录已空 → 删除该目录"),
            Err(e) => log(&format!("[cleanup] 删除空目录失败：{}", e)),
        }
    } else {
        log(&format!(
            "[cleanup] 安装目录里还有用户自己的东西 → **保留目录**，只删了我们自己的：{}",
            remain.join(" , ")
        ));
    }
}

/// 从 JSON 文本里取一个字符串字段。不引 serde 是为了少一处依赖 —— 只用于读自己写的配置。
/// （按 char 遍历，避免路径里的中文被按字节拆坏。）
fn json_str(s: &str, key: &str) -> Option<String> {
    let pat = format!("\"{}\"", key);
    let i = s.find(&pat)? + pat.len();
    let rest = &s[i..];
    let c = rest.find(':')? + 1;
    let rest = rest[c..].trim_start();
    let mut it = rest.strip_prefix('"')?.chars();
    let mut out = String::new();
    while let Some(ch) = it.next() {
        match ch {
            '"' => return Some(out),
            '\\' => match it.next() {
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some('r') => out.push('\r'),
                Some(o) => out.push(o),
                None => break,
            },
            o => out.push(o),
        }
    }
    Some(out)
}

/// ★ 0920 二次修订（老大口径）：**产出物与工作区可以导出，卸载时直接删掉也没关系** ——
/// 所以这里回到"勾了就整棵删"的语义；这个常量只保留一个用途：日志里把"即将删除的这两样"
/// 点名写出来，让人一眼知道 `exports\`（导出包）与 `storage\chat_*`（工作区）也在删除范围内。
const KEEP_IN_DATA: &[&str] = &["exports", "storage"];

/// 卸载时要处理的外部分区（用户可能把数据放到 `%APPDATA%\nis` / 安装目录之外）
#[derive(Default)]
struct ExtDirs {
    /// 数据根：整体删（产出物/工作区也在里面，0920 老大口径：删掉没关系）
    data_roots: Vec<PathBuf>,
    /// 技能目录 / 环境目录（envDir）：整体删
    other: Vec<PathBuf>,
    /// 存储根（storagePath）：一并删（工作区/产出物可自行导出）
    storage: Vec<PathBuf>,
}

/// 用户可能把数据放到了 `%APPDATA%\nis` **之外**：
///   · config.json 的 `dataDir` / `skillsDir`
///   · `<dataDir>\settings.json` 的 `storagePath`（存储目录：对话工作区）与 `envDir`（语义环境）
/// ★ 0919（老大明确）：勾了「删除用户数据」就要**连这些一起删** —— 它们是用户自己指定的路径，
///   只删 %APPDATA%\nis 会在 D:\niscs 这类地方留下真正的残留。
/// ★ 0920 二次修订：storagePath 不再例外 —— 勾「删除用户数据」就连它一起删（见 KEEP_IN_DATA 注释）。
/// ⚠️ 必须在删 `%APPDATA%\nis` **之前**调用：路径记录就存在那里，删完就再也找不到这些目录了。
fn external_data_dirs() -> ExtDirs {
    /* 0919：应用的数据**搬进安装目录了**，config.json 也搬过去了 → 这里必须两个位置都读：
     *   · 新：`<安装目录>\config.json`，settings.json 在 `<安装目录>\data\settings.json`
     *   · 老：`%APPDATA%\nis\config.json`（没迁过/装到不可写位置的用户）
     * 漏读的后果很具体：老大选的存储目录（如 D:\niscs）在卸载勾「删除数据」时不会被清 —— 这正是他抱怨过的残留。 */
    let install = resolve_root_checked("");
    let legacy = app_base_dir();
    let mut data_roots: Vec<String> = Vec::new();
    let mut other: Vec<String> = Vec::new();
    let mut storage: Vec<String> = Vec::new();
    for base in [&install, &legacy] {
        let cfg = base.join("config.json");
        let Ok(s) = std::fs::read_to_string(&cfg) else { continue };
        if let Some(v) = json_str(&s, "dataDir") {
            data_roots.push(v);
        }
        if let Some(v) = json_str(&s, "skillsDir") {
            other.push(v);
        }
    }
    // 新布局：设置（含 storagePath / envDir）在数据根的 settings.json；老布局同理，只是数据根不同
    if install != legacy {
        data_roots.push(install.join("data").to_string_lossy().to_string());
    }
    data_roots.push(legacy.join("data").to_string_lossy().to_string());
    for d in &data_roots {
        if d.is_empty() {
            continue;
        }
        if let Ok(s) = std::fs::read_to_string(PathBuf::from(d).join("settings.json")) {
            if let Some(v) = json_str(&s, "storagePath") {
                storage.push(v);
            }
            if let Some(v) = json_str(&s, "envDir") {
                other.push(v);
            }
        }
    }
    let norm = |cands: Vec<String>, keep_inside: bool| -> Vec<PathBuf> {
        let mut out: Vec<PathBuf> = Vec::new();
        for c in cands {
            let pb = PathBuf::from(c);
            if pb.as_os_str().is_empty() || !pb.is_dir() {
                continue;
            }
            // 落在"安装目录"或"老数据目录"里的，由各自的整目录清理负责，这里只负责"外面的"；
            // 存储根例外 —— 它可能就在安装目录里面（默认 <安装目录>\data\storage），也要记下来"别删"。
            if !keep_inside && (pb.starts_with(&install) || pb.starts_with(&legacy)) {
                continue;
            }
            if out.iter().any(|x| *x == pb) {
                continue;
            }
            out.push(pb);
        }
        out
    };
    ExtDirs {
        data_roots: norm(data_roots, false),
        other: norm(other, false),
        storage: norm(storage, false),
    }
}

/// 数据目录收尾：勾了「删除数据」→ 删 `%APPDATA%\nis` **以及用户指定的外部目录**（含产出物与工作区）；
/// 没勾 → **用户数据一个字节都不动**，只把空目录收掉
/// （避免留下 `imports\<时间戳>\data` 这种空壳）
fn cleanup_data_dir(delete_data: bool) {
    let base = app_base_dir();
    if delete_data {
        let ext = external_data_dirs();
        log(&format!(
            "[cleanup] 勾了「删除用户数据」→ 会删掉 {} 与 {} 这两样（老大口径：产出物/工作区可以导出，删掉没关系）",
            KEEP_IN_DATA[0], KEEP_IN_DATA[1]
        ));
        for p in ext
            .storage
            .iter()
            .chain(ext.other.iter())
            .chain(ext.data_roots.iter())
        {
            fast_rm(p, "用户指定的数据目录");
        }
        /* ★ 这个目录里装着 env/（记忆检索模型的 venv，上万文件）+ 记忆库/知识库 + 工作区，
           直接 remove_dir_all 就是老大反馈的"清理运行环境卡很久" → 走快删。 */
        fast_rm(&base, "数据目录 %APPDATA%\\nis");
        return;
    }
    if !base.exists() {
        return;
    }
    remove_empty_dirs(&base);
    let empty = std::fs::read_dir(&base).map(|rd| rd.count() == 0).unwrap_or(false);
    if empty {
        let _ = std::fs::remove_dir(&base);
        log("[cleanup] 数据目录只剩空壳 → 删掉（无用户数据）");
    } else {
        log("[cleanup] 保留数据目录（未勾选「删除数据」）");
    }
}


/// 目录体检：总字节 / 文件数 / 最新文件名（供进度与文件滚动条用）
#[derive(Default, Clone)]
struct Stats {
    bytes: u64,
    files: u64,
    newest_ms: u128,
    newest_name: String,
}

/// 递归统计。★ 0920 起这是**性能关键路径**（见 `DirSampler` 的注释），三条都别改回去：
///   · 用 `file_type()` 判目录 —— Windows 下它直接来自目录项，**不再多付一次 stat**；
///   · 只有**文件**才取 `metadata()`（要 size / mtime）；
///   · 相对路径字符串**只在真的刷新"最新文件"时才拼** —— 旧实现给每个文件都 `format!` 一次，
///     17000 个文件就是 17000 次堆分配，而这个函数一度每秒要跑好几遍。
fn walk(p: &Path, s: &mut Stats, rel: &str) {
    let rd = match std::fs::read_dir(p) {
        Ok(r) => r,
        Err(_) => return,
    };
    for e in rd.flatten() {
        let ft = match e.file_type() {
            Ok(f) => f,
            Err(_) => continue,
        };
        if ft.is_dir() {
            let name = e.file_name().to_string_lossy().to_string();
            let child_rel = if rel.is_empty() { name } else { format!("{}\\{}", rel, name) };
            walk(&e.path(), s, &child_rel);
            continue;
        }
        let meta = match e.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        s.bytes += meta.len();
        s.files += 1;
        let t = meta
            .modified()
            .ok()
            .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis())
            .unwrap_or(0);
        if t >= s.newest_ms {
            s.newest_ms = t;
            let name = e.file_name().to_string_lossy().to_string();
            s.newest_name = if rel.is_empty() { name } else { format!("{}\\{}", rel, name) };
        }
    }
}

fn dir_stats(p: &Path) -> Stats {
    let mut s = Stats::default();
    walk(p, &mut s, "");
    s
}

/// 目录「有效剩余体积」：扣掉自绘卸载器自己。
/// 官方 uninstall.exe 不认识 NIS-Uninstall.exe，卸载完会把它留下 ——
/// 若把它算进剩余量，卸载进度永远到不了 100%、还会空等到超时。
fn leftover_bytes(root: &Path, s: &Stats) -> u64 {
    let own = std::fs::metadata(root.join("NIS-Uninstall.exe"))
        .map(|m| m.len())
        .unwrap_or(0);
    s.bytes.saturating_sub(own)
}

/// ★ 目录采样器（0920，修老大反馈的「安装时 CPU 跑满、而且很慢」）。
///
/// **背景**：进度条靠「目标目录真实体积 / 文件数」驱动，而 `dir_stats()` 是**整棵树递归 + 逐条 stat**。
/// 旧写法在安装循环里每 500ms、在卸载循环里每 150ms（**连节流都没有**）就从零走一遍 ——
/// 而末期目标目录有 **17000+ 个文件**（`backend/node_modules` 一家就占 1.6 万），
/// 于是**我们自己的进度轮询**每秒要发 4 万次上下的 stat；每个 stat 还要过一遍机器上的
/// 文件系统过滤驱动（腾讯管家 / 阿里 / 拼多多那几个各挂一层），
/// 折算下来比安装器真正写盘的开销**高一个数量级** —— 进度条成了瓶颈，所谓"CPU 跑满"主要就是它。
///
/// 所以做三件事：
///   ① 遍历挪到**独立线程**：主循环只读快照 —— 不再被遍历阻塞，取消与退出码检测都更灵敏；
///   ② 采样间隔**随已耗时长**（600ms → 封顶 2.5s）：越到后期树越大、越贵，就采得越稀；
///   ③ 同一时刻只有**一次**遍历在跑（旧卸载循环 150ms 一轮，遍历稍慢就会反复重入）。
struct DirSampler {
    latest: Arc<Mutex<Option<Stats>>>,
    stop: Arc<AtomicBool>,
}

impl DirSampler {
    fn start(root: PathBuf) -> Self {
        let latest: Arc<Mutex<Option<Stats>>> = Arc::new(Mutex::new(None));
        let stop = Arc::new(AtomicBool::new(false));
        let started = Instant::now();
        {
            let latest = Arc::clone(&latest);
            let stop = Arc::clone(&stop);
            std::thread::spawn(move || {
                while !stop.load(Ordering::SeqCst) {
                    let s = dir_stats(&root);
                    if let Ok(mut g) = latest.lock() {
                        *g = Some(s);
                    }
                    let el = started.elapsed().as_millis();
                    let iv = (600u128 + el / 25).clamp(600, 2500) as u64;
                    std::thread::sleep(Duration::from_millis(iv));
                }
            });
        }
        Self { latest, stop }
    }

    /// 最近一次快照；首次采样还没回来时返回 `None`（调用方跳过这一帧即可）
    fn snapshot(&self) -> Option<Stats> {
        self.latest.lock().ok().and_then(|g| g.clone())
    }
}

impl Drop for DirSampler {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

// ────────────────────────────── 事件 ──────────────────────────────

#[derive(Clone, Serialize)]
struct Progress {
    pct: f64,
    file: String,
    phase: String, // run | finish | done
}

fn emit(app: &AppHandle, pct: f64, file: &str, phase: &str) {
    let _ = app.emit(
        "setup:progress",
        Progress { pct, file: file.to_string(), phase: phase.to_string() },
    );
}

fn emit_err(app: &AppHandle, msg: &str) {
    log(&format!("[error] {}", msg));
    let _ = app.emit("setup:error", msg.to_string());
}

/// 进度单调器（0919 修老大反馈的「先到 1 又退回 0 重新读条」；0922z3 又砍掉"造假爬"）：
/// · **只增不减**：两个流程开头都硬写了 `emit(1.0)`，而第一次真实采样几乎必然算出 ≈0%
///   （install 按"目标目录体积"、uninstall 按 `1 - 剩余/总`）→ 进度条当场倒退，
///   看起来就是"重新开始读条"。采样本身也会因目录暂时读不到而变小，同样要挡掉。
/// · **不再"长时间不动就慢慢爬"**（★ 0922z3 老大反馈「安装进度造假（解压完还在刷）」）：
///   原来"停滞 2.5s 就按剩余量的 3% 渐近逼近 cap-2"会**凭空**把进度往前推 ——
///   而停滞往往是"解压其实已经结束、NSIS 在收尾（快捷方式/注册表）"，于是条一直往上爬 = 造假。
///   现在：解压真停了就**原地不动**（停播报），平滑靠 60% 字节 + 40% 文件数加权，不再编数字。
struct ProgressMonotone {
    shown: f64,
}

impl ProgressMonotone {
    fn new(start: f64) -> Self {
        Self { shown: start }
    }
    /// 只增不减地推进到 `raw`（上限 `cap`）
    fn next(&mut self, raw: f64, cap: f64) -> f64 {
        let v = raw.max(self.shown).min(cap);
        if v > self.shown {
            self.shown = v;
        }
        self.shown
    }
}

// ────────────────────────────── 命令 ──────────────────────────────

/// ⚠️ 必须 camelCase：前端按 `installRoot` / `defaultDir` / `totalBytes` / `mainBinary` 读。
/// 0915 踩过一次：字段是 Rust snake_case，序列化后前端全读成 undefined →
/// 卸载界面 `CHOSEN_DIR` 恒为空串 → `Command::new("uninstall.exe")` 相对路径 →
/// 「文件名、目录名或卷标语法不正确 (os error 123)」，卸载直接卡死。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupInfo {
    mode: String,
    product: String,
    version: String,
    default_dir: String,
    install_root: String,
    total_bytes: u64,
    file_count: u64,
    main_binary: String,
    has_payload: bool,
    bundled: bool,
}

#[tauri::command]
fn setup_info(state: State<'_, AppState>) -> SetupInfo {
    let exe = exe_path();
    let ft = payload::read_footer(&exe);
    let manifest: Manifest = ft
        .as_ref()
        .and_then(|f| payload::read_manifest(&exe, f).ok())
        .unwrap_or_default();
    let mode = state.mode.lock().map(|m| m.clone()).unwrap_or_else(|_| "install".into());
    let root = if mode == "uninstall" {
        resolve_uninstall_root().display().to_string()
    } else {
        String::new()
    };
    // 界面 ↔ Rust 桥的存活心跳：能落这条日志，说明 IPC / 前端资源 / 窗口都正常。
    // install_root 一并记下来：它为空是「卸载卡死 os error 123」的直接元凶（字段命名不一致），
    // 值得每次都能一眼看到。
    log(&format!(
        "[ui] setup_info 往返成功 mode={} has_payload={} files={} bytes={} install_root={:?}",
        mode,
        ft.is_some(),
        manifest.file_count,
        manifest.total_bytes,
        root
    ));
    /* 0918 修复「卸载器标题栏版本号不对（显示 v0.0.1）」：
     *  ★ 根因：**卸载模式跑的是安装目录里的 `NIS-Uninstall.exe`** —— 它就是本壳的
     *    "无载荷版"（footer 已被截掉），于是 `read_footer` / `read_manifest` 必然失败 →
     *    `manifest` 落回 `Default`（version = ""）→ 界面回落到前端硬编码的 `'0.0.1'`。
     *  ★ 修法：加**编译期兜底** —— 壳自己的 Cargo 版本由 `_bump_version.mjs` 与
     *    `tauri.conf.json` 一起同步（见 backend/_bump_version.mjs 的 ⑤），
     *    所以卸载器一定会显示"它自己这一版"的正确版本号，且永不再漂移。 */
    let version = if manifest.version.trim().is_empty() {
        env!("CARGO_PKG_VERSION").to_string()
    } else {
        manifest.version.clone()
    };
    SetupInfo {
        mode,
        product: if manifest.product.is_empty() { PRODUCT.to_string() } else { manifest.product.clone() },
        version,
        default_dir: default_install_dir().display().to_string(),
        install_root: root,
        total_bytes: manifest.total_bytes,
        file_count: manifest.file_count,
        main_binary: if manifest.main_binary.is_empty() { "NIS.exe".into() } else { manifest.main_binary.clone() },
        has_payload: ft.is_some(),
        bundled: ft.is_some(),
    }
}

#[tauri::command]
fn pick_dir(app: AppHandle, current: String) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let mut dlg = app.dialog().file();
    if !current.trim().is_empty() && Path::new(&current).exists() {
        dlg = dlg.set_directory(current);
    }
    dlg.blocking_pick_folder()
        .and_then(|p| p.simplified().into_path().ok())
        .map(|p| ensure_nis_subdir(&p).display().to_string())
}

/// 用户选的是**父目录**，实际装到它下面的 `NIS` 子目录 —— 别把程序文件直接摊在用户选的目录里。
/// （0919 老大实测反馈"选完目录没自动加 NIS 子目录"，之前也确实没加：DEFAULT_DIR_NAME 只作用于**默认**路径。）
/// 选中的已经是 `…\NIS` 这一层（升级/重装最常见）→ 原样用它，不再套一层。
fn ensure_nis_subdir(p: &Path) -> PathBuf {
    let last = p
        .file_name()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if last == DEFAULT_DIR_NAME.to_ascii_lowercase() {
        p.to_path_buf()
    } else {
        p.join(DEFAULT_DIR_NAME)
    }
}

#[tauri::command]
fn begin_install(app: AppHandle, state: State<'_, AppState>, dir: String, run_after: bool) -> Result<(), String> {
    if state.busy.swap(true, Ordering::SeqCst) {
        return Err("正在安装中".into());
    }
    state.cancel.store(false, Ordering::SeqCst);
    let app2 = app.clone();
    std::thread::spawn(move || {
        let res = do_install(&app2, &dir, run_after);
        if let Err(e) = res {
            emit_err(&app2, &e);
        }
        if let Some(st) = app2.try_state::<AppState>() {
            st.busy.store(false, Ordering::SeqCst);
        }
    });
    Ok(())
}

#[tauri::command]
fn begin_uninstall(app: AppHandle, state: State<'_, AppState>, root: String, delete_data: bool) -> Result<(), String> {
    if state.busy.swap(true, Ordering::SeqCst) {
        return Err("正在卸载中".into());
    }
    state.cancel.store(false, Ordering::SeqCst);
    state.delete_data.store(delete_data, Ordering::SeqCst);
    let app2 = app.clone();
    std::thread::spawn(move || {
        let res = do_uninstall(&app2, &root, delete_data);
        if let Err(e) = res {
            emit_err(&app2, &e);
        }
        if let Some(st) = app2.try_state::<AppState>() {
            st.busy.store(false, Ordering::SeqCst);
        }
    });
    Ok(())
}

#[tauri::command]
fn cancel(state: State<'_, AppState>) {
    state.cancel.store(true, Ordering::SeqCst);
    if let Ok(mut g) = state.child.lock() {
        if let Some(c) = g.as_mut() {
            let _ = c.kill();
        }
    }
}

#[tauri::command]
fn launch_app(dir: String, main_binary: String) {
    let exe = PathBuf::from(dir).join(if main_binary.is_empty() { "NIS.exe".to_string() } else { main_binary });
    let _ = Command::new(exe).spawn();
}

#[tauri::command]
fn win_minimize(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.minimize();
    }
}

#[tauri::command]
fn win_close(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.close();
    }
}

// ────────────────────────────── 安装 ──────────────────────────────

fn do_install(app: &AppHandle, dir: &str, run_after: bool) -> Result<(), String> {
    let exe = exe_path();
    let ft = payload::read_footer(&exe)
        .ok_or_else(|| "安装器载荷缺失：setup.exe 不完整（缺少内置引擎）".to_string())?;
    let mf = payload::read_manifest(&exe, &ft).unwrap_or_default();
    let target = PathBuf::from(dir);
    if dir.trim().is_empty() {
        return Err("安装目录为空".into());
    }

    /* ★ 0919（老大要求）：选完目录**当场验可写**，写不进去就直接拦下 ——
     * 安装版的数据（data / skills / memory / config.json）都放在安装目录里，
     * 装到 `C:\Program Files` 这类位置会出现"装的时候有管理员权限能写、装完以普通用户跑就写不进去"。
     * 与其装完了悄悄回退到隐藏目录（老大明确不要这种），不如当场说清楚、让他换个地方。 */
    if let Err(e) = probe_dir_writable(&target) {
        return Err(format!(
            "这个位置装不了：{}（{}）。请换到 D 盘或默认位置（本地应用数据目录下的 Programs\\NIS）。",
            target.display(),
            e
        ));
    }

    log(&format!("[install] target={} version={}", target.display(), mf.version));
    emit(app, 1.0, "", "run");
    // ★1010：进目标目录前先清扫历史待删目录（上轮卸载改名的残留）
    sweep_deleting_dirs(&target);

    // ① 抽出内嵌引擎
    let engine = payload::extract_engine(&exe, &ft)?;
    log(&format!("[install] engine={}", engine.display()));

    // ② 建目录
    std::fs::create_dir_all(&target).map_err(|e| format!("创建安装目录失败：{}", e))?;

    // ③ 静默驱动引擎（/D= 必须是最后一个参数且不加引号 —— 用 raw_arg 绕开自动加引号）
    let mut cmd = Command::new(&engine);
    cmd.arg("/S");
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.raw_arg(format!("/D={}", target.display()));
    }
    let child = cmd.spawn().map_err(|e| format!("无法启动安装引擎：{}", e))?;
    let pid = child.id();
    log(&format!("[install] engine pid={}", pid));
    if let Some(st) = app.try_state::<AppState>() {
        if let Ok(mut g) = st.child.lock() {
            *g = Some(child);
        }
    }

    // ④ 进度：用目标目录真实体积驱动
    //   ★ 采样交给**独立线程**（DirSampler）—— 旧写法每 500ms 同步整树遍历，反而把安装本身拖慢了
    let total = if mf.total_bytes > 0 { mf.total_bytes } else { 1 };
    let sampler = DirSampler::start(target.clone());
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    let mut exit_code: Option<i32> = None;
    let mut prog = ProgressMonotone::new(1.0);
    // ★ 0922z3：判"解压是不是已经停了"用 —— 上一次采样的字节/文件数 + 最后一次有变化的时间
    let mut last_bytes: u64 = 0;
    let mut last_files: u64 = 0;
    let mut last_change = Instant::now();
    loop {
        if app.state::<AppState>().cancel.load(Ordering::SeqCst) {
            return Err("已取消安装".into());
        }
        {
            let st = app.state::<AppState>();
            let mut g = st.child.lock().map_err(|_| "状态锁失败".to_string())?;
            match g.as_mut() {
                Some(c) => match c.try_wait() {
                    Ok(Some(s)) => {
                        exit_code = s.code();
                        *g = None;
                        break;
                    }
                    Ok(None) => {}
                    Err(_) => break,
                },
                None => break,
            }
        }
        if last_emit.elapsed() > Duration::from_millis(500) {
            // ★ 只读背景线程的快照，**不再**自己整树遍历（见 DirSampler 注释）
            let s = match sampler.snapshot() {
                Some(s) => s,
                None => {
                    std::thread::sleep(Duration::from_millis(120));
                    continue;
                }
            };
            /* 进度 = 「已写字节」与「已落文件数」加权（0919 修"卡在 85%"）：
             * 只按字节算时，安装末段全是几十万个**小文件**（backend/node_modules/dist 资源），
             * 字节数几乎不动 → 进度条就"卡住"了（老大实测反馈）。文件数比例是稳的，加权后平滑。
             * 两个分量都是单调递增的，所以加权结果也单调，不会来回跳。 */
            let by_bytes = if total > 0 { s.bytes as f64 / total as f64 } else { 0.0 };
            let by_files = if mf.file_count > 0 { s.files as f64 / mf.file_count as f64 } else { by_bytes };
            let ratio = (by_bytes * 0.6 + by_files * 0.4).min(1.0);

            /* ★ 0922z3（老大：「安装进度造假（解压完还在刷）」）—— 解压停了就停播报：
             * 进度停在「解压完成」那一格，ticker 也不再一行行刷"解压 xxx"。
             * 两个判据取稳的（清单来自打包期 manifest，最可靠）：
             *   ① 落盘到齐：字节与文件数都 ≥ 清单的 99.9%；
             *   ② 真停滞：字节与文件数连续 2.5s 一模一样（杀毒扫描/大文件落盘会出现 —— 此时也只许停，不许编）。 */
            if s.bytes != last_bytes || s.files != last_files {
                last_bytes = s.bytes;
                last_files = s.files;
                last_change = Instant::now();
            }
            let counts_arrived =
                mf.total_bytes > 0 && mf.file_count > 0 && by_bytes >= 0.999 && by_files >= 0.999;
            let stalled = last_change.elapsed() >= Duration::from_millis(2500);
            let extraction_over = counts_arrived || stalled;
            let pct = if counts_arrived {
                prog.next(92.0, 92.0)
            } else if stalled {
                let held = prog.shown;
                prog.next(held, 92.0)
            } else {
                prog.next(ratio * 92.0, 92.0)
            };
            // 解压结束后**不再发文件名**（空串 → 前端不追加"解压 xxx"行）
            let tick = if extraction_over { "" } else { s.newest_name.as_str() };
            emit(app, pct, tick, "run");
            last_emit = Instant::now();
        }
        std::thread::sleep(Duration::from_millis(120));
    }

    let main_binary = if mf.main_binary.is_empty() { "NIS.exe".to_string() } else { mf.main_binary.clone() };
    if !target.join(&main_binary).exists() {
        let _ = std::fs::remove_file(&engine);
        return Err(format!(
            "安装引擎未完成（退出码 {:?}）。请确认磁盘空间与杀毒软件拦截，或改用其它目录后重试。",
            exit_code
        ));
    }

    // ⑤ 收尾：落地自绘卸载器 + 改写「应用和功能」里的卸载入口
    emit(app, 94.0, "", "finish");
    let un = target.join("NIS-Uninstall.exe");
    payload::write_shell(&exe, &ft, &un)?;
    // ★1010：引擎自带的 uninstall.exe 藏起来（自制壳仍会用绝对路径调它干活）
    hide_file(&target.join("uninstall.exe"));
    if let Err(e) = rewrite_uninstall_entry(&un) {
        log(&format!("[install] 卸载入口改写失败（不致命）：{}", e));
    }
    // 全新空装：把沿用的「开发数据目录」配置备份并重置（原始数据不动）
    reset_dev_config_if_needed();
    let _ = std::fs::remove_file(&engine);

    emit(app, 100.0, "", "done");
    log("[install] done");
    if run_after {
        let _ = Command::new(target.join(&main_binary)).spawn();
    }
    Ok(())
}

/// ★1010：把引擎自带的 `uninstall.exe` 设为**隐藏** —— 用户只需看到一个卸载入口（`NIS-Uninstall.exe`，
/// 注册表 `UninstallString` 已指向它）。隐藏不影响它被调用：自制壳是用绝对路径 spawn 它的。
fn hide_file(p: &Path) {
    if !p.exists() {
        return;
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut c = Command::new("cmd");
        c.raw_arg("/C").raw_arg(format!("attrib +h \"{}\"", p.display()));
        c.creation_flags(CREATE_NO_WINDOW);
        match c.output() {
            Ok(_) => log(&format!("[install] 已隐藏引擎卸载器 {}", p.display())),
            Err(e) => log(&format!("[install] 隐藏失败（不影响功能）：{}", e)),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = p;
    }
}

/// 把「应用和功能」的卸载入口指到自绘卸载器（NSIS 原本写的是它自带的 uninstall.exe）
fn rewrite_uninstall_entry(un: &Path) -> Result<(), String> {
    let key = format!(
        r"Software\Microsoft\Windows\CurrentVersion\Uninstall\{}",
        PRODUCT
    );
    let normal = format!("\"{}\" --uninstall", un.display());
    let quiet = format!("\"{}\" --uninstall --quiet", un.display());
    let icon = format!("\"{}\"", un.with_file_name("NIS.exe").display());
    #[cfg(windows)]
    {
        reg::set_hkcu_string(&key, "UninstallString", &normal)?;
        reg::set_hkcu_string(&key, "QuietUninstallString", &quiet)?;
        let _ = reg::set_hkcu_string(&key, "DisplayIcon", &icon);
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (key, normal, quiet, icon);
        Err("仅支持 Windows".into())
    }
}

// ────────────────────────────── 卸载 ──────────────────────────────

/// 卸载目标目录解析（0915 加固）：候选依次「前端传入 → NIS_UNINST_ROOT → 自身 exe 所在目录」，
/// 优先取「真实存在且里面有 NIS-Uninstall.exe」的那个；都不合格再退回第一个存在的目录。
/// 起因：用户实测卸载报「无法启动卸载程序 os error 123」，路径一旦解析歪就直接中断。
fn resolve_root_checked(hint: &str) -> PathBuf {
    let mut cands: Vec<PathBuf> = Vec::new();
    if !hint.trim().is_empty() {
        cands.push(PathBuf::from(hint));
    }
    let env_root = resolve_uninstall_root();
    if !env_root.as_os_str().is_empty() {
        cands.push(env_root);
    }
    if let Some(p) = exe_path().parent() {
        cands.push(p.to_path_buf());
    }
    for c in &cands {
        if c.is_dir() && c.join("NIS-Uninstall.exe").exists() {
            return c.clone();
        }
    }
    for c in &cands {
        if c.is_dir() {
            return c.clone();
        }
    }
    cands.into_iter().next().unwrap_or_default()
}

/// 自实现清理（引擎卸载器起不来时的兜底）：安装目录 + 快捷方式 + 运行期缓存 + 注册表
/// 0918 重做：改为与 `cleanup_after_uninstall` 共用同一套工具，两条路径行为一致
fn manual_cleanup(root: &Path) {
    if root.is_dir() {
        if looks_like_nis_install(root) {
            clean_install_dir(root);
        } else {
            log("[cleanup] manual：目录不像 NIS 安装目录，跳过目录清理");
        }
    }
    remove_shortcuts();
    for d in cache_dirs() {
        rm_dir_safe(&d, "运行期缓存");
    }
    #[cfg(windows)]
    {
        let _ = reg::delete_key_hkcu(&format!(
            r"Software\Microsoft\Windows\CurrentVersion\Uninstall\{}",
            PRODUCT
        ));
        // 厂商键（它的默认值就是「上次安装位置」，留着会让下次重装跳回老目录）
        let _ = reg::delete_key_hkcu(&format!(r"Software\nis\{}", PRODUCT));
    }
}

/// 「全新空装」保障（0915 用户要求：下次打包直接给一个全新的空 NIS）：
/// 若现有 `%APPDATA%\nis\config.json` 指向开发目录（路径含 nis0812），说明这是沿用开发数据的旧配置。
/// 处理：先原样备份成 `config.dev-backup.json`，再写一份不带 dataDir/skillsDir 的干净配置
/// —— 安装版随即落到自己的默认空数据目录（%APPDATA%\nis\data）。
/// **原始数据一个字节都不动**（用户已归档到 D:\nis-user-data）。
fn reset_dev_config_if_needed() {
    let base = app_base_dir();
    let cfg = base.join("config.json");
    let Ok(txt) = std::fs::read_to_string(&cfg) else { return };
    if !txt.contains("nis0812") {
        return;
    }
    let backup = base.join("config.dev-backup.json");
    if let Err(e) = std::fs::copy(&cfg, &backup) {
        log(&format!("[install] 备份开发配置失败（跳过重置）：{}", e));
        return;
    }
    let fresh = serde_json::json!({
        "_note": "安装版使用全新空数据目录。原开发数据配置已备份为 config.dev-backup.json；数据本体已归档到 D:\\nis-user-data"
    });
    match serde_json::to_string_pretty(&fresh) {
        Ok(t) => {
            let _ = std::fs::create_dir_all(&base);
            match std::fs::write(&cfg, t) {
                Ok(()) => log("[install] 检测到开发数据配置 → 已备份为 config.dev-backup.json 并重置为空目录"),
                Err(e) => log(&format!("[install] 重置配置失败：{}", e)),
            }
        }
        Err(e) => log(&format!("[install] 生成新配置失败：{}", e)),
    }
}

fn do_uninstall(app: &AppHandle, root_hint: &str, delete_data: bool) -> Result<(), String> {
    let root = resolve_root_checked(root_hint);
    log(&format!(
        "[uninstall] hint={:?} resolved={:?} is_dir={}",
        root_hint,
        root.display(),
        root.is_dir()
    ));
    // 先结束正在运行的 NIS：它锁着 `NIS.exe` / `pack\node.exe` / sqlite 库，
    // 不杀就会出现「删不掉的安装目录残骸」（用户反馈的残留主因）
    kill_running_app(&root);
    emit(app, 1.0, "", "run");
    sweep_deleting_dirs(&root);
    if !root.is_dir() {
        // 目录都不在了：只剩清尾（快捷方式/注册表/可选数据）
        manual_cleanup(&root);
        cleanup_after_uninstall(&root, delete_data);
        emit(app, 100.0, "", "done");
        schedule_self_delete();
        return Ok(());
    }

    let before = dir_stats(&root);
    let total = leftover_bytes(&root, &before).max(1);
    /* ★1010：卸载进度此前**只按字节**算，而安装侧是"60% 字节 + 40% 文件数"——
       本机删除单个文件要 ~200ms（内核过滤驱动收税，见 fast_rm 注释），耗时几乎正比于**文件数**：
       删到 `pack\backend\node_modules` 那种"一堆小文件"时字节数几乎不动 ⇒ 进度条假死
       （老大实测原话："卡在 45% 很久，然后很快完成"）。
       这里补齐文件数基线，进度改成与安装侧同口径、且以文件数为主（卸载的耗时由文件数决定）。 */
    let own_files = std::fs::metadata(root.join("NIS-Uninstall.exe")).map(|_| 1u64).unwrap_or(0);
    let total_files = before.files.saturating_sub(own_files).max(1);

    /* ★1010：**先把大目录改名，再启动引擎卸载器**。
       为什么：引擎卸载器逐个文件真删（本机单文件 ~200ms；pack/ 一家上万文件 ⇒ 分钟级卡顿），
       而同盘改名是**瞬时**的 —— 改名后引擎遍历自己的文件清单时全部"已不存在"，
       秒级跑完（它的注册表/快捷方式清理职责照旧），真正的删除交给后台 detached `rd /s /q`。
       ⇒ 界面上的"移除程序文件"从"分钟级卡顿"变成"瞬间过"；改名的残留由 sweep_deleting_dirs 兜底清扫。 */
    for name in ["pack", "dist", "logs"] {
        let p = root.join(name);
        if p.is_dir() {
            fast_rm(&p, "安装目录大目录（预改名）");
        }
    }

    let un = root.join("uninstall.exe");
    log(&format!("[uninstall] engine={:?} exists={}", un.display(), un.exists()));

    // 启动引擎卸载器；**起不来就自己清**（此前直接报错中断 → 卸载整个卡死）。
    // 不设 current_dir：那是曾引发 os error 123 的多余失败点，卸载器按自身 exe 位置工作。
    let mut spawned: Option<Child> = None;
    if un.exists() {
        let mut cmd = Command::new(&un);
        cmd.arg("/S");
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        match cmd.spawn() {
            Ok(c) => spawned = Some(c),
            Err(e) => log(&format!("[uninstall] 引擎卸载器启动失败：{} → 转自实现清理", e)),
        }
    } else {
        log("[uninstall] 未找到引擎卸载器 → 自实现清理");
    }

    if let Some(child) = spawned {
        if let Some(st) = app.try_state::<AppState>() {
            if let Ok(mut g) = st.child.lock() {
                *g = Some(child);
            }
        }
        // NSIS 卸载器会自我复制到 %TEMP% 后立刻退出 → 不能只等子进程，
        // 还要盯住目录体积直到它真的被清空（或超时）。
        let started = Instant::now();
        let mut last_emit = Instant::now() - Duration::from_secs(1);
        let mut prog = ProgressMonotone::new(1.0);
        // ★ 卸载同样走背景采样：旧写法 150ms 一轮**同步整树遍历且完全没有节流**，
        //   是"卸载时 CPU 跑满"的另一半原因（见 DirSampler 注释）。
        let sampler = DirSampler::start(root.clone());
        loop {
            if app.state::<AppState>().cancel.load(Ordering::SeqCst) {
                return Err("已取消卸载".into());
            }
            {
                let st = app.state::<AppState>();
                let mut g = st.child.lock().map_err(|_| "状态锁失败".to_string())?;
                if let Some(c) = g.as_mut() {
                    if let Ok(Some(_)) = c.try_wait() {
                        *g = None;
                    }
                }
            }
            let s = match sampler.snapshot() {
                Some(s) => s,
                None => {
                    std::thread::sleep(Duration::from_millis(150));
                    continue;
                }
            };
            let eff = leftover_bytes(&root, &s);
            let eff_files = s.files.saturating_sub(own_files);
            let by_bytes = 1.0 - (eff as f64 / total as f64).min(1.0);
            let by_files = 1.0 - (eff_files as f64 / total_files as f64).min(1.0);
            let done_ratio = (by_bytes * 0.4 + by_files * 0.6).clamp(0.0, 1.0);
            if last_emit.elapsed() > Duration::from_millis(400) {
                emit(app, prog.next(done_ratio * 92.0, 92.0), &s.newest_name, "run");
                last_emit = Instant::now();
            }
            let gone = !root.exists() || eff == 0;
            if gone {
                break;
            }
            if started.elapsed() > Duration::from_secs(180) {
                log("[uninstall] 等待目录清空超时，转手动清理");
                break;
            }
            std::thread::sleep(Duration::from_millis(150));
        }
    }

    emit(app, 95.0, "", "finish");
    // 兜底清尾：引擎没干完（或压根没起来）的部分，由我们自己收拾干净
    manual_cleanup(&root);
    cleanup_after_uninstall(&root, delete_data);
    emit(app, 100.0, "", "done");
    log(&format!("[uninstall] done, root_exists={}", root.exists()));
    schedule_self_delete();
    Ok(())
}

/// 递归清掉空目录（引擎卸载器删完文件会留下 pack/ 这类空壳，
/// 只判断「根目录是否为空」不足以收尾 —— 实测卸载后只剩一个空 pack/）
fn remove_empty_dirs(dir: &Path) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            remove_empty_dirs(&p);
            let _ = std::fs::remove_dir(&p); // 非空会失败，忽略
        }
    }
}

fn cleanup_after_uninstall(root: &Path, delete_data: bool) {
    log(&format!("[cleanup] root={} exists={}", root.display(), root.exists()));

    // ── ① 安装目录：**整目录删** ──
    // 为什么不能只靠引擎卸载器：它只删自己登记过的文件，运行期产生的东西
    // （`*.bak-*` / `.nis-history` / 日志）会被留下；只要根目录非空，「卸载残留」就出现了
    // —— 旧实现还刻意保守地留着非空目录，等于是把残留钉在那儿。
    if root.exists() {
        if looks_like_nis_install(root) {
            clean_install_dir(root);
        } else {
            log("[cleanup] 目录不像 NIS 安装目录 → 只收敛空目录（保守收手）");
            remove_empty_dirs(root);
            if std::fs::read_dir(root).map(|rd| rd.count() == 0).unwrap_or(false) {
                let _ = std::fs::remove_dir(root);
            }
        }
    }
    log(&format!("[cleanup] 安装目录 root_exists={}", root.exists()));

    // ── ①b 默认安装位置的历史残留（老版本可能装在那儿，本次卸载不会走到它）──
    let def = default_install_dir();
    if def != root && def.exists() && looks_like_nis_install(&def) {
        fast_rm(&def, "默认安装位置的历史残留");
    }

    // ── ② 快捷方式（开始菜单 + 桌面）──
    remove_shortcuts();

    // ── ③ 运行期缓存：WebView2 档案（~70MB / 上万文件）—— 纯缓存，无论是否勾「删除数据」都清。
    //      ★ 用 fast_rm：这一步就是老大反馈"卡很久"的那步（每个文件 ~200ms × 上万文件）。
    for d in cache_dirs() {
        fast_rm(&d, "运行期缓存");
    }

    // ── ④ 注册表（currentUser 安装 → 只有 HKCU）──
    #[cfg(windows)]
    {
        let _ = reg::delete_key_hkcu(&format!(
            r"Software\Microsoft\Windows\CurrentVersion\Uninstall\{}",
            PRODUCT
        ));
        let _ = reg::delete_key_hkcu(&format!(r"Software\nis\{}", PRODUCT));
    }

    // ── ⑤ 数据目录：用户资料，勾了才删；没勾就只收空壳 ──
    cleanup_data_dir(delete_data);

    /* ── ⑤b 安装目录里的**用户数据**（0919 起 data / skills / memory 都搬进安装目录了）──
     * ⚠️ 这三样不在 OWNED_TOP 名单里（那份名单是"无条件删"的），所以这里单独判：
     *   勾了「删除用户数据」→ 删掉（对话/设置/技能/记忆库/知识库，用户要的就是干净）；
     *   没勾 → **原地留着** —— 卸载程序不等于毁数据；那时安装目录可能只剩这几个文件夹，
     *          这是有意的（要彻底干净就勾上"删除用户数据"）。
     * 用 fast_rm：`data/` 里可能装着 env/（记忆检索模型的 venv，上万文件）。 */
    let mem = root.join("memory");
    let data = root.join("data");
    let skills = root.join("skills");
    if delete_data {
        /* 0920：`data\` 里的**产出物(exports)** 与**对话工作区(storage)** 也一起删
           （老大口径：这两样可以自己导出，卸载时删掉没关系）。 */
        for (p, what) in [
            (&data, "安装目录内的数据（含产出物 exports\\ 与工作区 storage\\）"),
            (&skills, "安装目录内的技能"),
            (&mem, "安装目录内的记忆/知识库"),
        ] {
            if p.exists() {
                fast_rm(p, what);
            }
        }
    } else {
        for (p, what) in [(&data, "data"), (&skills, "skills"), (&mem, "memory")] {
            if p.exists() {
                log(&format!("[cleanup] 保留安装目录内的 {}\\（未勾选「删除数据」）", what));
            }
        }
    }

    log("[cleanup] 完成");
}

/// 把自己（含载荷也行）复制到 %TEMP% 再重启 —— 否则卸载器删不掉正在运行的自己。
/// ⚠️ 必须**原样转发** quiet / delete-data 之类的开关：曾经漏传 `--quiet`，
/// 结果静默卸载会弹出自绘界面等用户点，看起来像"卸载没反应"。
fn relocate_to_temp(quiet: bool, delete_data: bool) -> Result<(), String> {
    let exe = exe_path();
    let dir = std::env::temp_dir().join("nis-setup");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dst = dir.join(format!("uninst-{}.exe", std::process::id()));
    std::fs::copy(&exe, &dst).map_err(|e| format!("复制卸载器到临时目录失败：{}", e))?;
    let root = exe.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let mut cmd = Command::new(&dst);
    cmd.arg("--uninstall");
    if quiet {
        cmd.arg("--quiet");
    }
    if delete_data {
        cmd.arg("--delete-data");
    }
    cmd.env("NIS_UNINST_TEMP", "1");
    cmd.env("NIS_UNINST_ROOT", root.display().to_string());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.spawn().map_err(|e| format!("重启卸载器失败：{}", e))?;
    Ok(())
}

/// 卸载收尾：等本进程退出后（Windows 下删不掉正在运行的自己）
///   ① 删掉 `%TEMP%` 里的临时副本  ② 清掉整个 `%TEMP%\nis-setup`（含设置器日志）
/// 顺序不能反：先 del 自己、再 rd 目录，否则「先删目录、后删自己」会剩下一个空目录
fn schedule_self_delete() {
    let me = exe_path();
    let relocated = std::env::var("NIS_UNINST_TEMP").is_ok();
    let tmpdir = std::env::temp_dir().join("nis-setup");
    let mut line = String::from("ping -n 4 127.0.0.1 >nul");
    if relocated {
        line.push_str(&format!(" & del /F /Q \"{}\"", me.display()));
    }
    line.push_str(&format!(" & rd /S /Q \"{}\"", tmpdir.display()));
    let mut c = Command::new("cmd");
    c.arg("/C");
    #[cfg(windows)]
    {
        c.creation_flags(CREATE_NO_WINDOW);
        c.raw_arg(line);
    }
    #[cfg(not(windows))]
    {
        c.arg(line);
    }
    let _ = c.spawn();
}

/// 等安装目录真正排空。
/// 必须这么做：NSIS 卸载器会把自己复制到 %TEMP% 后**立刻返回**，父进程 status() 拿到的是
/// "启动成功"而不是"删完了" —— 抢在它前面 cleanup 只会看到还没删掉的文件（实测踩过）。
fn wait_until_gone(root: &Path, timeout: Duration) -> bool {
    let started = Instant::now();
    // ★ 退避轮询：这条路径也可能对着 1.7 万文件的树连打 stat，起步 250ms、逐轮翻倍封顶 1.5s
    let mut iv = 250u64;
    loop {
        if !root.exists() {
            return true;
        }
        let s = dir_stats(root);
        if leftover_bytes(root, &s) == 0 {
            return true;
        }
        if started.elapsed() > timeout {
            return false;
        }
        std::thread::sleep(Duration::from_millis(iv));
        iv = (iv * 2).min(1500);
    }
}

fn run_quiet_uninstall(delete_data: bool) {
    let root = resolve_root_checked("");
    log(&format!("[quiet] root={}", root.display()));
    kill_running_app(&root);
    let un = root.join("uninstall.exe");
    let mut done = false;
    if un.exists() {
        let mut cmd = Command::new(&un);
        cmd.arg("/S");
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        if let Ok(st) = cmd.status() {
            done = st.success();
        }
    }
    if done {
        // 等它把文件真删完再收尾（否则看到的是"还没删掉"的中间态）
        let gone = wait_until_gone(&root, Duration::from_secs(180));
        log(&format!("[quiet] 目录排空={}", gone));
        if !gone {
            log("[quiet] 超时，转自实现清理");
            manual_cleanup(&root);
        }
    } else {
        log("[quiet] 引擎卸载器未成功 → 自实现清理");
        manual_cleanup(&root);
    }
    cleanup_after_uninstall(&root, delete_data);
    schedule_self_delete();
}

// ────────────────────────────── 入口 ──────────────────────────────

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    let quiet = argv.iter().any(|a| a == "--quiet");
    let delete_data = argv.iter().any(|a| a == "--delete-data");
    let uninst = is_uninstall_invocation();

    // 自检：验证原生注册表写入（安装收尾会写「应用和功能」的卸载入口，必须可靠）
    #[cfg(windows)]
    if argv.iter().any(|a| a == "--selftest-reg") {
        let r = reg::set_hkcu_string(r"Software\NIS_Selftest", "Probe", "ok-中文路径-测试");
        log(&format!("[selftest] reg write -> {:?}", r));
        std::process::exit(if r.is_ok() { 0 } else { 1 });
    }

    if uninst {
        // 第一步：搬去 %TEMP%（除非已经在 temp 里跑）
        if std::env::var("NIS_UNINST_TEMP").is_err() {
            match relocate_to_temp(quiet, delete_data) {
                Ok(()) => std::process::exit(0),
                Err(e) => {
                    log(&format!("[fatal] 搬家失败：{}", e));
                    std::process::exit(1);
                }
            }
        }
    }
    /* ★ 单实例闸门（0919 老大要求）：安装器/卸载器同时只允许一个。
       ⚠️ 必须放在"搬家到 %TEMP%"**之后** —— 那一步会再拉起一个自己（带 NIS_UNINST_TEMP 标记），
       如果在搬家前就占住闸门，那个"真干活"的新进程会被自己挡在门外。 */
    if !single_instance_guard() {
        log("[guard] 已有一个安装/卸载程序在运行 → 本次退出");
        return;
    }
    if uninst && quiet {
        run_quiet_uninstall(delete_data);
        std::process::exit(0);
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            setup_info,
            pick_dir,
            begin_install,
            begin_uninstall,
            cancel,
            launch_app,
            win_minimize,
            win_close
        ])
        .setup(move |app| {
            if let Some(st) = app.try_state::<AppState>() {
                if let Ok(mut m) = st.mode.lock() {
                    *m = if uninst { "uninstall".into() } else { "install".into() };
                }
                if let Ok(mut r) = st.root.lock() {
                    *r = resolve_uninstall_root().display().to_string();
                }
            }
            let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title(if uninst { "NIS 卸载程序" } else { "NIS 安装程序" })
                .inner_size(760.0, 540.0)
                .resizable(false)
                .decorations(false)
                .center();
            builder.build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running NIS setup");
}
