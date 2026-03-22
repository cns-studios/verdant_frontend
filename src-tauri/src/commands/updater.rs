use semver::Version;
use serde_json::Value;
use std::env;
use std::path::PathBuf;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub release_name: String,
    pub published_at: String,
    pub notes: String,
    pub update_available: bool,
    pub download_asset_name: String,
    pub download_url: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDownloadResult {
    pub file_path: String,
    pub file_name: String,
    pub version: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum UpdateChannel {
    Stable,
    Nightly,
}

fn updater_repo_owner() -> String {
    env::var("UPDATER_REPO_OWNER").unwrap_or_else(|_| "cns-studios".to_string())
}

fn updater_repo_name() -> String {
    env::var("UPDATER_REPO_NAME").unwrap_or_else(|_| "Verdant-Desktop".to_string())
}

fn parse_update_channel(raw: Option<String>) -> UpdateChannel {
    match raw
        .unwrap_or_else(|| "stable".to_string())
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "nightly" | "beta" => UpdateChannel::Nightly,
        _ => UpdateChannel::Stable,
    }
}

fn normalize_version(raw: &str) -> String {
    let s = raw.trim();
    if let Some(rest) = s.strip_prefix("nightly-v") {
        if let Some(idx) = rest.rfind('-') {
            return rest[..idx].to_string();
        }
        return rest.to_string();
    }
    s.trim_start_matches('v').to_string()
}

fn version_is_newer(current: &str, latest: &str) -> bool {
    match (Version::parse(current), Version::parse(latest)) {
        (Ok(c), Ok(l)) => l > c,
        _ => false,
    }
}

fn preferred_asset_score(name: &str) -> i32 {
    let lower = name.to_ascii_lowercase();
    if cfg!(target_os = "windows") {
        if lower.ends_with(".msi") { return 100; }
        if lower.ends_with(".exe") { return 90; }
        if lower.contains("nsis") { return 80; }
    }

    if cfg!(target_os = "linux") {
        let has_pacman = std::process::Command::new("which")
            .arg("pacman")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        let has_dpkg = std::process::Command::new("which")
            .arg("dpkg")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        let has_rpm = std::process::Command::new("which")
            .arg("rpm")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);

        if has_pacman && lower.ends_with(".pacman") { return 100; }
        if has_dpkg && lower.ends_with(".deb") { return 100; }
        if has_rpm && lower.ends_with(".rpm") { return 100; }
        if lower.ends_with(".appimage") { return 50; }
    }

    if cfg!(target_os = "macos") {
        if lower.ends_with(".dmg") { return 100; }
        if lower.ends_with(".app.tar.gz") { return 90; }
    }

    1
}

fn downloads_dir() -> Result<PathBuf, String> {
    if cfg!(target_os = "windows") {
        if let Ok(base) = env::var("USERPROFILE") {
            return Ok(PathBuf::from(base).join("Downloads"));
        }
    } else if let Ok(base) = env::var("HOME") {
        return Ok(PathBuf::from(base).join("Downloads"));
    }

    env::current_dir()
        .map_err(|e| e.to_string())
        .map(|p| p.join("downloads"))
}

async fn fetch_latest_release() -> Result<Value, String> {
    let owner = updater_repo_owner();
    let repo = updater_repo_name();
    let url = format!(
        "https://api.github.com/repos/{}/{}/releases/latest",
        owner, repo
    );

    let client = reqwest::Client::new();
    let response = client
        .get(url)
        .header(reqwest::header::USER_AGENT, "verdant-desktop-updater")
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("GitHub release lookup failed: {} {}", status, body));
    }

    response.json::<Value>().await.map_err(|e| e.to_string())
}

async fn fetch_latest_nightly_release() -> Result<Value, String> {
    let owner = updater_repo_owner();
    let repo = updater_repo_name();
    let url = format!(
        "https://api.github.com/repos/{}/{}/releases?per_page=30",
        owner, repo
    );

    let client = reqwest::Client::new();
    let response = client
        .get(url)
        .header(reqwest::header::USER_AGENT, "verdant-desktop-updater")
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "GitHub nightly release lookup failed: {} {}",
            status, body
        ));
    }

    let releases = response.json::<Value>().await.map_err(|e| e.to_string())?;
    let Some(items) = releases.as_array() else {
        return Err("Unexpected nightly releases response".to_string());
    };

    for release in items {
        let is_prerelease = release
            .get("prerelease")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let is_draft = release
            .get("draft")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let has_assets = release
            .get("assets")
            .and_then(Value::as_array)
            .map(|a| !a.is_empty())
            .unwrap_or(false);

        if is_prerelease && !is_draft && has_assets {
            return Ok(release.clone());
        }
    }

    Err("No nightly prerelease with assets found".to_string())
}

async fn fetch_release_for_channel(channel: UpdateChannel) -> Result<Value, String> {
    match channel {
        UpdateChannel::Stable => fetch_latest_release().await,
        UpdateChannel::Nightly => fetch_latest_nightly_release().await,
    }
}

fn select_best_asset(release: &Value) -> Result<(String, String), String> {
    let assets = release
        .get("assets")
        .and_then(Value::as_array)
        .ok_or_else(|| "Release has no assets".to_string())?;

    let mut chosen_name = String::new();
    let mut chosen_url = String::new();
    let mut best_score = -1;

    for asset in assets {
        let Some(name) = asset.get("name").and_then(Value::as_str) else {
            continue;
        };
        let Some(url) = asset
            .get("browser_download_url")
            .and_then(Value::as_str)
        else {
            continue;
        };
        let score = preferred_asset_score(name);
        if score > best_score {
            best_score = score;
            chosen_name = name.to_string();
            chosen_url = url.to_string();
        }
    }

    if chosen_url.is_empty() {
        return Err("No downloadable release asset found".to_string());
    }

    Ok((chosen_name, chosen_url))
}

#[tauri::command]
pub async fn check_for_updates(channel: Option<String>) -> Result<UpdateInfo, String> {
    let channel = parse_update_channel(channel);
    let current_version = normalize_version(env!("CARGO_PKG_VERSION"));
    let release = fetch_release_for_channel(channel).await?;

    let latest_tag = release
        .get("tag_name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    let latest_version = normalize_version(&latest_tag);

    let update_available = version_is_newer(&current_version, &latest_version);
    
    let release_name = release
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let published_at = release
        .get("published_at")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let notes = release
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    let (download_asset_name, download_url) = select_best_asset(&release)?;

    Ok(UpdateInfo {
        current_version,
        latest_version,
        release_name,
        published_at,
        notes,
        update_available,
        download_asset_name,
        download_url,
    })
}

#[tauri::command]
pub async fn download_latest_update(channel: Option<String>) -> Result<UpdateDownloadResult, String> {
    let info = check_for_updates(channel).await?;
    if !info.update_available {
        return Err("No update available".to_string());
    }

    let client = reqwest::Client::new();
    let response = client
        .get(&info.download_url)
        .header(reqwest::header::USER_AGENT, "verdant-desktop-updater")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Update download failed: {} {}", status, body));
    }

    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    let folder = downloads_dir()?;
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let file_path = folder.join(&info.download_asset_name);
    std::fs::write(&file_path, &bytes).map_err(|e| e.to_string())?;

    Ok(UpdateDownloadResult {
        file_path: file_path.to_string_lossy().to_string(),
        file_name: info.download_asset_name,
        version: info.latest_version,
    })
}

#[tauri::command]
pub async fn install_and_relaunch(file_path: String) -> Result<(), String> {
    let name = std::path::Path::new(&file_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    install_update_sync(&file_path, &name)?;
    Ok(())
}

fn install_update_sync(path: &str, name: &str) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        if name.ends_with(".pacman") || name.ends_with(".pkg.tar.zst") {
            let status = std::process::Command::new("pkexec")
                .args(["/usr/bin/pacman", "-U", "--noconfirm", path])
                .status()
                .map_err(|e| format!("Failed to launch pacman: {}", e))?;
            if !status.success() {
                return Err(format!("pacman exited with status: {}", status));
            }
            return Ok(());
        }

        if name.ends_with(".deb") {
            let status = std::process::Command::new("pkexec")
                .args(["apt-get", "install", "-y", path])
                .status();
            let ok = match status {
                Ok(s) => s.success(),
                Err(_) => false,
            };
            if !ok {
                let s = std::process::Command::new("pkexec")
                    .args(["dpkg", "-i", path])
                    .status()
                    .map_err(|e| format!("Failed to launch dpkg: {}", e))?;
                if !s.success() {
                    return Err(format!("dpkg exited with status: {}", s));
                }
            }
            return Ok(());
        }

        if name.ends_with(".rpm") {
            let status = std::process::Command::new("pkexec")
                .args(["dnf", "install", "-y", path])
                .status();
            let ok = match status {
                Ok(s) => s.success(),
                Err(_) => false,
            };
            if !ok {
                let s = std::process::Command::new("pkexec")
                    .args(["rpm", "-U", path])
                    .status()
                    .map_err(|e| format!("Failed to launch rpm: {}", e))?;
                if !s.success() {
                    return Err(format!("rpm exited with status: {}", s));
                }
            }
            return Ok(());
        }

        if name.ends_with(".appimage") {
            std::fs::set_permissions(
                path,
                std::os::unix::fs::PermissionsExt::from_mode(0o755),
            )
            .map_err(|e| e.to_string())?;
            let current = std::env::current_exe().map_err(|e| e.to_string())?;
            std::fs::copy(path, &current).map_err(|e| e.to_string())?;
            return Ok(());
        }
    }

    #[cfg(target_os = "windows")]
    {
        if name.ends_with(".exe") || name.ends_with(".msi") {
            std::process::Command::new("powershell")
                .args([
                    "-Command",
                    &format!("Start-Process -FilePath '{}' -Verb RunAs -Wait", path),
                ])
                .spawn()
                .map_err(|e| format!("Failed to launch installer: {}", e))?;
            return Ok(());
        }
    }

    #[cfg(target_os = "macos")]
    {
        if name.ends_with(".dmg") {
            open::that(path).map_err(|e| e.to_string())?;
            return Ok(());
        }
    }

    Err(format!("No installer handler for: {}", name))
}
