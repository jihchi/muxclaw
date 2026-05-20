use crate::config::{
    get_app_config_path, get_data_dir, get_queue_completed_dir, get_queue_failed_dir,
};
use crate::telegram::{TelegramClient, is_group_chat};
use notify::{Config as NotifyConfig, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Deserialize;
use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;
use tokio::sync::mpsc;

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct JobMeta {
    pub channel: String,
    pub chat_id: i64,
    pub message_id: i32,
    pub user_id: Option<i64>,
    pub chat_type: Option<String>,
}

pub async fn egress() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let config = crate::config::load_config().await;
    let token = config.channels.telegram.token.clone();
    if token.is_empty() {
        eprintln!("Error: channels.telegram.token is not set in config.");
        eprintln!("Set it in {}", get_app_config_path().display());
        std::process::exit(1);
    }

    let bot = Arc::new(TelegramClient::new(token));
    log_startup("egress");

    let completed_dir = get_queue_completed_dir();
    let failed_dir = get_queue_failed_dir();

    // Process any jobs that completed while react was not running
    scan_and_process(&completed_dir, &bot).await?;
    scan_and_process(&failed_dir, &bot).await?;

    println!("[egress] Watching for completed/failed jobs... (Ctrl-C to stop)");

    let (tx, mut rx) = mpsc::channel(100);

    let mut watcher = RecommendedWatcher::new(
        move |res| {
            if let Ok(event) = res {
                let _ = tx.blocking_send(event);
            }
        },
        NotifyConfig::default(),
    )?;

    watcher.watch(&completed_dir, RecursiveMode::NonRecursive)?;
    watcher.watch(&failed_dir, RecursiveMode::NonRecursive)?;

    let mut processing = HashSet::new();

    while let Some(event) = rx.recv().await {
        // We only care about create/modify events
        if event.kind.is_access() || event.kind.is_other() {
            continue;
        }

        for path in event.paths {
            let file_name = match path.file_name().and_then(|s| s.to_str()) {
                Some(name) => name,
                None => continue,
            };

            if !file_name.starts_with(',') {
                continue;
            }

            if processing.contains(file_name) {
                continue;
            }

            let job_dir = get_data_dir().join(format!("{}.d", file_name));
            let meta_path = job_dir.join("meta.json");

            if !path.exists() || !meta_path.exists() {
                continue;
            }

            processing.insert(file_name.to_string());
            let parent = match path.parent() {
                Some(p) => p.to_path_buf(),
                None => {
                    processing.remove(file_name);
                    continue;
                }
            };

            let bot_clone = bot.clone();
            let file_name_clone = file_name.to_string();

            if let Err(err) = process_job(&parent, &file_name_clone, &bot_clone).await {
                eprintln!("[egress] Error processing {}: {}", file_name_clone, err);
            }
            processing.remove(&file_name_clone);
        }
    }

    Ok(())
}

async fn scan_and_process(
    scan_dir: &Path,
    bot: &TelegramClient,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if !scan_dir.exists() {
        return Ok(());
    }

    let mut entries = tokio::fs::read_dir(scan_dir).await?;
    let mut jobs = Vec::new();

    while let Some(entry) = entries.next_entry().await? {
        let file_type = entry.file_type().await?;
        if file_type.is_file() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(',') {
                jobs.push(name);
            }
        }
    }

    jobs.sort();

    for name in jobs {
        if let Err(err) = process_job(scan_dir, &name, bot).await {
            eprintln!("[egress] Error processing {}: {}", name, err);
        }
    }

    Ok(())
}

pub async fn process_job(
    scan_dir: &Path,
    job_name: &str,
    bot: &TelegramClient,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let log_path = scan_dir.join(job_name);
    let job_dir = get_data_dir().join(format!("{}.d", job_name));
    let meta_path = job_dir.join("meta.json");

    let meta_content = tokio::fs::read_to_string(&meta_path).await?;
    let meta: JobMeta = serde_json::from_str(&meta_content)?;

    let config = crate::config::load_config().await;
    let chat_type = meta.chat_type.as_deref().unwrap_or("private");
    let already_streamed = config.agent.stream && is_group_chat(chat_type);

    if already_streamed {
        println!(
            "[egress] Skipping send for {} (already streamed to group)",
            job_name
        );
    } else {
        let raw = tokio::fs::read_to_string(&log_path)
            .await?
            .trim()
            .to_string();
        let first_nl = raw.find('\n');
        let last_nl = raw.rfind('\n');
        let output = if let (Some(f), Some(l)) = (first_nl, last_nl) {
            if f != l {
                raw[f + 1..l].trim().to_string()
            } else {
                raw.clone()
            }
        } else {
            raw.clone()
        };

        if output.is_empty() {
            println!("[egress] Empty output for {}, skipping", job_name);
            return Ok(());
        }

        let _ = bot.send_chat_action(meta.chat_id, "typing").await;
        send_split_message(bot, meta.chat_id, &output, meta.message_id).await?;
    }

    store_mark_processed(scan_dir, job_name).await?;
    println!(
        "[egress] Sent response for {} to chat {}",
        job_name, meta.chat_id
    );

    Ok(())
}

async fn send_split_message(
    bot: &TelegramClient,
    chat_id: i64,
    text: &str,
    reply_to_message_id: i32,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut remaining = text.to_string();

    while remaining.len() > 4096 {
        let chars: Vec<char> = remaining.chars().collect();
        if chars.len() > 4096 {
            let mut split_index = 4096;
            for i in (0..=4096).rev() {
                if chars[i] == '\n' {
                    split_index = i;
                    break;
                }
            }
            let chunk: String = chars[0..split_index].iter().collect();
            let chunk = chunk.trim();
            if !chunk.is_empty() {
                let _ = bot
                    .send_message(chat_id, chunk, Some(reply_to_message_id))
                    .await?;
            }
            remaining = chars[split_index..]
                .iter()
                .collect::<String>()
                .trim()
                .to_string();
        } else {
            break;
        }
    }

    if !remaining.is_empty() {
        let _ = bot
            .send_message(chat_id, &remaining, Some(reply_to_message_id))
            .await?;
    }

    Ok(())
}

async fn store_mark_processed(scan_dir: &Path, job_file: &str) -> std::io::Result<()> {
    let log_path = scan_dir.join(job_file);
    let job_dir = get_data_dir().join(format!("{}.d", job_file));
    let dest_path = job_dir.join(job_file);

    tokio::fs::create_dir_all(&job_dir).await?;
    tokio::fs::rename(log_path, dest_path).await?;

    let job_link = get_data_dir().join(format!("{}.d", job_file));
    #[cfg(unix)]
    {
        if tokio::fs::symlink_metadata(&job_link)
            .await
            .map(|m| m.is_symlink())
            .unwrap_or(false)
        {
            let _ = tokio::fs::remove_file(&job_link).await;
        }
    }

    Ok(())
}

fn log_startup(label: &str) {
    println!(
        "[{}] config={}",
        label,
        crate::config::get_config_dir().display()
    );
    println!("[{}] data={}", label, get_data_dir().display());
    println!(
        "[{}] queue={}",
        label,
        crate::config::get_queue_dir().display()
    );
}
