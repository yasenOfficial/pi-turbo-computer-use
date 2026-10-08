use std::{
    env, fs,
    path::{Path, PathBuf},
};

fn sources(dir: &Path, files: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).expect("read daemon sources") {
        let path = entry.expect("source entry").path();
        if path.is_dir() {
            sources(&path, files);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            files.push(path);
        }
    }
}

fn hash(hash: &mut u64, bytes: &[u8]) {
    for byte in bytes {
        *hash = (*hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3);
    }
}

fn main() {
    let mut files = vec![
        PathBuf::from("Cargo.toml"),
        PathBuf::from("Cargo.lock"),
        PathBuf::from("build.rs"),
    ];
    sources(Path::new("src"), &mut files);
    files.sort();
    let mut value = 0xcbf29ce484222325u64;
    for file in files {
        println!("cargo:rerun-if-changed={}", file.display());
        hash(&mut value, file.to_string_lossy().as_bytes());
        hash(&mut value, &[0]);
        hash(&mut value, &fs::read(&file).expect("read build-id source"));
        hash(&mut value, &[0]);
    }
    // Build flags/features can change the actual binary without changing source.
    let mut settings: Vec<_> = env::vars()
        .filter(|(key, _)| {
            key.starts_with("CARGO_FEATURE_")
                || matches!(
                    key.as_str(),
                    "RUSTFLAGS" | "CARGO_ENCODED_RUSTFLAGS" | "TARGET" | "PROFILE"
                )
        })
        .collect();
    settings.sort();
    for (key, value_) in settings {
        println!("cargo:rerun-if-env-changed={key}");
        hash(&mut value, key.as_bytes());
        hash(&mut value, value_.as_bytes());
    }
    println!("cargo:rustc-env=PI_DAEMON_BUILD_ID={value:016x}");
}
