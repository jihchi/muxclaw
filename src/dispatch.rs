use crate::config::{get_message_dir, get_workspace_dir, load_config, validate_workspace};
use crate::telegram::{TelegramClient, is_group_chat};
use futures_util::StreamExt;
// Path and PathBuf are unused, std::path is not needed here

use std::process::Stdio;
use std::sync::Arc;
use tokio::process::Command;
use tokio_util::codec::{FramedRead, LinesCodec};

pub trait StreamSender {
    fn throttle_ms(&self) -> u64;
    fn update(
        &mut self,
        text: &str,
    ) -> impl std::future::Future<Output = Result<(), Box<dyn std::error::Error + Send + Sync>>> + Send;
}

pub struct EditSender {
    pub bot: Arc<TelegramClient>,
    pub chat_id: i64,
    pub message_id: i32,
}

impl StreamSender for EditSender {
    fn throttle_ms(&self) -> u64 {
        3000
    }

    async fn update(&mut self, text: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.bot
            .edit_message_text(self.chat_id, self.message_id, &truncate_draft(text))
            .await?;
        Ok(())
    }
}

pub struct DraftSender {
    pub bot: Arc<TelegramClient>,
    pub chat_id: i64,
    pub draft_id: i64,
}

impl StreamSender for DraftSender {
    fn throttle_ms(&self) -> u64 {
        500
    }

    async fn update(&mut self, text: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.bot
            .send_message_draft(self.chat_id, self.draft_id, &truncate_draft(text))
            .await?;
        Ok(())
    }
}

pub struct StreamAccumulator<S: StreamSender> {
    sender: S,
    pile: String,
    final_text: String,
    last_sent_at: tokio::time::Instant,
    last_sent_len: usize,
    has_unsent_draft: bool,
    growth_chars: usize,
}

impl<S: StreamSender> StreamAccumulator<S> {
    pub fn new(sender: S, growth_chars: usize) -> Self {
        StreamAccumulator {
            sender,
            pile: String::new(),
            final_text: String::new(),
            // Start in the past so the first update is sent immediately
            last_sent_at: tokio::time::Instant::now() - tokio::time::Duration::from_secs(10),
            last_sent_len: 0,
            has_unsent_draft: false,
            growth_chars,
        }
    }

    pub fn set_final(&mut self, text: String) {
        self.final_text = text;
    }

    pub fn result(&self) -> String {
        if !self.final_text.is_empty() {
            self.final_text.clone()
        } else {
            self.pile.clone()
        }
    }

    pub async fn append(
        &mut self,
        text: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.pile.push_str(text);
        self.has_unsent_draft = true;
        if self.should_send() {
            self.flush().await?;
        }
        Ok(())
    }

    fn should_send(&self) -> bool {
        let now = tokio::time::Instant::now();
        let elapsed = now.duration_since(self.last_sent_at).as_millis() as u64;
        let has_waited_long_enough = elapsed >= self.sender.throttle_ms();
        let has_grown_enough = self.pile.len() - self.last_sent_len >= self.growth_chars;
        has_waited_long_enough || has_grown_enough
    }

    pub async fn flush(&mut self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if self.pile.is_empty() {
            return Ok(());
        }
        self.sender.update(&self.pile).await?;
        self.last_sent_at = tokio::time::Instant::now();
        self.last_sent_len = self.pile.len();
        self.has_unsent_draft = false;
        Ok(())
    }

    pub async fn flush_remaining(
        &mut self,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if self.has_unsent_draft && !self.pile.is_empty() {
            self.flush().await?;
        }
        Ok(())
    }
}

pub fn truncate_draft(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= 4096 {
        return text.to_string();
    }

    let tail_len = 4096 - 6;
    let tail_start = chars.len() - tail_len;
    let tail_chars = &chars[tail_start..];

    // Find first newline in tail
    let first_newline_idx = tail_chars.iter().position(|&c| c == '\n');
    if let Some(idx) = first_newline_idx {
        let after_newline: String = tail_chars[idx + 1..].iter().collect();
        format!("...\n{}", after_newline)
    } else {
        let fallback_len = 4096 - 3;
        let fallback_start = chars.len() - fallback_len;
        let fallback_chars = &chars[fallback_start..];
        let after_start: String = fallback_chars.iter().collect();
        format!("...{}", after_start)
    }
}

pub async fn process_stream_output<S: StreamSender>(
    stdout: tokio::process::ChildStdout,
    sender: S,
    agent: &dyn crate::agent::AgentAdapter,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let mut accumulator = StreamAccumulator::new(sender, 500); // 500 growth characters threshold
    let mut reader = FramedRead::new(stdout, LinesCodec::new());

    while let Some(line_res) = reader.next().await {
        let line = match line_res {
            Ok(l) => l,
            Err(err) => {
                eprintln!("[dispatch] stream line read error: {}", err);
                continue;
            }
        };

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        if !trimmed.starts_with('{') {
            accumulator.append(&format!("{}\n", trimmed)).await?;
            continue;
        }

        match serde_json::from_str::<serde_json::Value>(trimmed) {
            Ok(json) => {
                if let Some(event) = agent.parse_stream_event(json) {
                    match event {
                        crate::agent::StreamEvent::Final { text } => {
                            accumulator.set_final(text);
                        }
                        crate::agent::StreamEvent::Delta { text } => {
                            accumulator.append(&text).await?;
                        }
                    }
                }
            }
            Err(err) => {
                eprintln!(
                    "[dispatch] Unrecognized JSON-like line, treating as text: {}. Line: {}",
                    err, line
                );
                accumulator.append(&format!("{}\n", trimmed)).await?;
            }
        }
    }

    accumulator.flush_remaining().await?;
    Ok(accumulator.result())
}

pub async fn dispatch(args: &[String]) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let config = load_config().await;
    validate_workspace(&config);
    let workspace = get_workspace_dir(&config);

    let adapter = crate::agent::get_agent(&config.agent.name)?;

    let prompt;
    let mut meta: Option<crate::egress::JobMeta> = None;

    let has_stdin = args.iter().any(|a| a == "--stdin");
    let has_id = args.iter().any(|a| a == "--id");

    if has_stdin {
        use tokio::io::AsyncReadExt;
        let mut buf = String::new();
        tokio::io::stdin().read_to_string(&mut buf).await?;
        prompt = buf.trim().to_string();
    } else if has_id {
        let idx = args.iter().position(|a| a == "--id").unwrap();
        let full_id = match args.get(idx + 1) {
            Some(id) => id,
            None => {
                eprintln!("Error: --id requires a <channel>:<id>.");
                std::process::exit(1);
            }
        };

        let parts: Vec<&str> = full_id.split(':').collect();
        if parts.len() != 2 {
            eprintln!("Error: --id format must be <channel>:<id>.");
            std::process::exit(1);
        }

        let channel = parts[0];
        let id = parts[1];

        let message_dir = get_message_dir(channel, id);
        let prompt_path = message_dir.join("prompt.txt");
        let meta_path = message_dir.join("meta.json");

        if !prompt_path.exists() {
            eprintln!("Error: message not found: {}", full_id);
            std::process::exit(1);
        }

        prompt = tokio::fs::read_to_string(&prompt_path)
            .await?
            .trim()
            .to_string();

        if !meta_path.exists() {
            eprintln!(
                "Error: job metadata invalid or not found: {}",
                meta_path.display()
            );
            std::process::exit(1);
        }

        let meta_content = tokio::fs::read_to_string(&meta_path).await?;
        match serde_json::from_str(&meta_content) {
            Ok(m) => meta = Some(m),
            Err(_) => {
                eprintln!(
                    "Error: job metadata invalid or not found: {}",
                    meta_path.display()
                );
                std::process::exit(1);
            }
        }
    } else {
        prompt = args.join(" ").trim().to_string();
        if prompt.is_empty() {
            eprintln!("Error: no message provided.");
            eprintln!("Usage: muxclaw dispatch <message> | --stdin | --id <channel>:<id>");
            std::process::exit(1);
        }
    }

    let stream = if has_id { config.agent.stream } else { false };
    let (agent_cmd, agent_args) = adapter.build_command(stream);

    let mut child = Command::new(&agent_cmd)
        .args(&agent_args)
        .current_dir(&workspace)
        .stdin(Stdio::piped())
        .stdout(if stream {
            Stdio::piped()
        } else {
            Stdio::inherit()
        })
        .stderr(Stdio::inherit())
        .spawn()?;

    if let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        stdin.write_all(format!("{}\n", prompt).as_bytes()).await?;
        stdin.flush().await?;
        drop(stdin);
    }

    if let (true, Some(m)) = (stream, &meta) {
        let bot = Arc::new(TelegramClient::new(config.channels.telegram.token.clone()));
        let is_group = is_group_chat(m.chat_type.as_deref().unwrap_or("private"));

        if is_group {
            let seed = bot
                .send_message(m.chat_id, "(💬 processing...)", Some(m.message_id))
                .await?;
            let sender = EditSender {
                bot,
                chat_id: m.chat_id,
                message_id: seed.message_id,
            };
            let stdout = child.stdout.take().unwrap();
            let final_result = process_stream_output(stdout, sender, adapter.as_ref()).await?;
            println!("{}", final_result);
        } else {
            let draft_id = tokio::time::Instant::now().elapsed().as_millis() as i64;
            if let Err(err) = bot
                .send_message_draft(m.chat_id, draft_id, "(💬 processing...)")
                .await
            {
                eprintln!("[dispatch] initial sendMessageDraft failed: {}", err);
            }
            let sender = DraftSender {
                bot,
                chat_id: m.chat_id,
                draft_id,
            };
            let stdout = child.stdout.take().unwrap();
            let final_result = process_stream_output(stdout, sender, adapter.as_ref()).await?;
            println!("{}", final_result);
        }

        let status = child.wait().await?;
        if !status.success() {
            std::process::exit(status.code().unwrap_or(1));
        }
        return Ok(());
    }

    let status = child.wait().await?;
    if !status.success() {
        std::process::exit(status.code().unwrap_or(1));
    }

    Ok(())
}
