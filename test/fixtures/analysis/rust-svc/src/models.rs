// A serde-derived struct (extracted; Option<T> is real grammar-level
// optionality) next to an unmarked helper (invisible).
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
pub struct Report {
    pub id: u64,
    pub title: String,
    pub note: Option<String>,
}

pub struct ReportCache {
    pub entries: Vec<String>,
}
