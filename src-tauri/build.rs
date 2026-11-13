use std::{fs, path::Path};

// The renderer loads xterm and fonts from ../../node_modules, so dist keeps the repo layout for each file it ships.
// frugal: the font folders hold every weight and subset (about 1.4 MB); trim to 400/500 woff2 in phase 7.
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

fn copy(from: &Path, to: &Path) {
    if from.is_dir() {
        fs::create_dir_all(to).unwrap();
        for entry in fs::read_dir(from).unwrap() {
            let entry = entry.unwrap();
            copy(&entry.path(), &to.join(entry.file_name()));
        }
    } else {
        fs::create_dir_all(to.parent().unwrap()).unwrap();
        fs::copy(from, to).unwrap_or_else(|error| panic!("{}: {error}", from.display()));
    }
}

fn main() {
    let dist = Path::new("dist");
    let _ = fs::remove_dir_all(dist);
    for item in FRONTEND {
        println!("cargo:rerun-if-changed=../{item}");
        copy(&Path::new("..").join(item), &dist.join(item));
    }
    tauri_build::build();
}
