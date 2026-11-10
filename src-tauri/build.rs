// The shell has to know which build it *is*, not which version it is: an
// overwrite install can leave the previous window running while the new
// manifest and payload are already on disk, and comparing version numbers alone
// never notices that (0.8.2 was built twice, SSR-000096 ⑤ / DEFECT-000086).
//
// So the identity is baked into the binary at compile time, from the same
// sources `scripts/write-component-versions.mjs` records in the manifest: the
// commit, whether the tree was dirty, and the Next BUILD_ID the packaged server
// will run (two packages of one commit differ only there).
use std::path::{Path, PathBuf};
use std::process::Command;

/// Files the packaging pipeline writes itself. They must not count towards
/// `dirty`, otherwise every release build would claim to be dirty — keep in
/// sync with `BUILD_GENERATED_PATHS` in scripts/build-fingerprint.mjs.
const BUILD_GENERATED_PATHS: [&str; 2] = [
    "src-tauri/resources/component-versions.json",
    "src-tauri/tauri.conf.json",
];

fn main() {
    emit_build_identity();
    tauri_build::build()
}

fn emit_build_identity() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default());
    let root = manifest_dir
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| manifest_dir.clone());

    let commit = git(&root, &["rev-parse", "HEAD"]).unwrap_or_default();
    let commit_short = git(&root, &["rev-parse", "--short=7", "HEAD"]).unwrap_or_default();
    let dirty = {
        let args = status_args();
        let args = args.iter().map(String::as_str).collect::<Vec<_>>();
        git(&root, &args)
            .map(|output| !output.trim().is_empty())
            .unwrap_or(false)
    };

    println!("cargo:rustc-env=PI_AGENT_DESKTOP_GIT_COMMIT={commit}");
    println!("cargo:rustc-env=PI_AGENT_DESKTOP_GIT_COMMIT_SHORT={commit_short}");
    println!(
        "cargo:rustc-env=PI_AGENT_DESKTOP_GIT_DIRTY={}",
        if dirty { "1" } else { "0" }
    );

    let build_id_path = root.join(".next-desktop").join("BUILD_ID");
    let build_id = std::fs::read_to_string(&build_id_path)
        .map(|value| value.trim().to_string())
        .unwrap_or_default();
    println!("cargo:rustc-env=PI_AGENT_DESKTOP_BUILD_ID={build_id}");

    // A checkout is not a source-file change, so without this a rebuild after
    // switching commits would keep the previous identity — the one thing this
    // value must never be. Same for a new Next build under a running cargo
    // target directory.
    if let Some(git_dir) = git(&root, &["rev-parse", "--git-dir"]) {
        let git_dir = resolve_git_dir(&root, git_dir.trim());
        println!("cargo:rerun-if-changed={}", git_dir.join("HEAD").display());
    }
    println!("cargo:rerun-if-changed={}", build_id_path.display());
}

fn status_args() -> Vec<String> {
    let mut args: Vec<String> = ["status", "--porcelain", "--untracked-files=all", "--"]
        .iter()
        .map(|value| (*value).to_string())
        .collect();
    args.extend(
        BUILD_GENERATED_PATHS
            .iter()
            .map(|path| format!(":(exclude){path}")),
    );
    args
}

fn git(root: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout).ok()
}

/// `--git-dir` can be relative to the repository root (worktree metadata such
/// as `.git/worktrees/<name>`) and absolute elsewhere; `git -C` resolved it
/// against `root`, so join the same way.
fn resolve_git_dir(root: &Path, value: &str) -> PathBuf {
    let path = PathBuf::from(value);
    if path.is_absolute() {
        path
    } else {
        root.join(path)
    }
}
