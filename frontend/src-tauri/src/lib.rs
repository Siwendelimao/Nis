use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

/// sidecar 后端子进程句柄（应用退出时清理）
struct SidecarState(Mutex<Option<Child>>);

/* ── 0919：前端"关闭询问"是否已挂上监听 ─────────────────────────────
 * boot 页与 index.html 的「接续帧」也有 ✕ 按钮，但它们在 Vue 起来之前 ——
 * 那时 emit `nis://close-requested` 是**没人听**的（表现为"点 ✕ 没反应"）。
 * 所以用一个开关区分：
 *   false（启动早期）→ ✕ 直接退出应用（没别的窗口可留）；
 *   true （界面就绪）→ 照旧拦下来、交给前端弹「取消 / 最小化 / 退出」。
 * 置位时机：CloseConfirmDialog 挂上监听之后（见前端 invoke('app_ui_ready')）。 */
static UI_READY: AtomicBool = AtomicBool::new(false);

fn ui_ready() -> bool {
    UI_READY.load(Ordering::SeqCst)
}

/// 应用自己的目录 = **NIS.exe 所在目录**。
/// 0919 老大口径："有些东西跟着安装目录、有些跟着他选的存储目录，**不要有让用户看不到的地方**"。
/// 所以 config.json / data / skills / memory / logs 全都落在安装目录里，`%APPDATA%\nis` 不再使用。
fn install_root() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            return dir.to_path_buf();
        }
    }
    legacy_base_dir()
}

/// 老位置（0919 之前：`%APPDATA%\nis`）——只用于**一次性迁移**和"安装目录不可写"的兜底
fn legacy_base_dir() -> PathBuf {
    let appdata = std::env::var("APPDATA").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(appdata).join("nis")
}

/// 目录可写探针：真建一个临时文件再删（Windows 上靠权限位判断不准）。
fn dir_writable(dir: &std::path::Path) -> bool {
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".nis-write-probe");
    match std::fs::write(&probe, b"1") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// 我们真正写东西的根：优先安装目录（**可写才行**），不可写才回退老位置。
/// ⚠️ 回退时不能当哑巴 —— `data_dir_fell_back()` 会让设置页显示黄字提示（"安装目录写不进去，数据暂存于 X"）。
fn app_base_dir() -> PathBuf {
    let root = install_root();
    if dir_writable(&root) {
        return root;
    }
    let fb = legacy_base_dir();
    let _ = std::fs::create_dir_all(&fb);
    fb
}

/// 是否发生了"安装目录不可写 → 回退"（设置页据此提示用户）
pub fn data_dir_fell_back() -> bool {
    !dir_writable(&install_root())
}

/// ★ 一次性迁移（0919）：把老位置 `%APPDATA%\nis` 的**全部内容**搬进安装目录，
/// 并把 config.json 里的 dataDir / skillsDir 改写成新路径。
/// 为什么用 rename 而不用复制+删：env/ 里的 venv 动辄几万文件（本机删一个文件 ~200ms），
/// 复制+删会让首启动卡几十分钟；改名是同盘瞬时操作。搬完后老目录改名成
/// `%APPDATA%\nis.migrated-<时间戳>`（**看得见的残留**，日志里有说明，可安全删除）。
fn migrate_legacy_data_once() {
    let root = install_root();
    if !dir_writable(&root) {
        return; // 装目录写不了 → 继续用老位置，不折腾
    }
    let legacy = legacy_base_dir();
    if !legacy.exists() {
        return;
    }
    let has_legacy_cfg = legacy.join("config.json").exists();
    let has_new_cfg = root.join("config.json").exists();
    if !has_legacy_cfg && !has_new_cfg {
        return; // 两边都没有 = 全新机器，没什么可搬
    }
    let log = |m: &str| {
        let d = root.join("logs");
        let _ = std::fs::create_dir_all(&d);
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(d.join("migrate.log")) {
            use std::io::Write;
            let _ = writeln!(f, "{}", m);
        }
    };
    log(&format!("[migrate] 开始：{} → {}", legacy.display(), root.display()));
    // 逐个顶层条目搬（config.json 最后搬，保证"搬到一半中断"时下次还能重来）
    let mut entries: Vec<std::path::PathBuf> = match std::fs::read_dir(&legacy) {
        Ok(rd) => rd.flatten().map(|e| e.path()).collect(),
        Err(_) => return,
    };
    entries.sort_by_key(|p| p.file_name().map(|s| s.to_string_lossy().to_string() == "config.json").unwrap_or(false));
    let mut moved = 0usize;
    let mut failed: Vec<String> = Vec::new();
    for src in entries {
        let name = match src.file_name() {
            Some(n) => n.to_os_string(),
            None => continue,
        };
        let dst = root.join(&name);
        if dst.exists() {
            failed.push(format!("{}（目标已存在，跳过）", name.to_string_lossy()));
            continue;
        }
        match std::fs::rename(&src, &dst) {
            Ok(()) => moved += 1,
            Err(e) => {
                // 跨盘 rename 会失败 → 退回复制+删源
                if copy_dir_all(&src, &dst).is_ok() {
                    let _ = if src.is_dir() { std::fs::remove_dir_all(&src) } else { std::fs::remove_file(&src) };
                    moved += 1;
                } else {
                    failed.push(format!("{}（{}）", name.to_string_lossy(), e));
                }
            }
        }
    }
    // 改写 config.json 里的绝对路径（否则还指回老地方）
    let cfg = root.join("config.json");
    if let Ok(txt) = std::fs::read_to_string(&cfg) {
        if let Ok(mut json) = serde_json::from_str::<serde_json::Value>(&txt) {
            let old_data = legacy.join("data");
            let old_skills = legacy.join("skills");
            if let Some(obj) = json.as_object_mut() {
                if let Some(v) = obj.get("dataDir").and_then(|x| x.as_str()).map(|s| s.to_string()) {
                    if v.starts_with(&old_data.to_string_lossy().to_string()) {
                        let _ = obj.insert("dataDir".into(), serde_json::Value::String(root.join("data").to_string_lossy().to_string()));
                    }
                }
                if let Some(v) = obj.get("skillsDir").and_then(|x| x.as_str()).map(|s| s.to_string()) {
                    if v.starts_with(&old_skills.to_string_lossy().to_string()) {
                        let _ = obj.insert("skillsDir".into(), serde_json::Value::String(root.join("skills").to_string_lossy().to_string()));
                    }
                }
            }
            let _ = std::fs::write(&cfg, serde_json::to_string_pretty(&json).unwrap_or(txt));
        }
    }
    // 老目录改名留痕（看得见、可删；不删是因为里面可能还有搬失败的东西）
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let retired = legacy.with_file_name(format!("nis.migrated-{}", stamp));
    let left = std::fs::read_dir(&legacy).map(|rd| rd.count()).unwrap_or(0);
    let _ = std::fs::rename(&legacy, &retired);
    log(&format!(
        "[migrate] 完成：搬了 {} 项，失败 {} 项，旧目录剩余 {} 项 → 已改名 {}",
        moved,
        failed.len(),
        left,
        retired.display()
    ));
    for f in failed {
        log(&format!("[migrate]   失败：{}", f));
    }
}

/// 数据目录解析：env NIS_DATA_DIR > %APPDATA%/nis/config.json {dataDir} > %APPDATA%/nis/data
fn resolve_data_dir() -> PathBuf {
    if let Ok(v) = std::env::var("NIS_DATA_DIR") {
        if !v.trim().is_empty() {
            return PathBuf::from(v);
        }
    }
    let base = app_base_dir();
    if let Ok(txt) = std::fs::read_to_string(base.join("config.json")) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&txt) {
            if let Some(d) = json.get("dataDir").and_then(|v| v.as_str()) {
                if !d.trim().is_empty() {
                    return PathBuf::from(d);
                }
            }
        }
    }
    base.join("data")
}

/// 技能目录解析：env NIS_SKILLS_DIR > config.json {skillsDir} > %APPDATA%/nis/skills
fn resolve_skills_dir() -> PathBuf {
    if let Ok(v) = std::env::var("NIS_SKILLS_DIR") {
        if !v.trim().is_empty() {
            return PathBuf::from(v);
        }
    }
    let base = app_base_dir();
    if let Ok(txt) = std::fs::read_to_string(base.join("config.json")) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&txt) {
            if let Some(d) = json.get("skillsDir").and_then(|v| v.as_str()) {
                if !d.trim().is_empty() {
                    return PathBuf::from(d);
                }
            }
        }
    }
    base.join("skills")
}

fn copy_dir_all(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &to)?;
        } else {
            std::fs::copy(entry.path(), &to)?;
        }
    }
    Ok(())
}

fn wait_port(port: u16, timeout: Duration) -> bool {
    let addr_str = format!("127.0.0.1:{}", port);
    let start = std::time::Instant::now();
    while start.elapsed() < timeout {
        if let Ok(addr) = addr_str.parse() {
            if std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok() {
                return true;
            }
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    false
}

/// 动态端口（0915）：打包版不再写死 8766 —— 与开发后端抢端口时，sidecar 会 EADDRINUSE 静默退出，
/// 而窗口只探「端口通不通」→ 探到开发后端就跳过去，页面只剩 {"error":"not found"}。
/// 改为：启动前选一个空闲端口，经 NIS_PORT 传给 sidecar，窗口导航到同一个端口。
fn pick_free_port() -> Option<u16> {
    std::net::TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|l| l.local_addr().ok())
        .map(|a| a.port())
}

fn port_is_free(p: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", p)).is_ok()
}

/// 后端端口解析（0915 加固）：**优先复用上次用过的端口**。
/// 为什么不每次都随机：窗口 origin = `http://127.0.0.1:<port>`，而浏览器存储（localStorage 等）
/// 按 origin 隔离 —— 端口一变全部作废。虽然前端持久化已搬到后端（不依赖 origin），
/// 但稳定端口能进一步避免「同一台机器被当成新用户」的一切副作用。
/// 端口被占（例如开发后端起在同号）时才另选一个并记下。
fn resolve_port() -> u16 {
    let base = app_base_dir();
    let cfg_path = base.join("config.json");
    let mut json: serde_json::Value = std::fs::read_to_string(&cfg_path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| serde_json::json!({}));

    if let Some(prev) = json.get("port").and_then(|v| v.as_u64()) {
        let p = prev as u16;
        if p > 1024 && port_is_free(p) {
            return p;
        }
    }
    let p = pick_free_port().unwrap_or(8766);
    if let Some(obj) = json.as_object_mut() {
        obj.insert("port".to_string(), serde_json::json!(p));
        let _ = std::fs::create_dir_all(&base);
        if let Ok(t) = serde_json::to_string_pretty(&json) {
            let _ = std::fs::write(&cfg_path, t);
        }
    }
    p
}

/// 启动内置后端：pack/node.exe --import tsx/esm server.ts（cwd = pack/backend）
fn spawn_backend(resource_dir: &std::path::Path, port: u16) -> Option<Child> {
    let pack = resource_dir.join("pack");
    let node = pack.join("node.exe");
    let backend = pack.join("backend");
    let dist = pack.join("dist");
    // ★ 0923：seed-skills 不再打包（NIS 不自带技能）—— 原来这里解析 pack/seed-skills 做首启播种
    if !node.exists() || !backend.exists() {
        eprintln!("[nis] sidecar 资源缺失: {:?}", pack);
        return None;
    }
    let data = resolve_data_dir();
    let skills = resolve_skills_dir();
    let _ = std::fs::create_dir_all(&data);
    /* ★ 0923（老大定案）：**不再播种技能种子** —— NIS 不自带技能，包里的 seed-skills 已去掉。
       用户技能目录由他自己导入/安装；skills 变量仍在下面传给 sidecar（NIS_SKILLS_DIR）。 */
    let mut cmd = Command::new(&node);
    cmd.arg("--import")
        .arg("tsx/esm")
        .arg("server.ts")
        .current_dir(&backend)
        .env("NIS_DATA_DIR", &data)
        .env("NIS_SKILLS_DIR", &skills)
        /* 0919：把自己的 pid 交给 sidecar。壳被**强杀**（卸载器 taskkill /F）时 sidecar 会变孤儿，
         * 它锁着 `pack\node.exe` 和 `pack\backend\` → 卸载后剩一个删不掉的 `pack\`（老大实测）。
         * 后端拿这个 pid 做「父进程没了就自己退」的守卫，见 server.ts 的 orphan-guard。 */
        .env("NIS_PARENT_PID", std::process::id().to_string())
        /* 0919 口径（老大）：记忆库 / 知识库**跟着安装位置**走 —— `<安装目录>\memory`
         * （resource_dir 就是安装目录，pack 在它下面；所以这里就是 D:\nis\memory 这种）。
         * 三条都比过：不跟「设置→通用→存储目录」走（那是工作区，用户可换）、
         * 不跟 config.json 的 dataDir 走（导入数据会把它指到解包目录）、
         * 也不放 %APPDATA%（老大会在自己的安装盘里找它）。
         * 新装 → 该目录是空的 → 记忆为空；要历史就用「导入数据」。
         * ⚠️ 若安装目录不可写（例如装在 Program Files），记忆桥会自动回退到 `<数据根>/memory` 并在日志里说明。 */
        .env("NIS_MEMORY_DIR", resource_dir.join("memory"))
        .env("NIS_PORT", port.to_string());
    if dist.exists() {
        cmd.env("NIS_DIST_DIR", &dist);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW：不弹控制台
    }
    match cmd.spawn() {
        Ok(child) => {
            println!("[nis] 后端已拉起 pid={}", child.id());
            Some(child)
        }
        Err(e) => {
            eprintln!("[nis] 后端启动失败: {}", e);
            None
        }
    }
}

/// 读开屏用的主题（"dark" / "light"；读不到返回空串，调用方按浅色处理）。
///
/// 取值优先级（★ 0920 / 0.0.11 改）：
///   ① `nis-settings.appearance.themeMode` —— **权威**：'深色'→dark、'浅色'→light；
///      '跟随系统' / '按时间' 这两个 Rust 这边判不了（拿不到系统偏好与时钟区间），落到 ②。
///   ② `nis.ui.theme` —— 前端 applyTheme() 每次算完都会写回"上次实际是深是浅"。
///
/// 为什么必须要有 ①：**导入数据包会把 ui-state.json 整份换成包里的**，
/// 于是 ② 变成导出机上的值。老大实测症状就是"导入老数据后点『立即重启』，
/// 开屏前段是浅色，到 80% 多才闪一下变深色"——那个"闪"就是应用页起来后
/// applyTheme() 按 appearance 重新算出深色。① 只要用户的 appearance 是明确的深/浅，
/// 就不会被包里的脏值带跑。
fn read_ui_theme() -> String {
    let f = resolve_data_dir().join("ui-state.json");
    if let Ok(t) = std::fs::read_to_string(&f) {
        if let Ok(j) = serde_json::from_str::<serde_json::Value>(&t) {
            /* ① nis-settings 有**两种形态**：前端 localStore 存的是字符串，手改/历史版本是对象 */
            if let Some(raw) = j.get("nis-settings") {
                let ns: Option<serde_json::Value> = match raw {
                    serde_json::Value::String(s) => serde_json::from_str(s).ok(),
                    serde_json::Value::Object(_) => Some(raw.clone()),
                    _ => None,
                };
                if let Some(ns) = ns {
                    if let Some(mode) = ns
                        .get("appearance")
                        .and_then(|a| a.get("themeMode"))
                        .and_then(|m| m.as_str())
                    {
                        match mode {
                            "深色" => return "dark".to_string(),
                            "浅色" => return "light".to_string(),
                            /* 跟随系统 / 按时间：Rust 判不了 → 交给 ② */
                            _ => {}
                        }
                    }
                }
            }
            /* ② 上次实际用过的深浅 */
            if let Some(v) = j.get("nis.ui.theme").and_then(|x| x.as_str()) {
                if v == "dark" || v == "light" {
                    return v.to_string();
                }
            }
        }
    }
    String::new()
}

/// 把  解析成 Tauri 的 Color（给窗口/WebView 底色用）。
/// 只认 6 位十六进制；解析不出来就退纯白（宁可白，也不要 panic 在建窗这一步）。
fn parse_hex_color(hex: &str) -> tauri::window::Color {
    let h = hex.trim().trim_start_matches('#');
    let (r, g, b) = if h.len() == 6 {
        (
            u8::from_str_radix(&h[0..2], 16).unwrap_or(255),
            u8::from_str_radix(&h[2..4], 16).unwrap_or(255),
            u8::from_str_radix(&h[4..6], 16).unwrap_or(255),
        )
    } else {
        (255, 255, 255)
    };
    tauri::window::Color(r, g, b, 255)
}

/* ── ★1011（老大要求）：窗口尺寸记忆 ──────────────────────────────
 * 用户把窗口拉大/缩小后，下次启动要继承上次的尺寸。
 * 为什么不引 window-state 插件：这里只要"尺寸"这一件事，用一行纯文本存就够了，
 *   少一个依赖就少一份编译/离线拉包的风险。
 * 只记**尺寸**不记位置：多显示器/拔屏场景下，位置可能落到屏幕外（找不回来的窗口最气人），
 *   所以启动时一律 .center() 居中，尺寸用记忆值。
 * 存的是**逻辑尺寸**（inner_size 给的是物理像素，要除以 scale_factor），
 *   因为建窗时的 .inner_size() 收的也是逻辑尺寸。 */
static LAST_WS_SAVE: AtomicU64 = AtomicU64::new(0);

fn win_state_path() -> PathBuf {
    app_base_dir().join("window-state.txt")
}

/// 读回上次尺寸：(宽, 高, 是否最大化)。异常值一律丢弃（换过屏/分辨率变了）
fn load_window_state() -> Option<(f64, f64, bool)> {
    let t = std::fs::read_to_string(win_state_path()).ok()?;
    let parts: Vec<&str> = t.trim().split('|').collect();
    if parts.len() < 3 {
        return None;
    }
    let w: f64 = parts[0].parse().ok()?;
    let h: f64 = parts[1].parse().ok()?;
    let m = parts[2].trim() == "1";
    if w < 900.0 || h < 600.0 || w > 20000.0 || h > 20000.0 {
        return None;
    }
    Some((w, h, m))
}

/// 保存当前窗口尺寸（最大化时保留上次的普通尺寸，只把 maximized 记上）
fn save_window_state(win: &tauri::Window) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let maximized = win.is_maximized().unwrap_or(false);
    let (w, h) = if maximized {
        load_window_state().map(|(w, h, _)| (w, h)).unwrap_or((1400.0, 900.0))
    } else {
        match (win.inner_size(), win.scale_factor()) {
            (Ok(s), Ok(sf)) if sf > 0.0 => (s.width as f64 / sf, s.height as f64 / sf),
            _ => return,
        }
    };
    let _ = std::fs::write(
        win_state_path(),
        format!("{}|{}|{}", w.round(), h.round(), if maximized { 1 } else { 0 }),
    );
    let _ = now;   // 时间戳仅用于节流判断，写入本身不依赖它
}

/// 窗口：先本地 boot 页（打包内嵌），后端就绪后导航到应用主页（serve-from-backend）
fn setup_window(app: &tauri::App, port: u16) -> tauri::Result<()> {
    let dev = cfg!(debug_assertions);
    /* ★ 0920：把**窗口与 WebView 的底色**设成开屏页那一色（浅=白 / 深=黑）。
       治的是老大反馈的"加载到 80% 左右会闪一下"：boot 页 → 应用页是**换文档**，
       新文档第一帧画出来之前，WebView2 显示的是它自己的默认底色（**白**）——
       深色主题下就是明晃晃闪一下白；浅色下则与页面底色不是一个白（页面是 #fff 的"开屏白"
       vs 系统底的纯白，边缘/圆角处能看出跳变）。
       Tauri 的 `background_color` 同时设 window 与 webview 两层，等于把这段"没画东西的帧"
       刷成与开屏同一个色 → 换文档时肉眼接不上缝。 */
    let splash_bg = if read_ui_theme() == "dark" { "#000000" } else { "#ffffff" };
    /* ★1011：尺寸继承上次（没有记录或记录异常 → 默认 1400x900），位置一律居中 */
    let ws = load_window_state();
    let (cw, ch) = ws.map(|(w, h, _)| (w, h)).unwrap_or((1400.0, 900.0));
    let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("boot.html".into()))
        .title("NIS")
        .inner_size(cw, ch)
        .min_inner_size(900.0, 600.0)
        .decorations(false)
        .background_color(parse_hex_color(splash_bg))
        .center()
        .build()?;
    if ws.map(|(_, _, m)| m).unwrap_or(false) {
        let _ = win.maximize();
    }
    /* 0918 定案：窗口四角走 **DWM 的 ROUND 档**（系统圆角，随 DPI 缩放，即"系统能做的最大圆角"）。
     * 细节、以及"为什么不做无边框+透明+CSS 自绘 24px"的取舍，见 round_window_corners() 的注释。
     * DWM 在主题/焦点变化时可能重置该属性，所以建窗后立刻设一次、稍后再补一次。 */
    #[cfg(windows)]
    round_window_corners(&win);
    let theme = read_ui_theme();
    let win_thread = win.clone();
    std::thread::spawn(move || {
        #[cfg(windows)]
        {
            std::thread::sleep(Duration::from_millis(320));
            round_window_corners(&win_thread);
        }
        // 开屏页主题：boot.html 先按系统偏好渲染，这里再用上次的主题纠正一次
        // （页面加载是异步的，所以隔一拍多发两次，早到的那次也不会丢）
        if !theme.is_empty() {
            for delay in [150u64, 900] {
                std::thread::sleep(Duration::from_millis(delay));
                let _ = win.eval(format!(
                    "window.__setBootTheme && window.__setBootTheme('{}')",
                    theme
                ));
            }
        }
        let timeout = Duration::from_secs(if dev { 20 } else { 90 });
        let ok = wait_port(port, timeout);
        if ok || dev {
            /* 0919 修：进度交接改成「**boot 页自己带着真实进度导航**」。
             * 旧做法：boot 页把进度写进 document.title（`NISBOOT:NN`），这里用 win.title() 读出来拼进 URL。
             * **实测这条链根本不工作** —— WebView2 里改 document.title **不会**同步到 Win32 窗口标题
             * （实测启动全程 12s、每 120ms 采样，窗口标题恒为 "NIS"），于是 boot_pct 永远是 0：
             * 应用页的进度条从 0 重来，视觉上就是"第一条满了之后清零、又冒出一根条"。
             * 现在改用**已经在用、已验证可用**的那条 eval 通道（下面 setBootTheme 走的就是它）：
             * 把「后端地址 + 主题」交给 boot 页，由它自己
             * `location.href = base + '?p=' + 当前真实进度 + '&t=' + 主题` —— 同源跳转、参数自带，
             * 不依赖任何"页面 → Rust"的反向通信（那类通道在 boot 页里并不可靠）。
             * 兜底：等 1.5s 后若仍停在 boot 页（脚本没就绪 / eval 被拦），Rust 直接导航，
             * 退化成旧行为（p 缺省为 0，至少不会卡在开屏页）。 */
            let base = format!("http://127.0.0.1:{}/", port);
            let js = format!(
                "window.__nisBootGo && window.__nisBootGo('{}', '{}')",
                base, theme
            );
            let _ = win.eval(&js);
            let win_fb = win.clone();
            let theme_fb = theme.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(1500));
                let still_boot = win_fb
                    .url()
                    .map(|u| u.path().ends_with("boot.html"))
                    .unwrap_or(false);
                if still_boot {
                    let mut t = format!("http://127.0.0.1:{}/", port);
                    if !theme_fb.is_empty() {
                        t.push_str(&format!("?t={}", theme_fb));
                    }
                    if let Ok(url) = t.parse::<tauri::Url>() {
                        let _ = win_fb.navigate(url);
                    }
                }
            });
        } else {
            // 端口是启动前现选的空闲端口：探不到 = 我们自己的 sidecar 起挂了。
            // 不静默停在开屏页，直接告诉用户（并提示去看日志）。
            eprintln!("[nis] 后端端口 {} 在 {}s 内未就绪", port, timeout.as_secs());
            let _ = win.eval("window.__bootFailed && window.__bootFailed()");
        }
    });
    Ok(())
}

/// Windows 11 窗口圆角（DWM）。
///
/// 历史（别再来回改）：
/// - 0917 老大说"系统默认圆角太小" → 我把它改成了**直角**（DONOTROUND）。
/// - 0918 老大要"和侧栏一样的大圆角（24px）"。技术上只有两条路：
///     ① DWM 档位：只有 不圆 / ROUND(标准，随 DPI 缩放) / ROUNDSMALL 三档，**给不了任意半径**；
///     ② 无边框 + 窗口透明 + CSS 自绘 24px：能任意半径，但四角会"露底"
///        （角外是真桌面/别的窗口，且没有外阴影）—— 观感像被抠出来贴上去的（老大：穿帮）。
///   ⇒ **最终定案：走 ① 的 ROUND 档**（系统能给的圆角），不做 ② 的透明自绘。
/// 只声明用到的这一个 API —— 不引入 windows crate，省掉版本对齐风险。
#[cfg(windows)]
fn round_window_corners(win: &tauri::WebviewWindow) {
    use std::ffi::c_void;

    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmSetWindowAttribute(hwnd: isize, attr: u32, value: *const c_void, size: u32) -> i32;
    }
    const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
    // 1=DONOTROUND（直角）2=ROUND（系统圆角，随 DPI 缩放，本档即"系统能做的最大圆角"）3=ROUNDSMALL
    const DWMWCP_ROUND: i32 = 2;

    if let Ok(h) = win.hwnd() {
        let hwnd = h.0 as isize;
        let pref: i32 = DWMWCP_ROUND;
        unsafe {
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_WINDOW_CORNER_PREFERENCE,
                &pref as *const i32 as *const c_void,
                std::mem::size_of::<i32>() as u32,
            );
        }
    }
}

/// 唤回主窗口（托盘点击 / 菜单「显示主界面」共用）
fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 系统托盘（0915 用户要求）：左键点图标唤回主界面，**右键弹自绘菜单**（显示主界面 / 退出 NIS）。
/// 配套约定：**点窗口 ✕ = 收进托盘**（后端继续跑），要彻底退出走托盘菜单 —— 桌面端常见习惯。
///
/// 0919：**不再挂系统原生菜单**（`.menu(&menu)`）—— 原生菜单由 Windows 绘制，圆角/配色/字体
/// 一个都改不了（老大反馈"样式还没变"就是指这个）。改成自绘窗口，见 `open_tray_menu()`。
fn setup_tray(app: &tauri::App, port: u16) -> tauri::Result<()> {
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let mut builder = TrayIconBuilder::with_id("nis-tray")
        .tooltip("NIS")
        .show_menu_on_left_click(false)
        .on_tray_icon_event(move |tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } => show_main(tray.app_handle()),
            TrayIconEvent::Click {
                button: MouseButton::Right,
                button_state: MouseButtonState::Up,
                position,
                rect,
                ..
            } => open_tray_menu(tray.app_handle(), port, position, rect),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;

    /* ★ 0920：**启动后就把菜单窗口建好**（隐藏着）。
       原来只在第一次右键时才建 —— 而建一个 WebView2 窗口要一两百毫秒，
       那一两百毫秒里右键"像是没反应"，用户就会再点一两下（老大反馈的"有点卡、点两三次"）。
       现在放到后台线程里、等主界面稳定后再建，既不拖慢启动，又让第一次右键就是瞬时的。 */
    {
        let handle = app.handle().clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(2200));
            let _ = ensure_tray_menu_window(&handle, port);
        });
    }
    Ok(())
}

/* ── 自绘托盘右键菜单（0919） ─────────────────────────────────────────
 * 为什么必须自绘：Tauri 的 `Menu` 是**系统原生菜单**（由 Windows 绘制），外观完全不可控。
 * 做法：一个小的无边框窗口（**同源**加载 `tray-menu.html`），右键托盘时贴光标弹出、失焦即隐藏。
 * · 同源（`http://127.0.0.1:<port>/`，后端在服务 dist）→ 主题/字体/语言全都现成；
 *   换成 `tauri://` 之类别的 origin 就读不到应用自己的 localStorage 了。
 * · 懒建窗口：只有真的右键过才会存在 —— 不用为它增加启动开销。
 * · 兜底：窗口建不起来就退化成"唤回主界面"，绝不出现"右键没反应"。 ── */

const TRAY_MENU_LABEL: &str = "tray-menu";
/** 菜单窗口逻辑尺寸（CSS 里按同尺寸画卡片；透明背景是给卡片阴影留的余量） */
const TRAY_MENU_W: f64 = 198.0;
const TRAY_MENU_H: f64 = 90.0;

fn open_tray_menu(
    app: &tauri::AppHandle,
    port: u16,
    at: tauri::PhysicalPosition<f64>,
    rect: tauri::Rect,
) {
    let win = match ensure_tray_menu_window(app, port) {
        Some(w) => w,
        None => return, // 建不起来时 ensure_* 里已经回退成"唤回主界面"
    };
    /* 贴**托盘图标的角**弹出（0920 老大口径：从图标左上角/右上角出来，而不是从光标中心长出来）：
     *   · 任务栏通常在屏幕底部 → 菜单放在图标**上方**，底边尽量贴着图标
     *   · 水平方向**优先"左上角对齐"**（菜单左边 = 图标左边，往右长）——
     *     老大 0.0.9 实测反馈"太远了"：上一个版本是右对齐，菜单 198px 宽、右边贴着图标右边，
     *     于是菜单整个身体伸到图标左边一百多像素，看着跟图标没关系。
     *     屏幕右侧放不下时才翻成**右对齐**（菜单右边 = 图标右边），保证不出屏。
     *   · 纵向：`rect` 给的是**任务栏按钮**的矩形（48px 高），而图标本体重 32px 居中对齐 →
     *     直接按按钮上沿放会比图标"高出一截"。这里按图标本体的上沿算，间距 2px。
     * `rect` 是 Windows 通过 Shell_NotifyIconGetRect 给的真实图标矩形（物理像素）；
     * 拿不到（全 0）时才退回首帧的光标位置。 */
    let scale = win.scale_factor().unwrap_or(1.0);
    let (mw, mh) = (TRAY_MENU_W * scale, TRAY_MENU_H * scale);
    let (sw, sh) = win
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| (m.size().width as f64, m.size().height as f64))
        .unwrap_or((1920.0, 1080.0));
    let gap = 2.0 * scale;
    // 图标矩形（物理像素）
    let (ix, iy, iw, ih) = {
        let (px, py) = match rect.position {
            tauri::Position::Physical(p) => (p.x as f64, p.y as f64),
            tauri::Position::Logical(p) => (p.x * scale, p.y * scale),
        };
        let (pw, ph) = match rect.size {
            tauri::Size::Physical(s) => (s.width as f64, s.height as f64),
            tauri::Size::Logical(s) => (s.width * scale, s.height * scale),
        };
        if pw <= 0.0 || ph <= 0.0 {
            (at.x, at.y, 0.0, 0.0) // 兜底：用光标位置当图标
        } else {
            (px, py, pw, ph)
        }
    };
    // 图标本体的上沿：按钮比图标高时，把多出来的高度对半让出去
    let icon_top = if iw > 0.0 && ih > iw { iy + (ih - iw) / 2.0 } else { iy };
    let mut y = icon_top - mh - gap; // 图标上方，贴着放
    if y < 4.0 * scale {
        y = iy + ih + gap; // 任务栏在顶部 → 翻到下方
    }
    // 水平：优先左上角对齐（往右长），右边放不下才右对齐
    let mut x = ix;
    if x + mw > sw - 4.0 * scale {
        x = ix + iw - mw;
    }
    if x < 4.0 * scale {
        x = 4.0 * scale;
    }
    if y + mh > sh - 4.0 * scale {
        y = sh - mh - 4.0 * scale;
    }
    /* 先 hide 再定位再 show：窗口若停留在上一次的位置，直接 set_position 会看到"闪一下跳位"。 */
    let _ = win.hide();
    let _ = win.set_always_on_top(true);
    let _ = win.set_position(tauri::PhysicalPosition::new(x.round() as i32, y.round() as i32));
    let _ = win.show();
    let _ = win.set_focus();
    nis_log(
        "tray.log",
        &format!(
            "托盘菜单弹出 at ({:.0}, {:.0})  图标矩形 ({:.0},{:.0},{:.0}x{:.0}) scale={}",
            x, y, ix, iy, iw, ih, scale
        ),
    );
}

/// 拿到（必要时创建）自绘托盘菜单窗口。返回 None 表示建不起来 —— 调用方已经把用户兜到"唤回主界面"。
fn ensure_tray_menu_window(app: &tauri::AppHandle, port: u16) -> Option<tauri::WebviewWindow> {
    if let Some(w) = app.get_webview_window(TRAY_MENU_LABEL) {
        return Some(w);
    }
    let theme = read_ui_theme();
    let t = if theme.is_empty() { "auto".to_string() } else { theme };
    let url = format!("http://127.0.0.1:{}/tray-menu.html?t={}", port, t);
    let u = match url.parse::<tauri::Url>() {
        Ok(u) => u,
        Err(e) => {
            nis_log("tray.log", &format!("托盘菜单 URL 非法（{}）→ 回退唤回主界面", e));
            show_main(app);
            return None;
        }
    };
    match WebviewWindowBuilder::new(app, TRAY_MENU_LABEL, WebviewUrl::External(u))
        .title("NIS")
        .inner_size(TRAY_MENU_W, TRAY_MENU_H)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .visible(false)
        .build()
    {
        Ok(w) => Some(w),
        Err(e) => {
            nis_log("tray.log", &format!("托盘菜单窗口创建失败：{} → 回退唤回主界面", e));
            show_main(app);
            None
        }
    }
}

/// 自绘托盘菜单里的动作（菜单窗口 → Rust）
#[tauri::command]
fn tray_action(app: tauri::AppHandle, action: String) {
    nis_log("tray.log", &format!("tray_action action={}", action));
    match action.as_str() {
        "show" => show_main(&app),
        "quit" => app.exit(0),
        other => nis_log("tray.log", &format!("未知 action，忽略：{}", other)),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .manage(SidecarState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![open_devtools, open_path, window_action, restart_app, tray_action, app_ui_ready])
        .on_window_event(|window, event| {
            /* 0919：自绘托盘菜单窗口 —— 失焦即收起（像系统菜单一样）；也不参与"关闭询问" */
            if window.label() == TRAY_MENU_LABEL {
                if let tauri::WindowEvent::Focused(false) = event {
                    let _ = window.hide();
                }
                return;
            }
            /* 0918（老大要求）：点窗口 ✕ 不再"默默收起"，而是**问一次** ——
             * 前端弹窗给三个选项：取消 / 隐藏到托盘 / 退出 NIS。
             * 旧行为是直接 hide()，用户以为关掉了、其实还在后台跑（托盘菜单才能真退）。 */
            /* ★1011：窗口尺寸变化就记下来（节流 800ms —— Resized/Moved 一次拖动会刷几十次） */
            if matches!(
                event,
                tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_)
            ) {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                let last = LAST_WS_SAVE.load(Ordering::Relaxed);
                if now.saturating_sub(last) >= 800 {
                    LAST_WS_SAVE.store(now, Ordering::Relaxed);
                    save_window_state(window);
                }
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    save_window_state(window);   // ★1011：关闭前存一次（节流可能刚好跳过最后一次）
                    if ui_ready() {
                        api.prevent_close();
                        let _ = window.emit("nis://close-requested", ());
                    } else {
                        /* 启动早期（前端还没挂上监听）→ 让它真的关掉，
                         * 否则拦截了也没人处理，窗口会"关不掉"。 */
                        nis_log("close.log", "原生 ✕：界面未就绪 → 直接退出");
                    }
                }
            }
        })
        .setup(|app| {
            /* ★ 第一件事：把老位置（%APPDATA%\nis）的数据一次性搬进安装目录，并改写 config.json 里的路径。
               必须**早于 resolve_port()**（它要读搬家后的 config.json）。 */
            if !cfg!(debug_assertions) {
                migrate_legacy_data_once();
            }
            // 动态端口：打包版复用上次端口（不可用才另选），避开开发后端占用的 8766
            let port: u16 = if cfg!(debug_assertions) {
                5174
            } else {
                resolve_port()
            };
            if !cfg!(debug_assertions) {
                if let Ok(res) = app.path().resource_dir() {
                    let child = spawn_backend(&res, port);
                    *app.state::<SidecarState>().0.lock().unwrap() = child;
                }
            }
            setup_window(app, port)?;
            if let Err(e) = setup_tray(app, port) {
                eprintln!("[nis] 托盘创建失败: {}", e);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            RunEvent::ExitRequested { .. } | RunEvent::Exit => {
                if let Some(mut child) = app_handle.state::<SidecarState>().0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
            _ => {}
        });
}

/// 把动作写进**安装目录下的 `logs\`** —— 这类"点了没反应"必须能事后查（发生在退出前那一瞬，控制台看不到）。
/// 0919 起不再往 `%APPDATA%` 写：日志也属于"用户能找到的地方"。
fn nis_log(file: &str, msg: &str) {
    let p = app_base_dir().join("logs").join(file);
    if let Some(par) = p.parent() {
        let _ = std::fs::create_dir_all(par);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        use std::io::Write;
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(f, "[unix={}] {}", secs, msg);
    }
}

/// 窗口动作（关闭询问弹窗的三个按钮；事件 `nis://close-requested` 由 lib.rs 的窗口事件发出）
///  · "hide"   → 隐藏到托盘（应用与后端继续在后台跑）
///  · "quit"   → 真正退出（RunEvent::Exit 里会连带杀掉 sidecar 后端子进程）
///  · "cancel" → 什么都不做
/// 0919：每一步都写 `close.log` —— 前端"点了没反应"时，先看这份日志就能区分
///       "命令压根没到 Rust"（日志无行）还是 "到了但动作失败"（日志有行 + 原因）。
#[tauri::command]
fn window_action(window: tauri::Window, action: String) -> Result<(), String> {
    nis_log("close.log", &format!("收到 window_action action={}", action));
    match action.as_str() {
        "hide" => match window.hide() {
            Ok(()) => {
                nis_log("close.log", "hide 成功（已隐藏到托盘，后端继续运行）");
                Ok(())
            }
            Err(e) => {
                nis_log("close.log", &format!("hide 失败：{}", e));
                Err(e.to_string())
            }
        },
        /* 0919（老大要求）：关闭询问弹窗的「最小化」取代"隐藏到托盘"（同样保持后台运行，更符合直觉）；
         * 顺带给开屏页的窗口按钮留同一个口子。 */
        "minimize" => match window.minimize() {
            Ok(()) => {
                nis_log("close.log", "minimize 成功");
                Ok(())
            }
            Err(e) => {
                nis_log("close.log", &format!("minimize 失败：{}", e));
                Err(e.to_string())
            }
        },
        /* 最大化/还原（开屏页与自绘标题栏用）。
         * ⚠️ tauri 2 的 `Window` **没有** `toggle_maximize()`（只有 `is_maximized`/`maximize`/`unmaximize`）——
         * 之前想当然写成 toggle_maximize，编译直接 E0599，打包脚本还傻乎乎重试了 29 次才被我停掉。 */
        "toggle-maximize" => {
            let r = match window.is_maximized() {
                Ok(true) => window.unmaximize(),
                Ok(false) => window.maximize(),
                Err(e) => Err(e),
            };
            match r {
                Ok(()) => {
                    nis_log("close.log", "toggle-maximize 成功");
                    Ok(())
                }
                Err(e) => {
                    nis_log("close.log", &format!("toggle-maximize 失败：{}", e));
                    Err(e.to_string())
                }
            }
        }
        /* 自绘标题栏拖动窗口（开屏页按住那里等于拖标题栏） */
        "drag" => window.start_dragging().map_err(|e| e.to_string()),
        /* 0919：开屏页（boot / 接续帧）的 ✕。那两处 Vue 还没起来，
         * 如果直接 emit `nis://close-requested` 会**没人听**（= 点了没反应）。
         * 所以按 UI 是否就绪分流：就绪 → 跟原生 ✕ 一样弹询问；未就绪 → 直接退出。 */
        "close" => {
            if ui_ready() {
                nis_log("close.log", "close：界面已就绪 → 交给前端弹「关闭询问」");
                window
                    .emit("nis://close-requested", ())
                    .map_err(|e| e.to_string())
            } else {
                nis_log("close.log", "close：界面未就绪（启动期）→ 直接退出应用");
                window.app_handle().exit(0);
                Ok(())
            }
        }
        "quit" => {
            nis_log("close.log", "quit：调用 app.exit(0)");
            window.app_handle().exit(0);
            Ok(())
        }
        other => {
            nis_log("close.log", &format!("未知 action，忽略：{}", other));
            Ok(())
        }
    }
}

/// 前端「关闭询问」已挂上监听（由 CloseConfirmDialog 挂载后调用）。
/// 记下这一刻，之后的 ✕ 才会走"问一次"而不是直接退。
#[tauri::command]
fn app_ui_ready() {
    if !ui_ready() {
        UI_READY.store(true, Ordering::SeqCst);
        nis_log("close.log", "app_ui_ready：前端已挂上关闭询问监听");
    }
}

/// 重启应用（0918：数据导入后要切到新数据目录/新内核，必须重启才生效 ——
/// 前端把它做成弹窗里的「立即重启」按钮，避免用户点完导入就忘了这回事）。
///
/// 为什么不直接 `app.restart()`：那会**先拉起新进程再退旧进程**，而端口是"复用上次那个"
/// （见 resolve_port），旧进程还没退出 → `port_is_free` 判假 → 新进程另选端口 →
/// **origin 变了，localStorage 全废**。所以这里反过来：先让旧进程退出，
/// 隔 2 秒（ping 当 sleep，Windows 下最省事）再由 cmd 拉起同一个 exe，端口就能原样复用。
#[tauri::command]
fn restart_app(app: tauri::AppHandle) {
    if let Ok(exe) = std::env::current_exe() {
        /* 0919 修「点了『立即重启』没反应」：
         *  ① 旧代码 spawn 出的 cmd 是**本进程的子进程**，而紧接着就 `app.exit(0)` ——
         *     Windows 上未 detach 的子进程会随父进程一起结束，于是"该被拉起的新进程"根本没起来。
         *     现在加 `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`，让它脱离父进程独立存活。
         *  ② 全流程写日志 `%APPDATA%\nis\restart.log` —— 这类"点了没反应"的问题必须能事后查，
         *     不能再靠猜（它发生在退出前那一瞬，控制台也看不到）。 */
        let log_line = |msg: String| nis_log("restart.log", &msg);
        log_line(format!("restart_app: exe={}", exe.display()));
        /* 0919 二修（老大："导入后点立即重启，nis 并没有重启"）：
         *  ★ 真因是**给 cmd 塞了一个带引号的复合命令**。旧写法
         *    `cmd /C "ping … & start \"\" \"<exe>\""` 是当作**一个参数**传的，
         *    Rust 会按 Windows 规则给参数加引号、并把内部的 `"` 转义成 `\"` ——
         *    而 cmd.exe 不认这套转义，整条复合命令被拆坏 → `start` 从没执行过（表现就是"点了没反应"）。
         *  现在：把命令**写进一个临时 .cmd 文件**，只给 cmd 传一个路径参数（最不容易出错），
         *    并把"脚本路径 / spawn 结果"都写进日志 —— 下次有问题直接看 `%APPDATA%\nis\restart.log`。 */
        let script = std::env::temp_dir().join("nis-restart.cmd");
        let body = format!(
            "@echo off\r\nping -n 3 127.0.0.1 >nul\r\nstart \"\" \"{}\"\r\n",
            exe.display()
        );
        match std::fs::write(&script, body) {
            Ok(()) => log_line(format!("restart_app: 已写重启脚本 {}", script.display())),
            Err(e) => log_line(format!("restart_app: 写重启脚本失败 {e}")),
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
            /* ⚠️ 0920 修「重启时会先弹一个命令行窗口」（老大反馈）：
             *  原来这里传的是 `CREATE_NO_WINDOW | DETACHED_PROCESS`，而 MSDN 明确写着
             *  **CREATE_NO_WINDOW 与 DETACHED_PROCESS / CREATE_NEW_CONSOLE 同时用会被忽略**
             *  → cmd.exe 拿到的控制台**是可见的**，于是"先闪一个黑框、再打开 NIS"。
             *  现在只留 CREATE_NO_WINDOW（有控制台但不显示窗口）+ 新进程组（脱离父进程存活）。 */
            let mut c = std::process::Command::new("cmd");
            c.raw_arg("/C").raw_arg(format!("\"{}\"", script.display()));
            c.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
            match c.spawn() {
                Ok(ch) => log_line(format!("restart_app: 已拉起重启器 pid={}（2s 后 start 本 exe，无控制台窗口）", ch.id())),
                Err(e) => log_line(format!("restart_app: 拉起失败 {e}")),
            }
        }
        #[cfg(not(windows))]
        {
            let _ = std::process::Command::new("sh").arg("-c").arg(&script).spawn();
        }
    }
    app.exit(0);
}

/// 双击离线按钮触发的开发者工具打开指令（需配置打开 webview 调试模式）
#[tauri::command]
fn open_devtools(_window: tauri::Window) {
    #[cfg(debug_assertions)]
    {
        _window.open_devtools();
    }
}

/// 用系统资源管理器打开路径（数据导出/导入等场景）
#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err("not supported".into())
    }
}
