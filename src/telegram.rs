use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Deserialize, Debug, Clone)]
pub struct Update {
    pub update_id: i64,
    pub message: Option<Message>,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct Message {
    pub message_id: i32,
    pub from: Option<User>,
    pub chat: Option<Chat>,
    pub text: Option<String>,
    pub caption: Option<String>,
    pub reply_to_message: Option<Box<Message>>,
    pub photo: Option<Vec<PhotoSize>>,
    pub document: Option<Document>,
    pub audio: Option<Audio>,
    pub voice: Option<Voice>,
    pub video: Option<Video>,
    pub sticker: Option<Sticker>,
    pub location: Option<Location>,
    pub venue: Option<Venue>,
    pub contact: Option<Contact>,
    pub poll: Option<Poll>,
    pub dice: Option<Dice>,
    pub entities: Option<Vec<MessageEntity>>,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct User {
    pub id: i64,
    pub first_name: String,
    pub last_name: Option<String>,
    pub username: Option<String>,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct Chat {
    pub id: i64,
    #[serde(rename = "type")]
    pub chat_type: String,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct PhotoSize {
    pub file_id: String,
    pub file_unique_id: String,
    pub width: i32,
    pub height: i32,
    pub file_size: Option<i32>,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct Document {
    pub file_id: String,
    pub file_unique_id: String,
    pub file_name: Option<String>,
    pub mime_type: Option<String>,
    pub file_size: Option<i32>,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct Audio {
    pub file_id: String,
    pub file_unique_id: String,
    pub file_name: Option<String>,
    pub mime_type: Option<String>,
    pub file_size: Option<i32>,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct Voice {
    pub file_id: String,
    pub file_unique_id: String,
    pub duration: i32,
    pub mime_type: Option<String>,
    pub file_size: Option<i32>,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct Video {
    pub file_id: String,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct Sticker {
    pub file_id: String,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct Location {
    pub latitude: f64,
    pub longitude: f64,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct Venue {
    pub location: Location,
    pub title: String,
    pub address: String,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct Contact {
    pub phone_number: String,
    pub first_name: String,
    pub last_name: Option<String>,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct Poll {
    pub id: String,
    pub question: String,
    pub options: Vec<PollOption>,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct PollOption {
    pub text: String,
    pub voter_count: i32,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct Dice {
    pub emoji: String,
    pub value: i32,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct MessageEntity {
    #[serde(rename = "type")]
    pub entity_type: String,
    pub offset: i32,
    pub length: i32,
    pub text: Option<String>, // standard or calculated
    pub user: Option<User>,
}

#[derive(Deserialize, Debug, Clone)]
#[allow(dead_code)]
pub struct TelegramFile {
    pub file_id: String,
    pub file_path: Option<String>,
}

#[derive(Deserialize, Debug)]
#[allow(dead_code)]
pub struct TelegramResponse<T> {
    pub ok: bool,
    pub result: Option<T>,
    pub description: Option<String>,
}

pub struct AttachmentInfo {
    pub file_id: String,
    pub file_name: String,
}

pub fn is_group_chat(chat_type: &str) -> bool {
    chat_type == "group" || chat_type == "supergroup"
}

pub fn get_msg_type(message: &Message) -> String {
    if message.text.is_some() {
        "text".to_string()
    } else if message.photo.as_ref().is_some_and(|p| !p.is_empty()) {
        "photo".to_string()
    } else if let Some(doc) = &message.document {
        format!(
            "document({})",
            doc.file_name.as_deref().unwrap_or("<unknown>")
        )
    } else if message.video.is_some() {
        "video".to_string()
    } else if message.voice.is_some() {
        "voice".to_string()
    } else if message.audio.is_some() {
        "audio".to_string()
    } else if message.sticker.is_some() {
        "sticker".to_string()
    } else if message.location.is_some() {
        "location".to_string()
    } else if message.venue.is_some() {
        "venue".to_string()
    } else if message.contact.is_some() {
        "contact".to_string()
    } else if message.poll.is_some() {
        "poll".to_string()
    } else if message.dice.is_some() {
        "dice".to_string()
    } else if message.reply_to_message.is_some() {
        "reply".to_string()
    } else {
        "other".to_string()
    }
}

pub fn extract_structured_data(message: &Message) -> String {
    let mut parts = Vec::new();

    if let Some(loc) = &message.location {
        parts.push(format!(
            "[Location Shared]: Latitude {}, Longitude {}",
            loc.latitude, loc.longitude
        ));
    }
    if let Some(venue) = &message.venue {
        parts.push(format!(
            "[Venue Shared]: {} ({})",
            venue.title, venue.address
        ));
    }
    if let Some(contact) = &message.contact {
        let mut name_parts = Vec::new();
        name_parts.push(&contact.first_name);
        if let Some(last) = &contact.last_name {
            name_parts.push(last);
        }
        let name = name_parts
            .iter()
            .map(|s| s.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        parts.push(format!(
            "[Contact Shared]: {} ({})",
            name, contact.phone_number
        ));
    }
    if let Some(poll) = &message.poll {
        let options = poll
            .options
            .iter()
            .map(|o| format!("- {}", o.text))
            .collect::<Vec<_>>()
            .join("\n");
        parts.push(format!("[Poll Shared]: {}\n{}", poll.question, options));
    }
    if let Some(dice) = &message.dice {
        parts.push(format!(
            "[Dice Rolled]: Emoji {}, Value {}",
            dice.emoji, dice.value
        ));
    }

    parts.join("\n\n")
}

pub fn extract_attachments(message: &Message) -> Vec<AttachmentInfo> {
    let mut attachments = Vec::new();

    if let Some(largest) = message.photo.as_ref().and_then(|photos| photos.last()) {
        attachments.push(AttachmentInfo {
            file_id: largest.file_id.clone(),
            file_name: "photo.jpg".to_string(),
        });
    }

    if let Some(doc) = &message.document {
        let ext = mime_to_ext(doc.mime_type.as_deref(), "");
        let file_name = doc
            .file_name
            .clone()
            .unwrap_or_else(|| format!("document{}", ext));
        attachments.push(AttachmentInfo {
            file_id: doc.file_id.clone(),
            file_name,
        });
    }

    if let Some(audio) = &message.audio {
        let ext = mime_to_ext(audio.mime_type.as_deref(), ".mp3");
        let file_name = audio
            .file_name
            .clone()
            .unwrap_or_else(|| format!("audio{}", ext));
        attachments.push(AttachmentInfo {
            file_id: audio.file_id.clone(),
            file_name,
        });
    }

    if let Some(voice) = &message.voice {
        let ext = mime_to_ext(voice.mime_type.as_deref(), ".ogg");
        let file_name = format!("voice{}", ext);
        attachments.push(AttachmentInfo {
            file_id: voice.file_id.clone(),
            file_name,
        });
    }

    attachments
}

fn mime_to_ext(mime: Option<&str>, fallback: &str) -> String {
    match mime {
        None => fallback.to_string(),
        Some(m) => match m {
            "image/jpeg" => ".jpg".to_string(),
            "image/png" => ".png".to_string(),
            "image/gif" => ".gif".to_string(),
            "image/webp" => ".webp".to_string(),
            "audio/ogg" => ".ogg".to_string(),
            "audio/mpeg" => ".mp3".to_string(),
            "audio/mp4" => ".m4a".to_string(),
            "application/pdf" => ".pdf".to_string(),
            "text/plain" => ".txt".to_string(),
            _ => fallback.to_string(),
        },
    }
}

pub struct TelegramClient {
    token: String,
    client: reqwest::Client,
}

impl TelegramClient {
    pub fn new(token: String) -> Self {
        TelegramClient {
            token,
            client: reqwest::Client::new(),
        }
    }

    pub async fn get_updates(
        &self,
        offset: Option<i64>,
        timeout: Option<u64>,
    ) -> Result<Vec<Update>, reqwest::Error> {
        let url = format!("https://api.telegram.org/bot{}/getUpdates", self.token);
        let mut query = Vec::new();
        if let Some(o) = offset {
            query.push(("offset", o.to_string()));
        }
        if let Some(t) = timeout {
            query.push(("timeout", t.to_string()));
        }

        let resp: TelegramResponse<Vec<Update>> = self
            .client
            .get(&url)
            .query(&query)
            .send()
            .await?
            .json()
            .await?;

        Ok(resp.result.unwrap_or_default())
    }

    pub async fn get_file(&self, file_id: &str) -> Result<TelegramFile, reqwest::Error> {
        let url = format!("https://api.telegram.org/bot{}/getFile", self.token);
        let resp: TelegramResponse<TelegramFile> = self
            .client
            .post(&url)
            .json(&serde_json::json!({ "file_id": file_id }))
            .send()
            .await?
            .json()
            .await?;
        Ok(resp.result.unwrap())
    }

    pub async fn download_file(
        &self,
        file_path: &str,
        dest_path: &Path,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let url = format!(
            "https://api.telegram.org/file/bot{}/{}",
            self.token, file_path
        );
        let bytes = self.client.get(&url).send().await?.bytes().await?;
        tokio::fs::write(dest_path, bytes).await?;
        Ok(())
    }

    pub async fn send_message(
        &self,
        chat_id: i64,
        text: &str,
        reply_to_message_id: Option<i32>,
    ) -> Result<Message, reqwest::Error> {
        let url = format!("https://api.telegram.org/bot{}/sendMessage", self.token);
        let mut body = serde_json::json!({
            "chat_id": chat_id,
            "text": text,
        });
        if let Some(mid) = reply_to_message_id {
            body["reply_parameters"] = serde_json::json!({
                "message_id": mid,
                "allow_sending_without_reply": true,
            });
        }

        let resp: TelegramResponse<Message> = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .await?
            .json()
            .await?;
        Ok(resp.result.unwrap())
    }

    pub async fn edit_message_text(
        &self,
        chat_id: i64,
        message_id: i32,
        text: &str,
    ) -> Result<Message, reqwest::Error> {
        let url = format!("https://api.telegram.org/bot{}/editMessageText", self.token);
        let resp: TelegramResponse<Message> = self
            .client
            .post(&url)
            .json(&serde_json::json!({
                "chat_id": chat_id,
                "message_id": message_id,
                "text": text,
            }))
            .send()
            .await?
            .json()
            .await?;
        Ok(resp.result.unwrap())
    }

    pub async fn send_message_draft(
        &self,
        chat_id: i64,
        draft_id: i64,
        text: &str,
    ) -> Result<(), reqwest::Error> {
        let url = format!(
            "https://api.telegram.org/bot{}/sendMessageDraft",
            self.token
        );
        let _resp: serde_json::Value = self
            .client
            .post(&url)
            .json(&serde_json::json!({
                "chat_id": chat_id,
                "draft_id": draft_id,
                "text": text,
            }))
            .send()
            .await?
            .json()
            .await?;
        Ok(())
    }

    pub async fn send_chat_action(&self, chat_id: i64, action: &str) -> Result<(), reqwest::Error> {
        let url = format!("https://api.telegram.org/bot{}/sendChatAction", self.token);
        let _resp: serde_json::Value = self
            .client
            .post(&url)
            .json(&serde_json::json!({
                "chat_id": chat_id,
                "action": action,
            }))
            .send()
            .await?
            .json()
            .await?;
        Ok(())
    }
}
