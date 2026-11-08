//! Import sessions from a file and print them: `import_file mobaxterm|putty|ssh <path>`.
//! With `--merge`, add them to Tether's saved sessions (skipping ones already there).
use std::path::Path;
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let path = Path::new(&a[2]);
    let r = match a[1].as_str() {
        "mobaxterm" => tether_core::import::mobaxterm(path),
        "putty" => tether_core::import::putty(),
        _ => tether_core::import::ssh_config(path),
    };
    for s in &r.sessions {
        println!("{:<5} {:<34} {}@{}:{}  {}", format!("{:?}", s.protocol), s.name, s.user, s.host, s.port, s.identity);
    }
    for s in &r.skipped { println!("skipped: {s}"); }
    if a.iter().any(|x| x == "--merge") {
        let store = tether_core::model::Store::new(dirs::config_dir().unwrap().join("dev.convolutionary.tether")).expect("store");
        let mut have = store.sessions();
        let before = have.len();
        for s in r.sessions {
            if !have.iter().any(|h| h.host == s.host && h.port == s.port && h.user == s.user && h.protocol == s.protocol && h.name == s.name) {
                have.push(s);
            }
        }
        store.save_sessions(&have).expect("save");
        println!("saved: {} new, {} total", have.len() - before, have.len());
    }
}
