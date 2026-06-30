//! Ontoloom — a lightweight, airgapped ontology / knowledge-graph builder.
//!
//! Run it, and it serves a visual graph editor to your browser on loopback.
//! Build a graph by clicking, then export it as Neo4j-ready JSONL, a Cypher
//! script, plain JSON, or GraphML. No network, no external dependencies.

mod assets;
mod export;
mod json;
mod model;
mod server;

use std::net::{Ipv4Addr, SocketAddrV4, TcpListener};
use std::path::PathBuf;
use std::process::Command;

const DEFAULT_PORT: u16 = 7878;

struct Options {
    port: u16,
    open: bool,
    data_path: PathBuf,
}

fn main() {
    let options = match parse_args() {
        Ok(Some(opts)) => opts,
        Ok(None) => return, // --help / --version already printed
        Err(e) => {
            eprintln!("ontoloom: {}", e);
            eprintln!("try 'ontoloom --help'");
            std::process::exit(2);
        }
    };

    // Bind loopback only. If the requested port is taken, fall back to an
    // ephemeral port so the tool always starts.
    let listener = match bind(options.port) {
        Some(l) => l,
        None => {
            eprintln!(
                "ontoloom: could not bind 127.0.0.1:{} and no ephemeral port was free",
                options.port
            );
            std::process::exit(1);
        }
    };

    let addr = listener.local_addr().expect("listener has a local address");
    let url = format!("http://{}/", addr);

    println!("  ┌─────────────────────────────────────────────┐");
    println!("  │  ontoloom — airgapped ontology builder        │");
    println!("  └─────────────────────────────────────────────┘");
    println!();
    println!("  Editor:    {}", url);
    println!("  Data file: {}", options.data_path.display());
    println!();
    println!("  Press Ctrl+C to stop.");
    println!();

    if options.open {
        open_browser(&url);
    }

    server::serve(
        listener,
        server::Config {
            data_path: options.data_path,
        },
    );
}

fn bind(preferred: u16) -> Option<TcpListener> {
    let loopback = Ipv4Addr::LOCALHOST;
    if let Ok(listener) = TcpListener::bind(SocketAddrV4::new(loopback, preferred)) {
        return Some(listener);
    }
    // Port 0 asks the OS for any free port.
    TcpListener::bind(SocketAddrV4::new(loopback, 0)).ok()
}

fn parse_args() -> Result<Option<Options>, String> {
    let mut port = DEFAULT_PORT;
    let mut open = true;
    let mut data_path = default_data_path();

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" => {
                print_help();
                return Ok(None);
            }
            "-V" | "--version" => {
                println!("ontoloom {}", env!("CARGO_PKG_VERSION"));
                return Ok(None);
            }
            "--no-open" => open = false,
            "-p" | "--port" => {
                let value = args.next().ok_or("--port requires a value")?;
                port = value
                    .parse()
                    .map_err(|_| format!("invalid port '{}'", value))?;
            }
            "-d" | "--data" => {
                let value = args.next().ok_or("--data requires a path")?;
                data_path = PathBuf::from(value);
            }
            other => return Err(format!("unknown argument '{}'", other)),
        }
    }

    Ok(Some(Options {
        port,
        open,
        data_path,
    }))
}

fn print_help() {
    println!("ontoloom {} — airgapped ontology / knowledge-graph builder", env!("CARGO_PKG_VERSION"));
    println!();
    println!("USAGE:");
    println!("    ontoloom [OPTIONS]");
    println!();
    println!("OPTIONS:");
    println!("    -p, --port <PORT>    Port to serve on (default: {})", DEFAULT_PORT);
    println!("    -d, --data <FILE>    Graph autosave file (default: ./ontoloom-graph.json)");
    println!("        --no-open        Do not open a browser automatically");
    println!("    -h, --help           Print help");
    println!("    -V, --version        Print version");
    println!();
    println!("Everything runs locally on 127.0.0.1 with no network access.");
}

fn default_data_path() -> PathBuf {
    PathBuf::from("ontoloom-graph.json")
}

/// Best-effort: open the system browser. Failure is non-fatal — the URL is
/// already printed for the user to click or paste.
fn open_browser(url: &str) {
    let result = if cfg!(target_os = "macos") {
        Command::new("open").arg(url).spawn()
    } else if cfg!(target_os = "windows") {
        Command::new("cmd").args(["/C", "start", "", url]).spawn()
    } else {
        Command::new("xdg-open").arg(url).spawn()
    };
    if result.is_err() {
        eprintln!("ontoloom: open your browser to {} (auto-open unavailable)", url);
    }
}
