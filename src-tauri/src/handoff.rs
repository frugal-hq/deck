// Frugal handoff blocks join sessions into chats; no model call is involved.
// The parsing itself lives beside the index that stores it: handoff_block, next_block,
// context_tokens, pick_origin and the handoff.check.js tests are in index.rs.

use crate::chat::Chats;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

// main.js:396-402: every live end_turn comes as an entry without a prompt; a handoff block adds one with it.
pub fn offer_handoffs(app: &AppHandle, handoffs: Vec<Value>) {
    let chats = app.state::<Chats>();
    for handoff in handoffs {
        let Some(id) = handoff["id"].as_str() else { continue };
        if !chats.is_live(id) { continue; }
        match handoff["prompt"].as_str().filter(|prompt| !prompt.is_empty()) {
            Some(prompt) => {
                let _ = app.emit("chat:handoff", [json!(id), json!({ "prompt": prompt, "tokens": handoff["tokens"].clone() })]);
            }
            None => {
                let _ = app.emit("chat:turn-end", [json!(id)]);
            }
        }
    }
}