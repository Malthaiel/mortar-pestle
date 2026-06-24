//! Projects parser — ports `server/src/vault/projects.js::listProjects`.

use std::fs;
use std::path::PathBuf;
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::commands::vault::vault_root;

#[derive(Serialize, Debug)]
pub struct ProjectEntry {
    pub name: String,
    pub slug: String,
    pub status: Option<String>,
    pub mtime: f64,
    #[serde(rename = "indexPath", skip_serializing_if = "Option::is_none")]
    pub index_path: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct ProjectsOut {
    pub projects: Vec<ProjectEntry>,
}

fn projects_dir() -> PathBuf {
    PathBuf::from(format!("{}/Projects", vault_root()))
}

fn to_slug(name: &str) -> String {
    name.to_ascii_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
}

/// Minimal YAML-frontmatter `Status:` extractor matching `parseFrontmatter` for
/// this single field. Accepts `Status:` or `status:`, bare or quoted value.
fn parse_status(text: &str) -> Option<String> {
    if !text.starts_with("---") {
        return None;
    }
    let after = &text[3..];
    let end = after.find("\n---")?;
    let fm = &after[..end];
    for line in fm.split('\n') {
        let line = line.trim();
        if let Some(rest) = line
            .strip_prefix("Status:")
            .or_else(|| line.strip_prefix("status:"))
        {
            let v = rest.trim();
            if v.is_empty() {
                return None;
            }
            let v = v.trim_matches(|c| c == '"' || c == '\'');
            if v.is_empty() {
                return None;
            }
            return Some(v.to_string());
        }
    }
    None
}

fn mtime_ms(p: &PathBuf) -> f64 {
    fs::metadata(p)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

fn read_project(folder_name: &str) -> Option<ProjectEntry> {
    let folder_path = projects_dir().join(folder_name);
    let index_file = folder_path.join(format!("{}.md", folder_name));
    let mut status: Option<String> = None;
    let mut index_path: Option<String> = None;
    let mtime;
    if let Ok(text) = fs::read_to_string(&index_file) {
        status = parse_status(&text);
        index_path = Some(format!("Projects/{}/{}.md", folder_name, folder_name));
        mtime = mtime_ms(&index_file);
    } else {
        mtime = mtime_ms(&folder_path);
    }
    Some(ProjectEntry {
        name: folder_name.to_string(),
        slug: to_slug(folder_name),
        status,
        mtime,
        index_path,
    })
}

pub fn list_projects() -> ProjectsOut {
    let entries = match fs::read_dir(projects_dir()) {
        Ok(e) => e,
        Err(_) => return ProjectsOut { projects: vec![] },
    };
    let mut projects: Vec<ProjectEntry> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            read_project(&name)
        })
        .collect();
    projects.sort_by(|a, b| b.mtime.partial_cmp(&a.mtime).unwrap_or(std::cmp::Ordering::Equal));
    ProjectsOut { projects }
}
