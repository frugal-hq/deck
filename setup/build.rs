use std::{fs, path::Path};

// The window wears the Deck's tokens and font; the NSIS installer from `cargo tauri build` in src-tauri is embedded whole.
const FILES: &[(&str, &str)] = &[
    ("ui/index.html", "index.html"),
    ("../src/renderer/tokens.css", "tokens.css"),
    ("../src/renderer/base.css", "base.css"),
    ("../src/renderer/i18n.mjs", "i18n.mjs"),
    ("../node_modules/@fontsource/host-grotesk/400.css", "fonts/host-grotesk/400.css"),
    ("../node_modules/@fontsource/host-grotesk/500.css", "fonts/host-grotesk/500.css"),
];
const FONT_FILES: &str = "../node_modules/@fontsource/host-grotesk/files";

fn main() {
    let dist = Path::new("dist");
    let _ = fs::remove_dir_all(dist);
    fs::create_dir_all(dist.join("fonts/host-grotesk/files")).unwrap();
    for (from, to) in FILES {
        println!("cargo:rerun-if-changed={from}");
        fs::copy(from, dist.join(to)).unwrap_or_else(|error| panic!("{from}: {error}"));
    }
    for entry in fs::read_dir(FONT_FILES).unwrap() {
        let name = entry.unwrap().file_name().into_string().unwrap();
        if name.ends_with("-400-normal.woff2") || name.ends_with("-500-normal.woff2") {
            fs::copy(Path::new(FONT_FILES).join(&name), dist.join("fonts/host-grotesk/files").join(&name)).unwrap();
        }
    }
    let locales = Path::new("../src/renderer/locales");
    println!("cargo:rerun-if-changed={}", locales.display());
    fs::create_dir_all(dist.join("locales")).unwrap();
    for entry in fs::read_dir(locales).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|ext| ext == "json") && path.is_file() {
            println!("cargo:rerun-if-changed={}", path.display());
            fs::copy(&path, dist.join("locales").join(path.file_name().unwrap()))
                .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        }
    }
    println!("cargo:rerun-if-changed=../src-tauri/tauri.conf.json");
    let config: serde_json::Value = serde_json::from_str(&fs::read_to_string("../src-tauri/tauri.conf.json").unwrap()).unwrap();
    let version = config["version"].as_str().unwrap();
    let nsis = Path::new("../src-tauri/target/release/bundle/nsis").join(format!("Frugal Deck_{version}_x64-setup.exe"));
    assert!(nsis.is_file(), "{} is missing: run cargo tauri build in src-tauri first", nsis.display());
    let nsis = std::path::absolute(nsis).unwrap();
    println!("cargo:rerun-if-changed={}", nsis.display());
    println!("cargo:rustc-env=DECK_NSIS={}", nsis.display());
    println!("cargo:rustc-env=DECK_VERSION={version}");
    tauri_build::build();
}
