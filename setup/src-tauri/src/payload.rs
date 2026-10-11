//! 安装器载荷解析（0915）
//!
//! setup.exe 的字节布局（构建脚本负责拼接）：
//! ```text
//! [ 壳本体 shell ][ manifest.json ][ NSIS 引擎 engine.exe ][ footer(48B) ]
//! ```
//! footer = magic(16) + engine_off(8) + engine_len(8) + manifest_off(8) + manifest_len(8)，均为小端 u64。
//!
//! 这样做的理由：
//! - 单文件分发（用户只拿到一个 setup.exe），但界面完全自绘（WebView 壳），
//!   真正的安装动作仍然交给久经考验的 Tauri NSIS 引擎（快捷方式 / 注册表 / WebView2 引导全白拿）。
//! - 壳本体长度 = manifest_off，据此可以只截取「壳」写成安装目录里的 NIS-Uninstall.exe（约 10MB，而非 80MB）。

use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

/// 16 字节 magic（必须正好 16 —— 别手改长度）
pub const MAGIC: &[u8; 16] = b"NIS-SETUP-FOOTER";
pub const FOOTER_LEN: u64 = 48;
const BUF: usize = 1 << 20; // 1MB 拷贝块

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Manifest {
    pub product: String,
    pub version: String,
    /// 安装后 `$INSTDIR` 里的总字节数（进度分母）
    pub total_bytes: u64,
    pub file_count: u64,
    /// 安装完成后要启动的主程序名
    pub main_binary: String,
    pub built_at: String,
}

#[derive(Debug, Clone, Copy)]
pub struct Footer {
    pub engine_off: u64,
    pub engine_len: u64,
    pub manifest_off: u64,
    pub manifest_len: u64,
}

fn u64_le(b: &[u8]) -> u64 {
    let mut a = [0u8; 8];
    a.copy_from_slice(&b[..8]);
    u64::from_le_bytes(a)
}

/// 读 setup.exe 尾部 footer；不是带载荷的 setup（例如安装目录里的卸载器）返回 None
pub fn read_footer(exe: &Path) -> Option<Footer> {
    let mut f = File::open(exe).ok()?;
    let size = f.metadata().ok()?.len();
    if size < FOOTER_LEN {
        return None;
    }
    f.seek(SeekFrom::End(-(FOOTER_LEN as i64))).ok()?;
    let mut buf = [0u8; FOOTER_LEN as usize];
    f.read_exact(&mut buf).ok()?;
    if buf[..16] != MAGIC[..] {
        return None;
    }
    Some(Footer {
        engine_off: u64_le(&buf[16..24]),
        engine_len: u64_le(&buf[24..32]),
        manifest_off: u64_le(&buf[32..40]),
        manifest_len: u64_le(&buf[40..48]),
    })
}

pub fn read_manifest(exe: &Path, ft: &Footer) -> Result<Manifest, String> {
    let mut f = File::open(exe).map_err(|e| e.to_string())?;
    f.seek(SeekFrom::Start(ft.manifest_off)).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; ft.manifest_len as usize];
    f.read_exact(&mut buf).map_err(|e| e.to_string())?;
    serde_json::from_slice(&buf).map_err(|e| e.to_string())
}

/// 从 exe 头部拷贝 `len` 字节到 dest（用于截出「壳本体」当卸载器）
fn copy_head(exe: &Path, len: u64, dest: &Path) -> Result<(), String> {
    let mut src = File::open(exe).map_err(|e| e.to_string())?;
    let mut out = File::create(dest).map_err(|e| e.to_string())?;
    let mut left = len;
    let mut buf = vec![0u8; BUF];
    while left > 0 {
        let n = std::cmp::min(left, BUF as u64) as usize;
        src.read_exact(&mut buf[..n]).map_err(|e| e.to_string())?;
        out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        left -= n as u64;
    }
    out.flush().map_err(|e| e.to_string())?;
    Ok(())
}

/// 把「壳本体」（不含载荷）写到 dest —— 安装目录里的 NIS-Uninstall.exe
pub fn write_shell(exe: &Path, ft: &Footer, dest: &Path) -> Result<(), String> {
    copy_head(exe, ft.manifest_off, dest)
}

/// 抽出内嵌的 NSIS 引擎到临时目录
pub fn extract_engine(exe: &Path, ft: &Footer) -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join("nis-setup");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(format!("engine-{}.exe", std::process::id()));
    let mut src = File::open(exe).map_err(|e| e.to_string())?;
    src.seek(SeekFrom::Start(ft.engine_off)).map_err(|e| e.to_string())?;
    let mut out = File::create(&dest).map_err(|e| e.to_string())?;
    let mut left = ft.engine_len;
    let mut buf = vec![0u8; BUF];
    while left > 0 {
        let n = std::cmp::min(left, BUF as u64) as usize;
        src.read_exact(&mut buf[..n]).map_err(|e| e.to_string())?;
        out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        left -= n as u64;
    }
    out.flush().map_err(|e| e.to_string())?;
    Ok(dest)
}
