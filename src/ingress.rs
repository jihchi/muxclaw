use crate::config::{
    get_app_config_path, get_config_dir, get_data_dir, get_message_dir, get_queue_completed_dir,
    get_queue_dir, get_queue_failed_dir,
};
use crate::telegram::{TelegramClient, extract_attachments, extract_structured_data, get_msg_type};
use std::collections::HashSet;
// Path and PathBuf are unused, std::path is not needed here

use std::process::Stdio;
use std::sync::Arc;
use tokio::process::Command;

pub async fn ingress() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let config = crate::config::load_config().await;
    let allowed_ids: HashSet<String> = config
        .allowed_users
        .iter()
        .map(|u| u.user_id.clone())
        .collect();

    if allowed_ids.is_empty() {
        eprintln!("Warning: No allowed users configured. All messages will be ignored.");
        eprintln!("Add users to {}", get_app_config_path().display());
    }

    let token = config.channels.telegram.token.clone();
    if token.is_empty() {
        eprintln!("Error: channels.telegram.token is not set in config.");
        eprintln!("Set it in {}", get_app_config_path().display());
        std::process::exit(1);
    }

    let client = Arc::new(TelegramClient::new(token));
    log_startup("ingress");
    println!(
        "[ingress] Allowed users: {}",
        allowed_ids.iter().cloned().collect::<Vec<_>>().join(", ")
    );
    println!("[ingress] Waiting for Telegram messages... (Ctrl-C to stop)");

    let mut offset: Option<i64> = None;

    loop {
        match client.get_updates(offset, Some(30)).await {
            Ok(updates) => {
                for update in updates {
                    offset = Some(update.update_id + 1);
                    if let Some(msg) = update.message {
                        let client_clone = client.clone();
                        let allowed_ids_clone = allowed_ids.clone();
                        tokio::spawn(async move {
                            if let Err(err) =
                                handle_message(client_clone, allowed_ids_clone, msg).await
                            {
                                eprintln!("[ingress] Error handling message: {}", err);
                            }
                        });
                    }
                }
            }
            Err(err) => {
                eprintln!("[ingress] Error polling updates: {}", err);
                tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
            }
        }
    }
}

async fn handle_message(
    client: Arc<TelegramClient>,
    allowed_ids: HashSet<String>,
    msg: crate::telegram::Message,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let user_id = msg.from.as_ref().map(|u| u.id);
    let chat_id = msg.chat.as_ref().map(|c| c.id);
    let message_id = msg.message_id;

    let is_allowed = user_id
        .map(|id| allowed_ids.contains(&id.to_string()))
        .unwrap_or(false);
    let is_missing_id = chat_id.is_none();

    let username = msg
        .from
        .as_ref()
        .and_then(|u| u.username.as_deref())
        .unwrap_or("(unknown)");

    let raw_text = msg.text.as_deref().or(msg.caption.as_deref()).unwrap_or("");

    let structured_data = extract_structured_data(&msg);
    let text = if !structured_data.is_empty() {
        format!("{}\n\n{}", raw_text, structured_data)
            .trim()
            .to_string()
    } else {
        raw_text.trim().to_string()
    };

    let attachments = extract_attachments(&msg);
    let msg_type = get_msg_type(&msg);

    let quote = msg
        .reply_to_message
        .as_ref()
        .and_then(|m| m.text.as_deref().or(m.caption.as_deref()))
        .unwrap_or("");

    let mut details = vec![format!("type={}", msg_type)];
    if !text.is_empty() {
        details.push(format!("text={}", text));
    }
    if !quote.is_empty() {
        details.push(format!("quote={}", quote));
    }
    if !attachments.is_empty() {
        details.push(format!("attachments={}", attachments.len()));
    }

    println!(
        "[ingress] Message from {} ({:?}): {}",
        username,
        user_id
            .map(|id| id.to_string())
            .unwrap_or_else(|| "None".to_string()),
        details.join(", ")
    );

    if is_missing_id || !is_allowed || (text.is_empty() && attachments.is_empty()) {
        let status_icon = if is_missing_id {
            "⚠️"
        } else if !is_allowed {
            "⛔️"
        } else {
            "✅"
        };
        println!(
            "[ingress] {} Disallowed, malformed or empty message, skipping it",
            status_icon
        );
        return Ok(());
    }

    let chat_id = chat_id.unwrap();
    let _ = client.send_chat_action(chat_id, "typing").await;

    let channel = "telegram";
    let source_id = format!("{}_{}", chat_id, message_id);

    let mut prompt = text.clone();
    if !quote.is_empty() {
        prompt = format!("Quote:\n{}\n\n{}", quote, prompt);
    }

    let meta = serde_json::json!({
        "channel": channel,
        "chatId": chat_id,
        "messageId": message_id,
        "userId": user_id,
        "chatType": msg.chat.as_ref().map(|c| c.chat_type.as_str()).unwrap_or("private")
    });

    let message_dir = get_message_dir(channel, &source_id);
    tokio::fs::create_dir_all(&message_dir).await?;
    tokio::fs::write(message_dir.join("prompt.txt"), &prompt).await?;
    tokio::fs::write(
        message_dir.join("meta.json"),
        serde_json::to_string_pretty(&meta)?,
    )
    .await?;

    let mut attachment_paths = Vec::new();
    if !attachments.is_empty() {
        let attach_dir = message_dir.join("attachments");
        tokio::fs::create_dir_all(&attach_dir).await?;

        for attach in attachments {
            match client.get_file(&attach.file_id).await {
                Ok(file) => {
                    if let Some(file_path) = file.file_path {
                        let dest_path = attach_dir.join(&attach.file_name);
                        match client.download_file(&file_path, &dest_path).await {
                            Ok(_) => {
                                attachment_paths.push(dest_path);
                                println!("[ingress] Downloaded attachment: {}", attach.file_name);
                            }
                            Err(err) => {
                                eprintln!(
                                    "[ingress] Failed to download attachment {}: {}",
                                    attach.file_name, err
                                );
                            }
                        }
                    }
                }
                Err(err) => {
                    eprintln!(
                        "[ingress] Failed to get file path for attachment {}: {}",
                        attach.file_name, err
                    );
                }
            }
        }

        if attachment_paths.is_empty() {
            let _ = tokio::fs::remove_dir_all(&attach_dir).await;
            if text.is_empty() {
                let _ = tokio::fs::remove_dir_all(&message_dir).await;
                return Ok(());
            }
        }
    }

    if !attachment_paths.is_empty() {
        let list = attachment_paths
            .iter()
            .enumerate()
            .map(|(i, p)| format!("{}. @{}", i + 1, p.display()))
            .collect::<Vec<_>>()
            .join("\n");
        prompt = format!("Attachments:\n{}\n\n{}", list, prompt)
            .trim()
            .to_string();
        tokio::fs::write(message_dir.join("prompt.txt"), &prompt).await?;
    }

    let _ = client.send_chat_action(chat_id, "typing").await;

    // Enqueue via nq
    let current_exe = std::env::current_exe()?;
    let dispatch_id = format!("{}:{}", channel, source_id);

    let nq_child = Command::new("nq")
        .args([
            current_exe.to_str().unwrap(),
            "dispatch",
            "--id",
            &dispatch_id,
        ])
        .env("NQDIR", get_queue_dir())
        .env("NQDONEDIR", get_queue_completed_dir())
        .env("NQFAILDIR", get_queue_failed_dir())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    let output = nq_child.wait_with_output().await?;
    let job_file = String::from_utf8_lossy(&output.stdout).trim().to_string();

    if job_file.is_empty() || !output.status.success() {
        eprintln!(
            "[ingress] nq failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        return Ok(());
    }

    // Link job file to message directory
    let job_link = get_data_dir().join(format!("{}.d", job_file));
    #[cfg(unix)]
    {
        if job_link.exists() || job_link.is_symlink() {
            let _ = tokio::fs::remove_file(&job_link).await;
        }
        if let Err(err) = tokio::fs::symlink(&message_dir, &job_link).await {
            eprintln!(
                "[ingress] Failed to create symlink {} -> {}: {}",
                job_link.display(),
                message_dir.display(),
                err
            );
        }
    }

    println!(
        "[ingress] Queued: {} from user {:?}, --id={}",
        job_file, user_id, dispatch_id
    );

    Ok(())
}

fn log_startup(label: &str) {
    println!("[{}] config={}", label, get_config_dir().display());
    println!("[{}] data={}", label, get_data_dir().display());
    println!("[{}] queue={}", label, get_queue_dir().display());
}
