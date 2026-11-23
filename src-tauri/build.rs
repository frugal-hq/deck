use std::{fs, io::Write, path::Path, process::{Command, Stdio}};

// The renderer loads xterm and fonts from ../../node_modules, so dist keeps the repo layout for each file it ships, with node_modules renamed vendor.
const FRONTEND: &[&str] = &[
    "src/renderer",
    "node_modules/@xterm/xterm/lib/xterm.mjs",
    "node_modules/@xterm/xterm/css/xterm.css",
    "node_modules/@xterm/addon-fit/lib/addon-fit.mjs",
    "node_modules/@fontsource/host-grotesk/400.css",
    "node_modules/@fontsource/host-grotesk/500.css",
    "node_modules/@fontsource/host-grotesk/files",
    "node_modules/@fontsource/atkinson-hyperlegible-mono/400.css",
    "node_modules/@fontsource/atkinson-hyperlegible-mono/files",
];

// The font folders hold every weight, style and format; the CSS uses 400 and 500, and WebView2 reads woff2.
fn shipped(file: &Path) -> bool {
    let name = file.to_string_lossy();
    file.is_dir() || !name.contains("@fontsource") || !name.contains("files") || name.ends_with("-400-normal.woff2") || name.ends_with("-500-normal.woff2")
}

fn copy(from: &Path, to: &Path) {
    if !shipped(from) {
        return;
    }
    if from.is_dir() {
        fs::create_dir_all(to).unwrap();
        for entry in fs::read_dir(from).unwrap() {
            let entry = entry.unwrap();
            copy(&entry.path(), &to.join(entry.file_name()));
        }
    } else {
        fs::create_dir_all(to.parent().unwrap()).unwrap();
        // The Tauri CLI refuses a frontendDist holding a node_modules folder, so the renderer's paths point at vendor.
        if matches!(from.extension().and_then(|ext| ext.to_str()), Some("css" | "html" | "js")) && from.starts_with("../src/renderer") {
            let text = fs::read_to_string(from).unwrap();
            if from.extension().is_some_and(|ext| ext == "js") {
                check_syntax(from, &text);
            }
            fs::write(to, text.replace("../../node_modules/", "../../vendor/")).unwrap();
        } else {
            fs::copy(from, to).unwrap_or_else(|error| panic!("{}: {error}", from.display()));
        }
    }
}

// A renderer script that fails to parse leaves the whole UI dead with no error, so the build refuses it.
fn check_syntax(file: &Path, text: &str) {
    let Ok(mut node) = Command::new("node").args(["--check", "--input-type=module"]).stdin(Stdio::piped()).stderr(Stdio::piped()).spawn() else {
        println!("cargo:warning=node not found, {} was not syntax-checked", file.display());
        return;
    };
    node.stdin.take().unwrap().write_all(text.as_bytes()).unwrap();
    let out = node.wait_with_output().unwrap();
    assert!(out.status.success(), "{} does not parse:
{}", file.display(), String::from_utf8_lossy(&out.stderr));
}

fn main() {
    let dist = Path::new("dist");
    let _ = fs::remove_dir_all(dist);
    for item in FRONTEND {
        println!("cargo:rerun-if-changed=../{item}");
        copy(&Path::new("..").join(item), &dist.join(item.replacen("node_modules/", "vendor/", 1)));
    }
    tauri_build::build();
}
