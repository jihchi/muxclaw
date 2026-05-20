use serde::Deserialize;
use std::env;
use std::fs;
use std::path::PathBuf;

const APP_NAME: &str = "muxclaw";

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub channels: Channels,
    pub allowed_users: Vec<AllowedUser>,
    pub workspace: Option<String>,
    #[serde(default)]
    pub agent: AgentConfig,
}

#[derive(Deserialize, Debug, Clone)]
pub struct Channels {
    pub telegram: TelegramConfig,
}

#[derive(Deserialize, Debug, Clone)]
pub struct TelegramConfig {
    pub token: String,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AllowedUser {
    pub user_id: String,
}

#[derive(Deserialize, Debug, Clone)]
pub struct AgentConfig {
    #[serde(default = "default_agent_name")]
    pub name: String,
    #[serde(default = "default_false")]
    pub stream: bool,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            channels: Channels {
                telegram: TelegramConfig {
                    token: String::new(),
                },
            },
            allowed_users: Vec::new(),
            workspace: None,
            agent: AgentConfig::default(),
        }
    }
}

impl Default for AgentConfig {
    fn default() -> Self {
        AgentConfig {
            name: default_agent_name(),
            stream: default_false(),
        }
    }
}

fn default_agent_name() -> String {
    "pi".to_string()
}

fn default_false() -> bool {
    false
}

pub fn get_user_home() -> PathBuf {
    env::var("HOME")
        .map(PathBuf::from)
        .or_else(|_| env::var("USERPROFILE").map(PathBuf::from))
        .unwrap_or_else(|_| PathBuf::from("/tmp"))
}

pub fn get_config_dir() -> PathBuf {
    let home = get_user_home();
    let base = env::var("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home.join(".config"));
    base.join(APP_NAME)
}

pub fn get_data_dir() -> PathBuf {
    let home = get_user_home();
    let base = env::var("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home.join(".local").join("share"));
    base.join(APP_NAME)
}

pub fn get_state_dir() -> PathBuf {
    let home = get_user_home();
    let base = env::var("XDG_STATE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home.join(".local").join("state"));
    base.join(APP_NAME)
}

pub fn get_messages_dir() -> PathBuf {
    get_data_dir().join("messages")
}

pub fn get_app_config_path() -> PathBuf {
    get_config_dir().join("config.json")
}

pub fn get_queue_dir() -> PathBuf {
    env::var("NQDIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| get_state_dir().join("queue"))
}

pub fn get_queue_completed_dir() -> PathBuf {
    get_queue_dir().join("completed")
}

pub fn get_queue_failed_dir() -> PathBuf {
    get_queue_dir().join("failed")
}

pub fn get_message_dir(channel: &str, id: &str) -> PathBuf {
    get_messages_dir().join(channel).join(id)
}

pub async fn load_config() -> Config {
    let path = get_app_config_path();
    match fs::read_to_string(&path) {
        Ok(content) => match serde_json::from_str(&content) {
            Ok(config) => config,
            Err(err) => {
                eprintln!("Error: Failed to load or parse {}: {}", path.display(), err);
                std::process::exit(1);
            }
        },
        Err(err) => {
            eprintln!("Error: Failed to load or parse {}: {}", path.display(), err);
            std::process::exit(1);
        }
    }
}

pub fn get_workspace_dir(config: &Config) -> PathBuf {
    match &config.workspace {
        None => env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
        Some(ws) => {
            if let Some(stripped) = ws.strip_prefix("~/") {
                get_user_home().join(stripped)
            } else {
                PathBuf::from(ws)
            }
        }
    }
}

pub fn validate_workspace(config: &Config) {
    let ws = get_workspace_dir(config);
    match fs::metadata(&ws) {
        Ok(meta) => {
            if !meta.is_dir() {
                eprintln!(
                    "Error: Workspace path is a file, not a directory: {}",
                    ws.display()
                );
                std::process::exit(1);
            }
        }
        Err(err) => {
            if err.kind() == std::io::ErrorKind::NotFound {
                eprintln!(
                    "Error: Workspace directory does not exist: {}",
                    ws.display()
                );
            } else {
                eprintln!(
                    "Error: Failed to access workspace {}: {}",
                    ws.display(),
                    err
                );
            }
            std::process::exit(1);
        }
    }
}

pub async fn ensure_dirs() -> Result<(), std::io::Error> {
    tokio::fs::create_dir_all(get_config_dir()).await?;
    tokio::fs::create_dir_all(get_data_dir()).await?;
    tokio::fs::create_dir_all(get_queue_completed_dir()).await?;
    tokio::fs::create_dir_all(get_queue_failed_dir()).await?;
    Ok(())
}
