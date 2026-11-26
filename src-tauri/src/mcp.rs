//! An MCP server (streamable HTTP transport) on 127.0.0.1, so agents can see and control
//! the editor.
//!
//! The server answers `initialize` and `ping` itself and forwards `tools/list` and
//! `tools/call` to the frontend (the JS registry) over a channel; the frontend replies with
//! `mcp_respond`. Every request must carry `Authorization: Bearer <token>`, a random token
//! generated at startup, so other local programs can't drive the editor.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::State;

const CALL_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum McpEvent {
    /// A request for the frontend to answer with mcp_respond(id, ...).
    Request { id: u64, method: String, params: Value },
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct McpInfo {
    url: String,
    token: String,
}

struct Shared {
    channel: Mutex<Option<Channel<McpEvent>>>,
    pending: Mutex<HashMap<u64, Sender<Value>>>,
    next_id: AtomicU64,
    token: String,
}

#[derive(Default)]
pub struct McpServer {
    running: Mutex<Option<(McpInfo, Arc<Shared>)>>,
}

fn random_token() -> String {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes).expect("system random source");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn rpc_error(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Ask the frontend; wait for its answer (it may need to ask the user, so be patient).
fn forward(shared: &Shared, method: &str, params: Value) -> Result<Value, String> {
    let id = shared.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let (tx, rx) = channel();
    shared.pending.lock().unwrap().insert(id, tx);
    let sent = match shared.channel.lock().unwrap().as_ref() {
        Some(c) => c.send(McpEvent::Request { id, method: method.into(), params }).is_ok(),
        None => false,
    };
    if !sent {
        shared.pending.lock().unwrap().remove(&id);
        return Err("The editor is not ready (reloading?)".into());
    }
    let out = rx.recv_timeout(CALL_TIMEOUT).map_err(|_| "Timed out waiting for the editor".to_string());
    shared.pending.lock().unwrap().remove(&id);
    out
}

fn handle_message(shared: &Shared, msg: &Value) -> Option<Value> {
    let method = msg.get("method").and_then(Value::as_str)?;
    let id = msg.get("id").cloned();
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    let id = id?; // notifications (notifications/initialized, ...) need no reply
    let result = match method {
        "initialize" => Ok(json!({
            "protocolVersion": params.get("protocolVersion").cloned().unwrap_or(json!("2025-06-18")),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "polymer", "title": "Polymer editor", "version": env!("CARGO_PKG_VERSION") },
            "instructions": "Tools for the user's Polymer editor: see their open buffers (including unsaved edits), cursor and selection, open files for them to look at, and run editor commands they allow.",
        })),
        "ping" => Ok(json!({})),
        "tools/list" | "tools/call" => forward(shared, method, params).and_then(|answer| {
            if let Some(err) = answer.get("error") {
                Err(err.get("message").and_then(Value::as_str).unwrap_or("error").to_string())
            } else {
                Ok(answer.get("result").cloned().unwrap_or(Value::Null))
            }
        }),
        _ => return Some(rpc_error(&id, -32601, &format!("Method not found: {method}"))),
    };
    Some(match result {
        Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
        Err(e) => rpc_error(&id, -32603, &e),
    })
}

fn respond(req: tiny_http::Request, status: u16, body: Option<Value>) {
    let mut resp = match &body {
        Some(v) => tiny_http::Response::from_string(v.to_string()).with_status_code(status).boxed(),
        None => tiny_http::Response::empty(status).boxed(),
    };
    if body.is_some() {
        resp.add_header(tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap());
    }
    if status == 405 {
        resp.add_header(tiny_http::Header::from_bytes("Allow", "POST, DELETE").unwrap());
    }
    let _ = req.respond(resp);
}

fn handle_http(shared: Arc<Shared>, mut req: tiny_http::Request) {
    let authorized = req
        .headers()
        .iter()
        .find(|h| h.field.equiv("Authorization"))
        .map(|h| h.value.as_str() == format!("Bearer {}", shared.token))
        .unwrap_or(false);
    if !authorized {
        return respond(req, 401, Some(json!({ "error": "unauthorized" })));
    }
    match req.method() {
        tiny_http::Method::Post => {}
        tiny_http::Method::Delete => return respond(req, 200, None),
        // No server-initiated stream; allowed by the spec.
        _ => return respond(req, 405, None),
    }
    let mut body = String::new();
    if req.as_reader().read_to_string(&mut body).is_err() {
        return respond(req, 400, Some(rpc_error(&Value::Null, -32700, "Unreadable body")));
    }
    let parsed: Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(_) => return respond(req, 400, Some(rpc_error(&Value::Null, -32700, "Parse error"))),
    };
    let replies: Vec<Value> = match &parsed {
        Value::Array(msgs) => msgs.iter().filter_map(|m| handle_message(&shared, m)).collect(),
        m => handle_message(&shared, m).into_iter().collect(),
    };
    match (parsed.is_array(), replies.len()) {
        (_, 0) => respond(req, 202, None),
        (false, _) => respond(req, 200, replies.into_iter().next()),
        (true, _) => respond(req, 200, Some(Value::Array(replies))),
    }
}

/// Start the server (once); later calls just route requests to the new channel (after a
/// frontend reload) and return the same address and token.
#[tauri::command]
pub fn mcp_start(state: State<'_, McpServer>, channel: Channel<McpEvent>) -> Result<McpInfo, String> {
    let mut running = state.running.lock().unwrap();
    if let Some((info, shared)) = running.as_ref() {
        *shared.channel.lock().unwrap() = Some(channel);
        return Ok(info.clone());
    }
    let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = server.server_addr().to_ip().map(|a| a.port()).ok_or("no port")?;
    let shared = Arc::new(Shared {
        channel: Mutex::new(Some(channel)),
        pending: Mutex::new(HashMap::new()),
        next_id: AtomicU64::new(0),
        token: random_token(),
    });
    let info = McpInfo { url: format!("http://127.0.0.1:{port}/mcp"), token: shared.token.clone() };
    let s = shared.clone();
    std::thread::spawn(move || {
        for req in server.incoming_requests() {
            let s = s.clone();
            // Tool calls can wait on the user, so each request gets its own thread.
            std::thread::spawn(move || handle_http(s, req));
        }
    });
    *running = Some((info.clone(), shared));
    Ok(info)
}

/// The frontend's answer to a forwarded request: { result } or { error: { message } }.
#[tauri::command]
pub fn mcp_respond(state: State<'_, McpServer>, id: u64, response: Value) -> Result<(), String> {
    let running = state.running.lock().unwrap();
    let (_, shared) = running.as_ref().ok_or("MCP server not running")?;
    if let Some(tx) = shared.pending.lock().unwrap().remove(&id) {
        let _ = tx.send(response);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shared() -> Shared {
        Shared { channel: Mutex::new(None), pending: Mutex::new(HashMap::new()), next_id: AtomicU64::new(0), token: "t".into() }
    }

    #[test]
    fn initialize_and_ping_are_answered_locally() {
        let s = shared();
        let r = handle_message(&s, &json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-03-26" } })).unwrap();
        assert_eq!(r["result"]["protocolVersion"], "2025-03-26");
        assert!(r["result"]["capabilities"]["tools"].is_object());
        let r = handle_message(&s, &json!({ "jsonrpc": "2.0", "id": 2, "method": "ping" })).unwrap();
        assert_eq!(r["result"], json!({}));
    }

    #[test]
    fn notifications_get_no_reply_and_unknown_methods_error() {
        let s = shared();
        assert!(handle_message(&s, &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).is_none());
        let r = handle_message(&s, &json!({ "jsonrpc": "2.0", "id": 3, "method": "resources/list" })).unwrap();
        assert_eq!(r["error"]["code"], -32601);
    }

    #[test]
    fn tool_calls_without_a_frontend_fail_cleanly() {
        let s = shared();
        let r = handle_message(&s, &json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/list" })).unwrap();
        assert!(r["error"]["message"].as_str().unwrap().contains("not ready"));
    }

    /// Real HTTP over a socket: auth, JSON replies, 202 for notifications, batches, 405 for GET.
    #[test]
    fn http_transport() {
        use std::io::{Read, Write};
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let s = Arc::new(shared());
        let s2 = s.clone();
        std::thread::spawn(move || {
            for req in server.incoming_requests() {
                handle_http(s2.clone(), req);
            }
        });
        let http = |method: &str, auth: Option<&str>, body: &str| -> (u16, String) {
            let mut c = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            let auth = auth.map(|t| format!("Authorization: Bearer {t}\r\n")).unwrap_or_default();
            write!(c, "{method} /mcp HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n{auth}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            let mut out = String::new();
            c.read_to_string(&mut out).unwrap();
            let status: u16 = out.split_whitespace().nth(1).unwrap().parse().unwrap();
            (status, out.split("\r\n\r\n").nth(1).unwrap_or("").to_string())
        };
        let init = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}"#;
        assert_eq!(http("POST", None, init).0, 401);
        assert_eq!(http("POST", Some("wrong"), init).0, 401);
        let (status, body) = http("POST", Some("t"), init);
        assert_eq!(status, 200);
        assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["result"]["serverInfo"]["name"], "polymer");
        assert_eq!(http("POST", Some("t"), r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#).0, 202);
        let (status, body) = http("POST", Some("t"), r#"[{"jsonrpc":"2.0","id":1,"method":"ping"},{"jsonrpc":"2.0","method":"notifications/x"}]"#);
        assert_eq!((status, serde_json::from_str::<Value>(&body).unwrap().as_array().unwrap().len()), (200, 1));
        assert_eq!(http("GET", Some("t"), "").0, 405);
    }

    #[test]
    fn tokens_are_random_hex() {
        let (a, b) = (random_token(), random_token());
        assert_eq!(a.len(), 48);
        assert_ne!(a, b);
    }
}
