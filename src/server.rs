//! A minimal, dependency-free HTTP/1.1 server built on `std::net`.
//!
//! It only does what Ontoloom needs: serve the embedded single-page app, and
//! handle a handful of JSON endpoints for persistence and export. It binds to
//! loopback only — there is no path by which it touches the network — so the
//! whole tool runs airgapped.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;

use crate::assets;
use crate::export;
use crate::json::parse;
use crate::model::Graph;

pub struct Config {
    pub data_path: PathBuf,
}

pub fn serve(listener: TcpListener, config: Config) {
    let config = Arc::new(config);
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let config = Arc::clone(&config);
                thread::spawn(move || {
                    if let Err(e) = handle(stream, &config) {
                        eprintln!("ontoloom: connection error: {}", e);
                    }
                });
            }
            Err(e) => eprintln!("ontoloom: accept error: {}", e),
        }
    }
}

struct Request {
    method: String,
    path: String,
    body: Vec<u8>,
}

fn handle(stream: TcpStream, config: &Config) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut writer = stream;

    let request = match read_request(&mut reader)? {
        Some(req) => req,
        None => return Ok(()), // empty / closed connection
    };

    let response = route(&request, config);
    write_response(&mut writer, response)
}

fn read_request(reader: &mut BufReader<TcpStream>) -> std::io::Result<Option<Request>> {
    let mut request_line = String::new();
    let n = reader.read_line(&mut request_line)?;
    if n == 0 {
        return Ok(None);
    }
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("/").to_string();

    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line)?;
        if n == 0 {
            break;
        }
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            break;
        }
        if let Some(value) = trimmed.strip_prefix("Content-Length:") {
            content_length = value.trim().parse().unwrap_or(0);
        } else if let Some(value) = trimmed.to_ascii_lowercase().strip_prefix("content-length:") {
            // Header names are case-insensitive.
            content_length = value.trim().parse().unwrap_or(content_length);
        }
    }

    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body)?;
    }

    Ok(Some(Request {
        method,
        path,
        body,
    }))
}

struct Response {
    status: &'static str,
    content_type: String,
    extra_headers: Vec<String>,
    body: Vec<u8>,
}

impl Response {
    fn new(status: &'static str, content_type: &str, body: Vec<u8>) -> Response {
        Response {
            status,
            content_type: content_type.to_string(),
            extra_headers: Vec::new(),
            body,
        }
    }

    fn text(status: &'static str, body: &str) -> Response {
        Response::new(status, "text/plain; charset=utf-8", body.as_bytes().to_vec())
    }

    fn json(status: &'static str, body: String) -> Response {
        Response::new(status, "application/json", body.into_bytes())
    }
}

fn route(req: &Request, config: &Config) -> Response {
    // Strip any query string for matching.
    let path = req.path.split('?').next().unwrap_or("/");
    match (req.method.as_str(), path) {
        ("GET", "/") | ("GET", "/index.html") => {
            Response::new("200 OK", "text/html; charset=utf-8", assets::INDEX_HTML.into())
        }
        ("GET", "/app.js") => Response::new(
            "200 OK",
            "application/javascript; charset=utf-8",
            assets::APP_JS.into(),
        ),
        ("GET", "/style.css") => {
            Response::new("200 OK", "text/css; charset=utf-8", assets::STYLE_CSS.into())
        }
        ("GET", "/favicon.svg") => Response::new(
            "200 OK",
            "image/svg+xml",
            assets::FAVICON_SVG.into(),
        ),
        ("GET", "/api/health") => Response::json("200 OK", "{\"status\":\"ok\"}".into()),
        ("GET", "/api/state") => load_state(config),
        ("POST", "/api/state") => save_state(req, config),
        ("POST", p) if p.starts_with("/api/export/") => {
            let format = p.trim_start_matches("/api/export/");
            handle_export(req, format)
        }
        _ => Response::text("404 Not Found", "not found"),
    }
}

fn load_state(config: &Config) -> Response {
    match std::fs::read_to_string(&config.data_path) {
        Ok(contents) if !contents.trim().is_empty() => Response::json("200 OK", contents),
        _ => Response::json("200 OK", "{\"nodes\":[],\"relationships\":[]}".into()),
    }
}

fn save_state(req: &Request, config: &Config) -> Response {
    let body = match std::str::from_utf8(&req.body) {
        Ok(b) => b,
        Err(_) => return Response::text("400 Bad Request", "body is not valid UTF-8"),
    };
    // Validate before persisting so we never write a corrupt graph to disk.
    let parsed = match parse(body) {
        Ok(p) => p,
        Err(e) => return Response::text("400 Bad Request", &format!("invalid JSON: {}", e)),
    };
    if let Err(e) = Graph::from_wire(&parsed) {
        return Response::text("400 Bad Request", &format!("invalid graph: {}", e));
    }
    match std::fs::write(&config.data_path, body.as_bytes()) {
        Ok(_) => Response::json("200 OK", "{\"status\":\"saved\"}".into()),
        Err(e) => Response::text("500 Internal Server Error", &format!("write failed: {}", e)),
    }
}

fn handle_export(req: &Request, format: &str) -> Response {
    let spec = match export::format_for(format) {
        Some(spec) => spec,
        None => return Response::text("404 Not Found", "unknown export format"),
    };
    let body = match std::str::from_utf8(&req.body) {
        Ok(b) => b,
        Err(_) => return Response::text("400 Bad Request", "body is not valid UTF-8"),
    };
    let parsed = match parse(body) {
        Ok(p) => p,
        Err(e) => return Response::text("400 Bad Request", &format!("invalid JSON: {}", e)),
    };
    let graph = match Graph::from_wire(&parsed) {
        Ok(g) => g,
        Err(e) => return Response::text("400 Bad Request", &format!("invalid graph: {}", e)),
    };
    match export::export(&graph, format) {
        Ok(output) => {
            let mut resp = Response::new(
                "200 OK",
                spec.content_type,
                output.into_bytes(),
            );
            resp.extra_headers.push(format!(
                "Content-Disposition: attachment; filename=\"{}\"",
                spec.filename
            ));
            resp
        }
        Err(e) => Response::text("500 Internal Server Error", &e),
    }
}

fn write_response(writer: &mut TcpStream, response: Response) -> std::io::Result<()> {
    let mut head = format!(
        "HTTP/1.1 {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n",
        response.status,
        response.content_type,
        response.body.len()
    );
    for header in &response.extra_headers {
        head.push_str(header);
        head.push_str("\r\n");
    }
    head.push_str("\r\n");
    writer.write_all(head.as_bytes())?;
    writer.write_all(&response.body)?;
    writer.flush()
}
