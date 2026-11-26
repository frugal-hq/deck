// Text the Rust side shows (errors, the setup window) comes from the renderer's locale files, merged like
// i18n.mjs: English, then the base language, then the language itself.
use serde_json::{Map, Value};
use std::sync::RwLock;

macro_rules! locales {
    ($($tag:literal),*) => { &[$(($tag, include_str!(concat!("../../src/renderer/locales/", $tag, ".json")))),*] };
}
const LOCALES: &[(&str, &str)] = locales!["en", "es", "es-ES", "es-PE", "es-MX", "pt-PT", "pt-BR", "ru", "tr", "fr", "de", "it", "ja", "zh-CN", "ko", "pl", "uk", "nl"];

static MESSAGES: RwLock<Option<(String, Map<String, Value>)>> = RwLock::new(None);

pub fn messages(tag: &str) -> Map<String, Value> {
    let mut chain = vec!["en", tag.split('-').next().unwrap_or(tag), tag];
    chain.dedup();
    let mut merged = Map::new();
    for tag in chain {
        if let Some((_, text)) = LOCALES.iter().find(|(name, _)| *name == tag) {
            merged.extend(serde_json::from_str::<Map<String, Value>>(text).expect("locale files are valid JSON"));
        }
    }
    merged
}

pub fn set_language(tag: &str) {
    let mut loaded = MESSAGES.write().unwrap();
    if loaded.as_ref().is_none_or(|(current, _)| current != tag) {
        *loaded = Some((tag.to_owned(), messages(tag)));
    }
}

pub(crate) fn language() -> String {
    MESSAGES.read().unwrap().as_ref().map_or_else(|| "en".into(), |(tag, _)| tag.clone())
}

pub fn t(key: &str, vars: &[(&str, &dyn std::fmt::Display)]) -> String {
    if MESSAGES.read().unwrap().is_none() {
        set_language("en");
    }
    let messages = MESSAGES.read().unwrap();
    let mut rest = messages.as_ref().and_then(|(_, messages)| messages.get(key)).and_then(Value::as_str).unwrap_or(key);
    // One pass, so a value that contains {name} is not filled in again.
    let mut text = String::new();
    while let Some(start) = rest.find('{') {
        text.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let var = after.find('}').and_then(|end| vars.iter().find(|(name, _)| *name == &after[..end]).map(|(_, value)| (value, end)));
        match var {
            Some((value, end)) => {
                text.push_str(&value.to_string());
                rest = &after[end + 1..];
            }
            None => {
                text.push('{');
                rest = after;
            }
        }
    }
    text + rest
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locales_match_the_renderer_and_merge() {
        let renderer = include_str!("../../src/renderer/i18n.mjs");
        let list = renderer.split("export const languages = [").nth(1).unwrap().split(']').next().unwrap();
        assert_eq!(list.split(',').count(), LOCALES.len());
        for (tag, _) in LOCALES {
            assert!(list.contains(&format!("'{tag}'")), "{tag} is not in i18n.mjs");
            assert!(!messages(tag).is_empty());
        }
        assert_eq!(messages("es-PE")["common.add"], messages("es")["common.add"]);
        assert_eq!(messages("xx")["common.add"], "Add");
        set_language("en");
        assert_eq!(t("common.percent", &[("percent", &"{percent}")]), "{percent}%");
        assert_eq!(t("missing.{key}", &[]), "missing.{key}");
    }
}
