use crate::agent::{AgentAdapter, PiAdapter, StreamEvent, get_agent};
use crate::dispatch::{StreamAccumulator, StreamSender, truncate_draft};
use crate::telegram::{
    Contact, Dice, Document, Location, Message, Poll, PollOption, Venue, Voice,
    extract_attachments, extract_structured_data, get_msg_type, is_group_chat,
};
use std::sync::{Arc, Mutex};

// Test get_agent registry
#[test]
fn test_get_agent() {
    let agent = get_agent("pi").unwrap();
    assert_eq!(agent.name(), "pi");

    let err = get_agent("unknown");
    assert!(err.is_err());
}

// Test Pi stream event parsing
#[test]
fn test_pi_adapter_parse_delta() {
    let adapter = PiAdapter;
    let json = serde_json::json!({
        "type": "message_update",
        "assistantMessageEvent": {
            "type": "text_delta",
            "delta": "world"
        }
    });

    let event = adapter.parse_stream_event(json).unwrap();
    assert_eq!(
        event,
        StreamEvent::Delta {
            text: "world".to_string()
        }
    );
}

#[test]
fn test_pi_adapter_parse_final() {
    let adapter = PiAdapter;
    let json = serde_json::json!({
        "type": "message_end",
        "message": {
            "role": "assistant",
            "content": [
                {
                    "type": "text",
                    "text": "done"
                }
            ]
        }
    });

    let event = adapter.parse_stream_event(json).unwrap();
    assert_eq!(
        event,
        StreamEvent::Final {
            text: "done".to_string()
        }
    );
}

// Test truncate_draft
#[test]
fn test_truncate_draft_within_limit() {
    let text = "short text";
    assert_eq!(truncate_draft(text), "short text");
}

#[test]
fn test_truncate_draft_at_newline() {
    let a_part = "a".repeat(2000);
    let b_part = "b".repeat(2100);
    let text = format!("{}\n{}", a_part, b_part);
    let result = truncate_draft(&text);
    assert_eq!(result, format!("...\n{}", b_part));
}

#[test]
fn test_truncate_draft_fallback_no_newline() {
    let text = "a".repeat(5000);
    let result = truncate_draft(&text);
    let expected = format!("...{}", "a".repeat(4096 - 3));
    assert_eq!(result, expected);
}

// Test StreamAccumulator
struct MockSender {
    calls: Arc<Mutex<Vec<String>>>,
    throttle: u64,
}

impl StreamSender for MockSender {
    fn throttle_ms(&self) -> u64 {
        self.throttle
    }

    async fn update(&mut self, text: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.calls.lock().unwrap().push(text.to_string());
        Ok(())
    }
}

#[tokio::test]
async fn test_stream_accumulator_throttling() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let sender = MockSender {
        calls: calls.clone(),
        throttle: 500, // 500ms
    };

    let mut accumulator = StreamAccumulator::new(sender, 500);

    // First append should flush immediately because last_sent_at is initialized in the past
    accumulator.append("hello").await.unwrap();
    assert_eq!(calls.lock().unwrap().len(), 1);
    assert_eq!(calls.lock().unwrap()[0], "hello");

    // Second append is within 500ms and < 500 growth chars, so it should be buffered
    accumulator.append(" world").await.unwrap();
    assert_eq!(calls.lock().unwrap().len(), 1); // no new dispatch

    // Final flush should send remaining buffered content
    accumulator.flush_remaining().await.unwrap();
    assert_eq!(calls.lock().unwrap().len(), 2);
    assert_eq!(calls.lock().unwrap()[1], "hello world");
    assert_eq!(accumulator.result(), "hello world");
}

#[tokio::test]
async fn test_stream_accumulator_growth_threshold() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let sender = MockSender {
        calls: calls.clone(),
        throttle: 10000, // extremely high time throttle
    };

    let mut accumulator = StreamAccumulator::new(sender, 100);

    // Initial immediately sent
    accumulator.append("init").await.unwrap();
    assert_eq!(calls.lock().unwrap().len(), 1);

    // Append 50 chars (buffered)
    accumulator.append(&"a".repeat(50)).await.unwrap();
    assert_eq!(calls.lock().unwrap().len(), 1);

    // Append 60 more chars (exceeds 100 growth chars from last sent len = 4)
    accumulator.append(&"b".repeat(60)).await.unwrap();
    assert_eq!(calls.lock().unwrap().len(), 2); // flushed due to growth
}

// Test is_group_chat
#[test]
fn test_is_group_chat() {
    assert!(is_group_chat("group"));
    assert!(is_group_chat("supergroup"));
    assert!(!is_group_chat("private"));
}

// Helper to make a default blank message
fn blank_message() -> Message {
    Message {
        message_id: 1,
        from: None,
        chat: None,
        text: None,
        caption: None,
        reply_to_message: None,
        photo: None,
        document: None,
        audio: None,
        voice: None,
        video: None,
        sticker: None,
        location: None,
        venue: None,
        contact: None,
        poll: None,
        dice: None,
        entities: None,
    }
}

// Test get_msg_type
#[test]
fn test_get_msg_type() {
    let mut msg = blank_message();
    assert_eq!(get_msg_type(&msg), "other");

    msg.text = Some("hello".to_string());
    assert_eq!(get_msg_type(&msg), "text");

    msg.text = None;
    msg.photo = Some(vec![]);
    assert_eq!(get_msg_type(&msg), "other");

    msg.photo = Some(vec![crate::telegram::PhotoSize {
        file_id: "1".to_string(),
        file_unique_id: "1".to_string(),
        width: 10,
        height: 10,
        file_size: None,
    }]);
    assert_eq!(get_msg_type(&msg), "photo");

    msg.photo = None;
    msg.document = Some(Document {
        file_id: "1".to_string(),
        file_unique_id: "1".to_string(),
        file_name: Some("test.pdf".to_string()),
        mime_type: None,
        file_size: None,
    });
    assert_eq!(get_msg_type(&msg), "document(test.pdf)");
}

// Test extract_structured_data
#[test]
fn test_extract_structured_data() {
    let mut msg = blank_message();
    assert_eq!(extract_structured_data(&msg), "");

    msg.location = Some(Location {
        latitude: 37.7749,
        longitude: -122.4194,
    });
    assert_eq!(
        extract_structured_data(&msg),
        "[Location Shared]: Latitude 37.7749, Longitude -122.4194"
    );

    msg.location = None;
    msg.venue = Some(Venue {
        location: Location {
            latitude: 0.0,
            longitude: 0.0,
        },
        title: "Central Park".to_string(),
        address: "New York, NY".to_string(),
    });
    assert_eq!(
        extract_structured_data(&msg),
        "[Venue Shared]: Central Park (New York, NY)"
    );

    msg.venue = None;
    msg.contact = Some(Contact {
        phone_number: "+12345".to_string(),
        first_name: "John".to_string(),
        last_name: Some("Doe".to_string()),
    });
    assert_eq!(
        extract_structured_data(&msg),
        "[Contact Shared]: John Doe (+12345)"
    );

    msg.contact = None;
    msg.poll = Some(Poll {
        id: "1".to_string(),
        question: "Color?".to_string(),
        options: vec![
            PollOption {
                text: "Red".to_string(),
                voter_count: 0,
            },
            PollOption {
                text: "Blue".to_string(),
                voter_count: 0,
            },
        ],
    });
    assert_eq!(
        extract_structured_data(&msg),
        "[Poll Shared]: Color?\n- Red\n- Blue"
    );

    msg.poll = None;
    msg.dice = Some(Dice {
        emoji: "🎲".to_string(),
        value: 6,
    });
    assert_eq!(
        extract_structured_data(&msg),
        "[Dice Rolled]: Emoji 🎲, Value 6"
    );
}

// Test extract_attachments
#[test]
fn test_extract_attachments() {
    let mut msg = blank_message();
    let atts = extract_attachments(&msg);
    assert_eq!(atts.len(), 0);

    msg.photo = Some(vec![
        crate::telegram::PhotoSize {
            file_id: "small".to_string(),
            file_unique_id: "s".to_string(),
            width: 5,
            height: 5,
            file_size: None,
        },
        crate::telegram::PhotoSize {
            file_id: "large".to_string(),
            file_unique_id: "l".to_string(),
            width: 100,
            height: 100,
            file_size: None,
        },
    ]);
    let atts = extract_attachments(&msg);
    assert_eq!(atts.len(), 1);
    assert_eq!(atts[0].file_id, "large");
    assert_eq!(atts[0].file_name, "photo.jpg");

    msg.photo = None;
    msg.document = Some(Document {
        file_id: "doc1".to_string(),
        file_unique_id: "d1".to_string(),
        file_name: Some("resume.pdf".to_string()),
        mime_type: Some("application/pdf".to_string()),
        file_size: None,
    });
    let atts = extract_attachments(&msg);
    assert_eq!(atts.len(), 1);
    assert_eq!(atts[0].file_id, "doc1");
    assert_eq!(atts[0].file_name, "resume.pdf");

    msg.document = None;
    msg.voice = Some(Voice {
        file_id: "voice1".to_string(),
        file_unique_id: "v1".to_string(),
        duration: 5,
        mime_type: Some("audio/ogg".to_string()),
        file_size: None,
    });
    let atts = extract_attachments(&msg);
    assert_eq!(atts.len(), 1);
    assert_eq!(atts[0].file_id, "voice1");
    assert_eq!(atts[0].file_name, "voice.ogg");
}
