use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum StreamEvent {
    Delta { text: String },
    Final { text: String },
}

#[derive(Deserialize, Debug)]
#[serde(tag = "type")]
pub enum PiStreamEvent {
    #[serde(rename = "message_end")]
    MessageEnd { message: PiMessage },
    #[serde(rename = "message_update")]
    MessageUpdate {
        #[serde(rename = "assistantMessageEvent")]
        assistant_message_event: PiAssistantMessageEvent,
    },
}

#[derive(Deserialize, Debug)]
pub struct PiMessage {
    pub role: String,
    pub content: Vec<PiContent>,
}

#[derive(Deserialize, Debug)]
pub struct PiContent {
    #[serde(rename = "type")]
    pub content_type: String,
    pub text: Option<String>,
}

#[derive(Deserialize, Debug)]
pub struct PiAssistantMessageEvent {
    #[serde(rename = "type")]
    pub event_type: String, // "text_delta"
    pub delta: String,
}

#[allow(dead_code)]
pub trait AgentAdapter {
    fn name(&self) -> &str;
    fn build_command(&self, stream: bool) -> (String, Vec<String>);
    fn parse_stream_event(&self, json: serde_json::Value) -> Option<StreamEvent>;
}

pub struct PiAdapter;

impl AgentAdapter for PiAdapter {
    fn name(&self) -> &str {
        "pi"
    }

    fn build_command(&self, stream: bool) -> (String, Vec<String>) {
        let cmd = "pi".to_string();
        let args = if stream {
            vec!["--mode".to_string(), "json".to_string(), "-p".to_string()]
        } else {
            vec!["-p".to_string()]
        };
        (cmd, args)
    }

    fn parse_stream_event(&self, json: serde_json::Value) -> Option<StreamEvent> {
        let pi_event: PiStreamEvent = serde_json::from_value(json).ok()?;
        match pi_event {
            PiStreamEvent::MessageEnd { message } => {
                if message.role == "assistant" {
                    message
                        .content
                        .iter()
                        .rev()
                        .find(|c| c.content_type == "text")
                        .and_then(|c| c.text.as_ref())
                        .map(|text| StreamEvent::Final { text: text.clone() })
                } else {
                    None
                }
            }
            PiStreamEvent::MessageUpdate {
                assistant_message_event,
            } => {
                if assistant_message_event.event_type == "text_delta" {
                    Some(StreamEvent::Delta {
                        text: assistant_message_event.delta,
                    })
                } else {
                    None
                }
            }
        }
    }
}

pub fn get_agent(name: &str) -> Result<Box<dyn AgentAdapter + Send + Sync>, String> {
    match name {
        "pi" => Ok(Box::new(PiAdapter)),
        _ => Err(format!("Unknown agent: {}", name)),
    }
}
