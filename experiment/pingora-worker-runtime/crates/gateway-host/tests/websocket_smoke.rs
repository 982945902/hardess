use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::Value;

fn unique_temp_dir(name: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time should be after unix epoch")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "hardess-pingora-worker-runtime-it-{name}-{}-{nonce}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("temp dir should be created");
    dir
}

fn temp_worker_path(name: &str, source: &str) -> PathBuf {
    let dir = unique_temp_dir(name);
    let worker_path = dir.join("mod.ts");
    std::fs::write(&worker_path, source).expect("temp worker should be written");
    worker_path
}

fn pick_free_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("should bind ephemeral port");
    listener
        .local_addr()
        .expect("local addr should exist")
        .port()
}

fn wait_for_ready(port: u16) {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while std::time::Instant::now() < deadline {
        if let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) {
            let request = concat!(
                "GET /_hardess/ingress-state HTTP/1.1\r\n",
                "Host: 127.0.0.1\r\n",
                "Connection: close\r\n",
                "\r\n"
            );
            let _ = stream.write_all(request.as_bytes());
            let mut response = String::new();
            let _ = stream.read_to_string(&mut response);
            if response.starts_with("HTTP/1.1 200") {
                return;
            }
        }
        thread::sleep(Duration::from_millis(100));
    }
    panic!("timed out waiting for pingora_ingress to become ready");
}

fn start_pingora_ingress(worker_path: &PathBuf, port: u16) -> Child {
    let bin = env!("CARGO_BIN_EXE_pingora_ingress");
    Command::new(bin)
        .arg(worker_path)
        .arg("--listen")
        .arg(format!("127.0.0.1:{port}"))
        .arg("--worker-id")
        .arg("ws-smoke")
        .arg("--runtime-threads")
        .arg("1")
        .arg("--queue-capacity")
        .arg("8")
        .arg("--exec-timeout-ms")
        .arg("5000")
        .arg("--shutdown-drain-timeout-ms")
        .arg("1000")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("pingora_ingress should spawn")
}

fn stop_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn read_http_headers(stream: &mut TcpStream) -> String {
    let mut response = Vec::new();
    let mut buf = [0_u8; 1];
    while !response.ends_with(b"\r\n\r\n") {
        let read = stream.read(&mut buf).expect("should read handshake byte");
        assert!(read > 0, "server closed while sending handshake");
        response.extend_from_slice(&buf[..read]);
    }
    String::from_utf8(response).expect("handshake should be utf-8")
}

fn masked_client_text_frame(text: &str) -> Vec<u8> {
    let payload = text.as_bytes();
    let mask = [0x11, 0x22, 0x33, 0x44];
    let mut frame = Vec::with_capacity(payload.len() + 16);
    frame.push(0x81);
    if payload.len() <= 125 {
        frame.push(0x80 | payload.len() as u8);
    } else {
        frame.push(0x80 | 126);
        frame.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    }
    frame.extend_from_slice(&mask);
    for (index, byte) in payload.iter().enumerate() {
        frame.push(*byte ^ mask[index % 4]);
    }
    frame
}

#[derive(Debug, PartialEq, Eq)]
enum ServerFrame {
    Text(String),
    Close {
        code: Option<u16>,
        reason: Option<String>,
    },
}

fn read_server_frame(stream: &mut TcpStream) -> ServerFrame {
    let mut header = [0_u8; 2];
    stream
        .read_exact(&mut header)
        .expect("should read websocket frame header");
    let opcode = header[0] & 0x0f;
    let masked = (header[1] & 0x80) != 0;
    assert!(!masked, "server frame should not be masked");
    let mut payload_len = (header[1] & 0x7f) as usize;
    if payload_len == 126 {
        let mut extended = [0_u8; 2];
        stream
            .read_exact(&mut extended)
            .expect("should read extended length");
        payload_len = u16::from_be_bytes(extended) as usize;
    } else if payload_len == 127 {
        let mut extended = [0_u8; 8];
        stream
            .read_exact(&mut extended)
            .expect("should read extended length");
        payload_len = u64::from_be_bytes(extended) as usize;
    }
    let mut payload = vec![0_u8; payload_len];
    stream
        .read_exact(&mut payload)
        .expect("should read websocket frame payload");

    match opcode {
        0x1 => ServerFrame::Text(String::from_utf8(payload).expect("text payload should be utf-8")),
        0x8 => {
            let (code, reason) = if payload.len() >= 2 {
                let code = Some(u16::from_be_bytes([payload[0], payload[1]]));
                let reason = if payload.len() > 2 {
                    Some(
                        String::from_utf8(payload[2..].to_vec())
                            .expect("close reason should be utf-8"),
                    )
                } else {
                    None
                };
                (code, reason)
            } else {
                (None, None)
            };
            ServerFrame::Close { code, reason }
        }
        other => panic!("unexpected server websocket opcode: {other}"),
    }
}

fn http_get_json(port: u16, path: &str) -> Value {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("should connect for http get");
    let request =
        format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    stream
        .write_all(request.as_bytes())
        .expect("should write http get");
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .expect("should read http response");
    let body = response
        .split("\r\n\r\n")
        .nth(1)
        .expect("http response should contain body");
    serde_json::from_str(body).expect("json body should parse")
}

#[test]
fn websocket_echo_smoke_test() {
    let worker_path = temp_worker_path(
        "websocket-smoke",
        r#"
export function fetch() {
  return new Response("ok");
}

export const websocket = {
  onOpen(ctx) {
    ctx.send("opened");
  },
  onMessage(message, ctx) {
    if (message.text === "quit") {
      ctx.close(1000, "done");
      return;
    }
    ctx.send(`echo:${message.text}`);
  },
};
"#,
    );
    let port = pick_free_port();
    let mut child = start_pingora_ingress(&worker_path, port);
    wait_for_ready(port);

    let mut stream =
        TcpStream::connect(("127.0.0.1", port)).expect("should connect to websocket port");
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .expect("should set read timeout");
    let handshake = concat!(
        "GET /ws HTTP/1.1\r\n",
        "Host: 127.0.0.1\r\n",
        "Upgrade: websocket\r\n",
        "Connection: Upgrade\r\n",
        "Sec-WebSocket-Version: 13\r\n",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n",
        "\r\n"
    );
    stream
        .write_all(handshake.as_bytes())
        .expect("should write websocket handshake");
    let response_headers = read_http_headers(&mut stream);
    assert!(response_headers.starts_with("HTTP/1.1 101"));
    let response_headers_lower = response_headers.to_ascii_lowercase();
    assert!(
        response_headers_lower.contains("sec-websocket-accept:"),
        "unexpected handshake headers: {response_headers}"
    );
    assert!(
        response_headers.contains("s3pPLMBiTxaQ9kYGzzhZRbK+xOo="),
        "unexpected handshake headers: {response_headers}"
    );

    assert_eq!(
        read_server_frame(&mut stream),
        ServerFrame::Text("opened".to_string())
    );

    stream
        .write_all(&masked_client_text_frame("ping"))
        .expect("should send ping text frame");
    assert_eq!(
        read_server_frame(&mut stream),
        ServerFrame::Text("echo:ping".to_string())
    );

    stream
        .write_all(&masked_client_text_frame("quit"))
        .expect("should send quit text frame");
    assert_eq!(
        read_server_frame(&mut stream),
        ServerFrame::Close {
            code: Some(1000),
            reason: Some("done".to_string()),
        }
    );
    let _ = stream.shutdown(Shutdown::Both);

    thread::sleep(Duration::from_millis(200));
    let ingress_state = http_get_json(port, "/_hardess/ingress-state");
    assert_eq!(
        ingress_state
            .pointer("/ingress_metrics/websocket/upgrade_requests")
            .and_then(Value::as_u64),
        Some(1)
    );
    assert_eq!(
        ingress_state
            .pointer("/ingress_metrics/websocket/upgrade_accepted")
            .and_then(Value::as_u64),
        Some(1)
    );
    assert_eq!(
        ingress_state
            .pointer("/ingress_metrics/websocket/sessions_completed")
            .and_then(Value::as_u64),
        Some(1)
    );
    assert_eq!(
        ingress_state
            .pointer("/ingress_metrics/websocket/messages_in")
            .and_then(Value::as_u64),
        Some(2)
    );
    assert_eq!(
        ingress_state
            .pointer("/ingress_metrics/websocket/messages_out")
            .and_then(Value::as_u64),
        Some(2)
    );
    assert_eq!(
        ingress_state
            .pointer("/ingress_metrics/websocket/close_out")
            .and_then(Value::as_u64),
        Some(1)
    );
    assert!(ingress_state
        .pointer("/ingress_metrics/websocket/average_open_runtime_ms")
        .and_then(Value::as_f64)
        .is_some());
    assert!(ingress_state
        .pointer("/ingress_metrics/websocket/average_open_command_write_ms")
        .and_then(Value::as_f64)
        .is_some());
    assert!(ingress_state
        .pointer("/ingress_metrics/websocket/average_message_runtime_ms")
        .and_then(Value::as_f64)
        .is_some());
    assert!(ingress_state
        .pointer("/ingress_metrics/websocket/average_message_command_write_ms")
        .and_then(Value::as_f64)
        .is_some());
    assert!(ingress_state
        .pointer("/ingress_metrics/websocket/average_message_total_ms")
        .and_then(Value::as_f64)
        .is_some());

    stop_child(&mut child);
}
