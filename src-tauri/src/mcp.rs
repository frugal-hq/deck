// `claude mcp list` output: one server per health line, named and with its status.

use serde_json::{json, Value};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::State;
use crate::accounts::{mcp_scope, run, Accounts};
use crate::chat::{account_env, find_claude, NO_CLAUDE};

const CHECKING: &str = "Checking MCP server health";

// mcp.js:2-19: the name is everything through the separator; the status is after the last " - ".
pub fn parse_mcp_list(text: &str) -> Vec<Value> {
    let mut servers = Vec::new();
    for raw in text.split('\n') {
        let line = raw.trim();
        if line.is_empty() { continue; }
        if line.chars().take(CHECKING.chars().count()).collect::<String>().eq_ignore_ascii_case(CHECKING) { continue; }
        let Some(end) = line.char_indices().find_map(|(i, c)| (c != ':' && line[i + c.len_utf8()..].starts_with(": ")).then_some(i + c.len_utf8())) else { continue };
        let name = line[..end].trim();
        let rest = line[end + 2..].trim();
        let Some(dash) = rest.rfind(" - ") else { continue };
        let status = rest[dash + 3..].trim();
        if name.is_empty() || status.is_empty() { continue; }
        servers.push(json!({ "name": name, "status": status }));
    }
    servers
}

// main.js:460-477. Listed as the chat sees them: turning off a server can reveal another of the same name it was hiding.
#[tauri::command]
pub async fn mcp_list(accounts: State<'_, Mutex<Accounts>>, scope: Value, account_id: Option<String>) -> std::result::Result<Value, ()> {
    let Some(scope) = mcp_scope(&scope) else { return Ok(json!({ "error": "Invalid folder." })) };
    let Some(claude) = find_claude() else { return Ok(json!({ "error": NO_CLAUDE })) };
    let (env, off) = {
        let accounts = accounts.lock().unwrap();
        let account = accounts.claude_accounts().into_iter().find(|a| account_id.as_deref().is_some_and(|id| a["id"] == id)).unwrap_or_else(|| accounts.primary());
        (account_env(&accounts, &account), accounts.mcp_off(&scope).unwrap_or_else(|_| json!([])))
    };
    let denied: Vec<Value> = off.as_array().into_iter().flatten().map(|name| json!({ "serverName": name })).collect();
    let folder = scope["folder"].as_str().unwrap_or_default().to_owned();
    let mut command = Command::new(claude);
    command.env_clear().envs(env).args(["--settings", &json!({ "deniedMcpServers": denied }).to_string(), "mcp", "list"]).current_dir(folder).stdin(Stdio::null());
    Ok(match tauri::async_runtime::spawn_blocking(move || run(&mut command, Duration::from_secs(60)).map_err(|e| e.to_string())).await {
        Ok(Ok(out)) => json!({ "servers": parse_mcp_list(&String::from_utf8_lossy(&out)), "off": off }),
        Ok(Err(error)) => json!({ "error": error.trim() }),
        Err(error) => json!({ "error": error.to_string() }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // mcp.check.js:5-18: 1 assertion ported.
    #[test]
    fn parses_list_output() {
        let sample = [
            "Checking MCP server health...",
            "",
            "claude.ai Linear: https://mcp.linear.app/mcp - ✓ Connected",
            "plugin:frugal:accounts: python server.py - ✓ Connected",
            "pylon: https://x/mcp (HTTP) - ✗ Failed to connect",
            "Header line",
        ].join("\n");
        assert_eq!(parse_mcp_list(&sample), vec![
            json!({ "name": "claude.ai Linear", "status": "✓ Connected" }),
            json!({ "name": "plugin:frugal:accounts", "status": "✓ Connected" }),
            json!({ "name": "pylon", "status": "✗ Failed to connect" }),
        ]);
    }
}