//! The entire browser GUI is embedded into the binary at compile time, so the
//! shipped `ontoloom` executable is a single self-contained file with nothing
//! to fetch from the network. This is what makes the tool airgapped.

pub const INDEX_HTML: &str = include_str!("../web/index.html");
pub const APP_JS: &str = include_str!("../web/app.js");
pub const CODEMAP_JS: &str = include_str!("../web/codemap.js");
pub const STYLE_CSS: &str = include_str!("../web/style.css");
pub const FAVICON_SVG: &str = include_str!("../web/favicon.svg");
