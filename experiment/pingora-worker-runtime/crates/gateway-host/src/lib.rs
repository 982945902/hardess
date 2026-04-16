mod public_error;

use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::HashMap;
use std::io::Read;
use std::mem;
use std::path::Path;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::sync::Arc;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use std::time::Instant;

use anyhow::bail;
use anyhow::Context;
use anyhow::Result;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use deno_ast::MediaType;
use deno_ast::ParseParams;
use deno_ast::SourceMapOption;
use deno_core::convert::Uint8Array;
use deno_core::error::ModuleLoaderError;
use deno_core::op2;
use deno_core::resolve_import;
use deno_core::resolve_path;
use deno_core::serde_v8;
use deno_core::v8;
use deno_core::GarbageCollected;
use deno_core::JsRuntime;
use deno_core::ModuleLoadOptions;
use deno_core::ModuleLoadReferrer;
use deno_core::ModuleLoadResponse;
use deno_core::ModuleLoader;
use deno_core::ModuleSource;
use deno_core::ModuleSourceCode;
use deno_core::ModuleSpecifier;
use deno_core::ModuleType;
use deno_core::ResolutionKind;
use deno_core::RuntimeOptions;
use deno_error::JsErrorBox;
use pingora::protocols::http::ServerSession;
use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;
use sha2::Sha512;
use tokio::runtime::RuntimeFlavor;
use tokio::sync::mpsc as tokio_mpsc;
use tokio::sync::oneshot;
use tokio::sync::Notify;
use worker_abi::WorkerContext;
use worker_abi::WorkerEnv;
use worker_abi::WorkerRequest;
use worker_abi::WorkerResponse;
use worker_abi::WorkerRuntime;

pub use public_error::bad_request_public_error;
pub use public_error::internal_public_error;
pub use public_error::public_error_response;
pub use public_error::shutdown_draining_public_error;
pub use public_error::PublicError;
pub use public_error::PublicErrorCategory;

type SourceMapStore = Rc<RefCell<HashMap<String, Vec<u8>>>>;
const REMOTE_CACHE_MAX_ENTRIES: usize = 128;
const REMOTE_CACHE_MAX_BYTES: u64 = 64 * 1024 * 1024;
pub const HARDESS_REQUEST_TASK_ID_METADATA_KEY: &str = "hardess_request_task_id";
pub const HARDESS_CLIENT_ADDR_METADATA_KEY: &str = "hardess_client_addr";
pub const HARDESS_HTTP_VERSION_METADATA_KEY: &str = "hardess_http_version";
pub const HARDESS_REQUEST_BODY_MODE_METADATA_KEY: &str = "hardess_request_body_mode";
pub const HARDESS_REQUEST_COMPLETION_POLICY_METADATA_KEY: &str =
    "hardess_request_completion_policy";
pub const HARDESS_RUNTIME_SHARD_METADATA_KEY: &str = "hardess_runtime_shard";

#[derive(Debug, Clone)]
struct WorkerProjectConfig {
    #[allow(dead_code)]
    root_dir: PathBuf,
    worker_entry: PathBuf,
    config_path: Option<PathBuf>,
    cache_dir: PathBuf,
    config_specifier: ModuleSpecifier,
    imports: HashMap<String, String>,
    lockfile: Option<LoadedDenoLockfile>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct WorkerProjectSnapshot {
    pub root_dir: String,
    pub artifact_id: String,
    pub deno_json_path: Option<String>,
    pub module_cache_dir: String,
    pub module_cache: WorkerModuleCacheSnapshot,
    pub imports: Vec<String>,
    pub deno_lock_path: Option<String>,
    pub deno_lock_frozen: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct WorkerModuleCacheSnapshot {
    pub entry_count: usize,
    pub total_bytes: u64,
}

#[derive(Debug, Deserialize)]
struct DenoJsonConfig {
    #[serde(default)]
    imports: HashMap<String, String>,
    #[serde(default)]
    lock: Option<DenoJsonLockConfig>,
}

#[derive(Debug, Clone)]
struct LoadedDenoLockfile {
    path: PathBuf,
    frozen: bool,
    remote: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum DenoJsonLockConfig {
    Disabled(bool),
    Path(String),
    Object {
        path: Option<String>,
        #[serde(default)]
        frozen: bool,
    },
}

#[derive(Debug, Deserialize)]
struct DenoLockfileDocument {
    #[allow(dead_code)]
    version: Option<String>,
    #[serde(default)]
    remote: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedRemoteModuleMetadata {
    url: String,
    content_type: Option<String>,
}

#[derive(Debug)]
struct CachedRemoteModuleEntry {
    body_path: PathBuf,
    meta_path: PathBuf,
    body_bytes: u64,
    meta_bytes: u64,
    modified_at: std::time::SystemTime,
}

impl WorkerProjectConfig {
    fn discover(worker_entry: &Path) -> Result<Self> {
        let canonical_entry = std::fs::canonicalize(worker_entry).with_context(|| {
            format!(
                "unable to canonicalize worker entry {}",
                worker_entry.display()
            )
        })?;
        let start_dir = canonical_entry
            .parent()
            .with_context(|| {
                format!(
                    "worker entry {} must have a parent directory",
                    canonical_entry.display()
                )
            })?
            .to_path_buf();

        for candidate_dir in start_dir.ancestors() {
            let deno_json_path = candidate_dir.join("deno.json");
            if !deno_json_path.is_file() {
                continue;
            }

            let raw = std::fs::read_to_string(&deno_json_path)
                .with_context(|| format!("unable to read {}", deno_json_path.display()))?;
            let parsed: DenoJsonConfig = serde_json::from_str(&raw)
                .with_context(|| format!("unable to parse {}", deno_json_path.display()))?;
            let config_specifier = resolve_path(
                deno_json_path
                    .to_str()
                    .context("deno.json path must be valid UTF-8")?,
                &std::env::current_dir().context("unable to get current directory")?,
            )?;
            let lockfile = resolve_lockfile(candidate_dir, parsed.lock.as_ref())?;
            let cache_dir = candidate_dir.join(".hardess-cache").join("remote_modules");

            return Ok(Self {
                root_dir: candidate_dir.to_path_buf(),
                worker_entry: canonical_entry.clone(),
                config_path: Some(deno_json_path),
                cache_dir,
                config_specifier,
                imports: parsed.imports,
                lockfile,
            });
        }

        let root_dir = start_dir.clone();
        let config_specifier = resolve_path(
            root_dir
                .join("__hardess_virtual_deno_json__")
                .to_str()
                .context("virtual deno.json path must be valid UTF-8")?,
            &std::env::current_dir().context("unable to get current directory")?,
        )?;

        Ok(Self {
            root_dir,
            worker_entry: canonical_entry,
            config_path: None,
            cache_dir: start_dir.join(".hardess-cache").join("remote_modules"),
            config_specifier,
            imports: HashMap::new(),
            lockfile: None,
        })
    }

    fn snapshot(&self) -> Result<WorkerProjectSnapshot> {
        let mut imports = self.imports.keys().cloned().collect::<Vec<_>>();
        imports.sort();
        let module_cache = self.prune_and_inventory_cache()?;
        let artifact_id = self.compute_artifact_id()?;

        Ok(WorkerProjectSnapshot {
            root_dir: self.root_dir.display().to_string(),
            artifact_id,
            deno_json_path: self
                .config_path
                .as_ref()
                .map(|path| path.display().to_string()),
            module_cache_dir: self.cache_dir.display().to_string(),
            module_cache,
            imports,
            deno_lock_path: self
                .lockfile
                .as_ref()
                .map(|lockfile| lockfile.path.display().to_string()),
            deno_lock_frozen: self
                .lockfile
                .as_ref()
                .is_some_and(|lockfile| lockfile.frozen),
        })
    }

    fn resolve_import_map_specifier(
        &self,
        specifier: &str,
    ) -> Result<Option<String>, ModuleLoaderError> {
        if let Some(target) = self.imports.get(specifier) {
            return self.normalize_import_target(target, "").map(Some);
        }

        let mut best_prefix: Option<(&str, &str)> = None;
        for (key, value) in &self.imports {
            if !key.ends_with('/') || !specifier.starts_with(key) {
                continue;
            }
            match best_prefix {
                Some((existing, _)) if existing.len() >= key.len() => {}
                _ => best_prefix = Some((key.as_str(), value.as_str())),
            }
        }

        if let Some((key, target)) = best_prefix {
            return self
                .normalize_import_target(target, &specifier[key.len()..])
                .map(Some);
        }

        Ok(None)
    }

    fn normalize_import_target(
        &self,
        target: &str,
        suffix: &str,
    ) -> Result<String, ModuleLoaderError> {
        let combined = format!("{target}{suffix}");
        if is_package_specifier(&combined) {
            return Ok(combined);
        }

        if looks_like_relative_or_absolute_specifier(&combined) {
            return resolve_import(&combined, self.config_specifier.as_str())
                .map(|specifier| specifier.to_string())
                .map_err(JsErrorBox::from_err);
        }

        Ok(combined)
    }

    fn verify_module(
        &self,
        module_specifier: &ModuleSpecifier,
        source_bytes: &[u8],
    ) -> Result<(), ModuleLoaderError> {
        self.validate_module(module_specifier, source_bytes)
            .map_err(|error| JsErrorBox::generic(error).into())
    }

    fn validate_module(
        &self,
        module_specifier: &ModuleSpecifier,
        source_bytes: &[u8],
    ) -> std::result::Result<(), String> {
        let Some(lockfile) = &self.lockfile else {
            return Ok(());
        };

        if !matches!(module_specifier.scheme(), "http" | "https") {
            return Ok(());
        }

        let Some(expected) = lockfile.remote.get(module_specifier.as_str()) else {
            if lockfile.frozen {
                return Err(format!(
                    "Module not found in frozen lockfile: {}",
                    module_specifier.as_str()
                ));
            }
            return Ok(());
        };

        if integrity_matches(expected, source_bytes) {
            return Ok(());
        }

        Err(format!(
            "Integrity check failed for {} using lockfile {}",
            module_specifier.as_str(),
            lockfile.path.display()
        ))
    }

    fn try_load_cached_remote_module(
        &self,
        module_specifier: &ModuleSpecifier,
    ) -> Result<Option<(Vec<u8>, Option<String>)>, ModuleLoaderError> {
        let (body_path, meta_path) = self.remote_cache_paths(module_specifier);
        if !body_path.is_file() || !meta_path.is_file() {
            return Ok(None);
        }

        let body = std::fs::read(&body_path).map_err(JsErrorBox::from_err)?;
        let metadata_raw = std::fs::read_to_string(&meta_path).map_err(JsErrorBox::from_err)?;
        let metadata: CachedRemoteModuleMetadata = serde_json::from_str(&metadata_raw)
            .map_err(|error| JsErrorBox::generic(error.to_string()))?;
        if metadata.url != module_specifier.as_str() {
            let _ = std::fs::remove_file(&body_path);
            let _ = std::fs::remove_file(&meta_path);
            return Ok(None);
        }

        match self.validate_module(module_specifier, &body) {
            Ok(()) => Ok(Some((body, metadata.content_type))),
            Err(error) if error.contains("Integrity check failed") => {
                let _ = std::fs::remove_file(&body_path);
                let _ = std::fs::remove_file(&meta_path);
                Ok(None)
            }
            Err(error) => Err(JsErrorBox::generic(error).into()),
        }
    }

    fn store_cached_remote_module(
        &self,
        module_specifier: &ModuleSpecifier,
        source_bytes: &[u8],
        content_type: Option<&str>,
    ) -> Result<(), ModuleLoaderError> {
        std::fs::create_dir_all(&self.cache_dir).map_err(JsErrorBox::from_err)?;
        let (body_path, meta_path) = self.remote_cache_paths(module_specifier);
        let metadata = CachedRemoteModuleMetadata {
            url: module_specifier.as_str().to_string(),
            content_type: content_type.map(str::to_string),
        };
        let metadata_json = serde_json::to_vec_pretty(&metadata)
            .map_err(|error| JsErrorBox::generic(error.to_string()))?;
        std::fs::write(&body_path, source_bytes).map_err(JsErrorBox::from_err)?;
        std::fs::write(&meta_path, metadata_json).map_err(JsErrorBox::from_err)?;
        Ok(())
    }

    fn remote_cache_paths(&self, module_specifier: &ModuleSpecifier) -> (PathBuf, PathBuf) {
        let key = hex_digest(&Sha256::digest(module_specifier.as_str().as_bytes()));
        (
            self.cache_dir.join(format!("{key}.body")),
            self.cache_dir.join(format!("{key}.meta.json")),
        )
    }

    fn prune_and_inventory_cache(&self) -> Result<WorkerModuleCacheSnapshot> {
        if !self.cache_dir.is_dir() {
            return Ok(WorkerModuleCacheSnapshot {
                entry_count: 0,
                total_bytes: 0,
            });
        }

        let mut body_paths = HashMap::<String, PathBuf>::new();
        let mut meta_paths = HashMap::<String, PathBuf>::new();
        let mut unknown_paths = Vec::new();

        for entry in std::fs::read_dir(&self.cache_dir).map_err(anyhow::Error::from)? {
            let entry = entry.map_err(anyhow::Error::from)?;
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                unknown_paths.push(path);
                continue;
            };

            if let Some(key) = name.strip_suffix(".body") {
                body_paths.insert(key.to_string(), path);
                continue;
            }

            if let Some(key) = name.strip_suffix(".meta.json") {
                meta_paths.insert(key.to_string(), path);
                continue;
            }

            unknown_paths.push(path);
        }

        for path in unknown_paths {
            let _ = std::fs::remove_file(path);
        }

        let mut keys = body_paths
            .keys()
            .chain(meta_paths.keys())
            .cloned()
            .collect::<Vec<_>>();
        keys.sort();
        keys.dedup();

        let mut retained = Vec::new();
        for key in keys {
            let Some(body_path) = body_paths.remove(&key) else {
                if let Some(meta_path) = meta_paths.remove(&key) {
                    let _ = std::fs::remove_file(meta_path);
                }
                continue;
            };
            let Some(meta_path) = meta_paths.remove(&key) else {
                let _ = std::fs::remove_file(body_path);
                continue;
            };

            let body_metadata = match std::fs::metadata(&body_path) {
                Ok(metadata) => metadata,
                Err(_) => {
                    let _ = std::fs::remove_file(&body_path);
                    let _ = std::fs::remove_file(&meta_path);
                    continue;
                }
            };
            let meta_metadata = match std::fs::metadata(&meta_path) {
                Ok(metadata) => metadata,
                Err(_) => {
                    let _ = std::fs::remove_file(&body_path);
                    let _ = std::fs::remove_file(&meta_path);
                    continue;
                }
            };
            let metadata_raw = match std::fs::read_to_string(&meta_path) {
                Ok(raw) => raw,
                Err(_) => {
                    let _ = std::fs::remove_file(&body_path);
                    let _ = std::fs::remove_file(&meta_path);
                    continue;
                }
            };
            let metadata: CachedRemoteModuleMetadata = match serde_json::from_str(&metadata_raw) {
                Ok(metadata) => metadata,
                Err(_) => {
                    let _ = std::fs::remove_file(&body_path);
                    let _ = std::fs::remove_file(&meta_path);
                    continue;
                }
            };

            if self
                .lockfile
                .as_ref()
                .is_some_and(|lockfile| !lockfile.remote.contains_key(&metadata.url))
            {
                let _ = std::fs::remove_file(&body_path);
                let _ = std::fs::remove_file(&meta_path);
                continue;
            }

            let modified_at = body_metadata
                .modified()
                .or_else(|_| meta_metadata.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            retained.push(CachedRemoteModuleEntry {
                body_path,
                meta_path,
                body_bytes: body_metadata.len(),
                meta_bytes: meta_metadata.len(),
                modified_at,
            });
        }

        retained.sort_by(|left, right| right.modified_at.cmp(&left.modified_at));

        let mut running_entries = 0_usize;
        let mut running_bytes = 0_u64;
        let mut kept = Vec::new();
        for entry in retained {
            let entry_bytes = entry.body_bytes + entry.meta_bytes;
            if running_entries >= REMOTE_CACHE_MAX_ENTRIES
                || running_bytes + entry_bytes > REMOTE_CACHE_MAX_BYTES
            {
                let _ = std::fs::remove_file(&entry.body_path);
                let _ = std::fs::remove_file(&entry.meta_path);
                continue;
            }
            running_entries += 1;
            running_bytes += entry_bytes;
            kept.push(entry);
        }

        Ok(WorkerModuleCacheSnapshot {
            entry_count: kept.len(),
            total_bytes: kept
                .iter()
                .map(|entry| entry.body_bytes + entry.meta_bytes)
                .sum(),
        })
    }

    fn compute_artifact_id(&self) -> Result<String> {
        let mut hasher = Sha256::new();
        let files = self.collect_artifact_files(&self.root_dir)?;
        for path in files {
            let relative = path
                .strip_prefix(&self.root_dir)
                .unwrap_or(&path)
                .to_string_lossy();
            hasher.update(relative.as_bytes());
            hasher.update([0]);
            let bytes = std::fs::read(&path)
                .with_context(|| format!("unable to read artifact file {}", path.display()))?;
            hasher.update(&bytes);
            hasher.update([0xff]);
        }
        hasher.update(self.worker_entry.to_string_lossy().as_bytes());
        Ok(format!("local-sha256:{}", hex_digest(&hasher.finalize())))
    }

    fn collect_artifact_files(&self, dir: &Path) -> Result<Vec<PathBuf>> {
        let mut files = Vec::new();
        self.collect_artifact_files_into(dir, &mut files)?;
        files.sort();
        Ok(files)
    }

    fn collect_artifact_files_into(&self, dir: &Path, files: &mut Vec<PathBuf>) -> Result<()> {
        for entry in std::fs::read_dir(dir).map_err(anyhow::Error::from)? {
            let entry = entry.map_err(anyhow::Error::from)?;
            let path = entry.path();
            let file_name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("");

            if path.is_dir() {
                if matches!(file_name, ".hardess-cache" | ".git" | "target") {
                    continue;
                }
                self.collect_artifact_files_into(&path, files)?;
                continue;
            }

            if path.is_file() {
                files.push(path);
            }
        }
        Ok(())
    }
}

fn resolve_lockfile(
    project_root: &Path,
    configured_lock: Option<&DenoJsonLockConfig>,
) -> Result<Option<LoadedDenoLockfile>> {
    let (enabled, lock_path, frozen) = match configured_lock {
        Some(DenoJsonLockConfig::Disabled(false)) => return Ok(None),
        Some(DenoJsonLockConfig::Disabled(true)) => (true, project_root.join("deno.lock"), false),
        Some(DenoJsonLockConfig::Path(path)) => (true, project_root.join(path), false),
        Some(DenoJsonLockConfig::Object { path, frozen }) => (
            true,
            project_root.join(path.as_deref().unwrap_or("deno.lock")),
            *frozen,
        ),
        None => {
            let default_path = project_root.join("deno.lock");
            if default_path.is_file() {
                (true, default_path, false)
            } else {
                return Ok(None);
            }
        }
    };

    if !enabled {
        return Ok(None);
    }

    if !lock_path.is_file() {
        if frozen {
            bail!(
                "frozen lockfile is enabled but {} does not exist",
                lock_path.display()
            );
        }
        return Ok(Some(LoadedDenoLockfile {
            path: lock_path,
            frozen,
            remote: HashMap::new(),
        }));
    }

    let raw = std::fs::read_to_string(&lock_path)
        .with_context(|| format!("unable to read {}", lock_path.display()))?;
    let parsed: DenoLockfileDocument = serde_json::from_str(&raw)
        .with_context(|| format!("unable to parse {}", lock_path.display()))?;
    Ok(Some(LoadedDenoLockfile {
        path: lock_path,
        frozen,
        remote: parsed.remote,
    }))
}

fn integrity_matches(expected: &str, source_bytes: &[u8]) -> bool {
    if let Some(encoded) = expected.strip_prefix("sha256-") {
        let digest = Sha256::digest(source_bytes);
        return BASE64_STANDARD.encode(digest) == encoded;
    }

    if let Some(encoded) = expected.strip_prefix("sha512-") {
        let digest = Sha512::digest(source_bytes);
        return BASE64_STANDARD.encode(digest) == encoded;
    }

    if expected.len() == 64 && expected.chars().all(|ch| ch.is_ascii_hexdigit()) {
        let digest = Sha256::digest(source_bytes);
        return hex_digest(&digest) == expected.to_ascii_lowercase();
    }

    if expected.len() == 128 && expected.chars().all(|ch| ch.is_ascii_hexdigit()) {
        let digest = Sha512::digest(source_bytes);
        return hex_digest(&digest) == expected.to_ascii_lowercase();
    }

    false
}

fn hex_digest(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn inspect_worker_project(worker_entry: &Path) -> Result<WorkerProjectSnapshot> {
    WorkerProjectConfig::discover(worker_entry)?.snapshot()
}

fn is_package_specifier(specifier: &str) -> bool {
    specifier.starts_with("jsr:") || specifier.starts_with("npm:")
}

fn looks_like_relative_or_absolute_specifier(specifier: &str) -> bool {
    specifier.starts_with("./")
        || specifier.starts_with("../")
        || specifier.starts_with('/')
        || specifier.starts_with("file:")
        || specifier.starts_with("http:")
        || specifier.starts_with("https:")
}

fn rewrite_package_specifier(specifier: &str) -> Option<String> {
    if let Some(path) = specifier.strip_prefix("jsr:") {
        return Some(format!("https://jsr.io/{path}"));
    }

    if let Some(path) = specifier.strip_prefix("npm:") {
        return Some(format!("https://esm.sh/{path}"));
    }

    None
}

fn load_module_contents(
    project_config: &WorkerProjectConfig,
    module_specifier: &ModuleSpecifier,
) -> Result<(String, MediaType), ModuleLoaderError> {
    match module_specifier.scheme() {
        "file" => {
            let path = module_specifier
                .to_file_path()
                .map_err(|_| JsErrorBox::generic("Only valid file:// URLs are supported."))?;
            let media_type = MediaType::from_path(&path);
            let source_bytes = std::fs::read(&path).map_err(JsErrorBox::from_err)?;
            let source = String::from_utf8(source_bytes)
                .map_err(|error| JsErrorBox::generic(error.to_string()))?;
            Ok((source, media_type))
        }
        "http" | "https" => {
            if let Some((source_bytes, content_type)) =
                project_config.try_load_cached_remote_module(module_specifier)?
            {
                let source = String::from_utf8(source_bytes)
                    .map_err(|error| JsErrorBox::generic(error.to_string()))?;
                let media_type = media_type_from_remote(module_specifier, content_type.as_deref());
                return Ok((source, media_type));
            }

            let response = ureq::get(module_specifier.as_str())
                .call()
                .map_err(|error| JsErrorBox::generic(error.to_string()))?;
            let content_type = response.header("content-type").map(str::to_string);
            let mut reader = response.into_reader();
            let mut source_bytes = Vec::new();
            reader
                .read_to_end(&mut source_bytes)
                .map_err(|error| JsErrorBox::generic(error.to_string()))?;
            project_config.verify_module(module_specifier, &source_bytes)?;
            project_config.store_cached_remote_module(
                module_specifier,
                &source_bytes,
                content_type.as_deref(),
            )?;
            let source = String::from_utf8(source_bytes.to_vec())
                .map_err(|error| JsErrorBox::generic(error.to_string()))?;
            let media_type = media_type_from_remote(module_specifier, content_type.as_deref());
            Ok((source, media_type))
        }
        scheme => Err(JsErrorBox::generic(format!(
            "Unsupported module scheme `{scheme}` for {module_specifier}"
        ))
        .into()),
    }
}

fn media_type_from_remote(
    module_specifier: &ModuleSpecifier,
    content_type: Option<&str>,
) -> MediaType {
    let path_media_type = MediaType::from_path(Path::new(module_specifier.path()));
    if path_media_type != MediaType::Unknown {
        return path_media_type;
    }

    match content_type {
        Some(content_type) if content_type.contains("typescript") => MediaType::TypeScript,
        Some(content_type) if content_type.contains("json") => MediaType::Json,
        _ => MediaType::JavaScript,
    }
}

#[derive(Debug, Clone)]
pub struct GatewayRequest {
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Option<RequestBodySource>,
    completion_policy: RequestBodyCompletionPolicy,
}

impl GatewayRequest {
    pub fn buffered(mut request: WorkerRequest) -> Self {
        let body = request
            .body
            .take()
            .map(|body| RequestBodySource::buffered(body.into_bytes()));
        Self {
            method: request.method,
            url: request.url,
            headers: request.headers.into_iter().collect(),
            body,
            completion_policy: RequestBodyCompletionPolicy::AlreadyComplete,
        }
    }

    pub fn streaming(request: WorkerRequest) -> (Self, IngressRequestBody) {
        let headers: Vec<(String, String)> = request.headers.into_iter().collect();
        let completion_policy = request_body_completion_policy_from_header_entries(&headers);
        Self::streaming_parts(request.method, request.url, headers, completion_policy)
    }

    pub fn buffered_parts(method: String, url: String, headers: Vec<(String, String)>) -> Self {
        Self {
            method,
            url,
            headers,
            body: None,
            completion_policy: RequestBodyCompletionPolicy::AlreadyComplete,
        }
    }

    pub fn streaming_parts(
        method: String,
        url: String,
        headers: Vec<(String, String)>,
        completion_policy: RequestBodyCompletionPolicy,
    ) -> (Self, IngressRequestBody) {
        let (body, ingress_body) = RequestBodySource::streaming();
        (
            Self {
                method,
                url,
                headers,
                body: Some(body),
                completion_policy,
            },
            ingress_body,
        )
    }

    pub fn completion_policy(&self) -> RequestBodyCompletionPolicy {
        self.completion_policy
    }

    fn into_js_request(self) -> JsWorkerRequest {
        JsWorkerRequest {
            method: self.method,
            url: self.url,
            headers: self.headers,
            body: self.body,
        }
    }

    fn is_retry_safe(&self) -> bool {
        self.body
            .as_ref()
            .map_or(true, RequestBodySource::is_retry_safe)
    }

    fn requires_ingress_body_drive(&self) -> bool {
        self.body
            .as_ref()
            .is_some_and(RequestBodySource::requires_ingress_body_drive)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestBodyCompletionPolicy {
    AlreadyComplete,
    Drain,
    DisableKeepalive,
}

fn request_body_completion_policy_from_header_entries(
    headers: &[(String, String)],
) -> RequestBodyCompletionPolicy {
    for (name, value) in headers {
        if name.eq_ignore_ascii_case("content-length") {
            if let Ok(length) = value.trim().parse::<u64>() {
                if length == 0 {
                    return RequestBodyCompletionPolicy::AlreadyComplete;
                }
                if length <= 64 * 1024 {
                    return RequestBodyCompletionPolicy::Drain;
                }
            }
        }
    }

    if headers
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("transfer-encoding"))
    {
        return RequestBodyCompletionPolicy::DisableKeepalive;
    }

    RequestBodyCompletionPolicy::DisableKeepalive
}

#[derive(Debug, Clone)]
struct RequestBodySource {
    state: Arc<Mutex<RequestBodyState>>,
}

#[derive(Debug)]
enum RequestBodyState {
    Buffered {
        bytes: Option<Vec<u8>>,
    },
    Streaming {
        command_tx: tokio_mpsc::UnboundedSender<RequestBodyCommand>,
        started: bool,
        completed: bool,
        error: Option<String>,
    },
}

#[derive(Debug)]
enum RequestBodyCommand {
    ReadNext {
        response_tx: oneshot::Sender<Result<Option<Vec<u8>>, String>>,
    },
}

#[derive(Debug)]
pub struct IngressRequestBody {
    command_rx: tokio_mpsc::UnboundedReceiver<RequestBodyCommand>,
    finished: bool,
}

#[derive(Debug)]
pub struct GatewayResponse {
    status: u16,
    headers: std::collections::BTreeMap<String, String>,
    body: GatewayResponseBody,
}

#[derive(Debug)]
pub enum GatewayResponseBody {
    Empty,
    Buffered(Vec<u8>),
    Streaming(IngressResponseBody),
}

#[derive(Debug)]
pub struct IngressResponseBody {
    command_tx: tokio_mpsc::UnboundedSender<ResponseBodyCommand>,
    finished: bool,
}

#[derive(Debug)]
enum ResponseBodyCommand {
    ReadNext {
        response_tx: oneshot::Sender<Result<Option<Vec<u8>>, String>>,
    },
}

struct RuntimeResponseBody {
    command_rx: tokio_mpsc::UnboundedReceiver<ResponseBodyCommand>,
    reader: JsResponseChunkReader,
    finished: bool,
}

impl GatewayResponse {
    pub fn empty(status: u16, headers: std::collections::BTreeMap<String, String>) -> Self {
        Self {
            status,
            headers,
            body: GatewayResponseBody::Empty,
        }
    }

    pub fn buffered(
        status: u16,
        headers: std::collections::BTreeMap<String, String>,
        body: Vec<u8>,
    ) -> Self {
        if body.is_empty() {
            return Self::empty(status, headers);
        }

        Self {
            status,
            headers,
            body: GatewayResponseBody::Buffered(body),
        }
    }

    fn streaming(
        status: u16,
        headers: std::collections::BTreeMap<String, String>,
        reader: JsResponseChunkReader,
    ) -> (Self, RuntimeResponseBody) {
        let (command_tx, command_rx) = tokio_mpsc::unbounded_channel();
        (
            Self {
                status,
                headers,
                body: GatewayResponseBody::Streaming(IngressResponseBody {
                    command_tx,
                    finished: false,
                }),
            },
            RuntimeResponseBody {
                command_rx,
                reader,
                finished: false,
            },
        )
    }

    pub fn status(&self) -> u16 {
        self.status
    }

    pub fn headers(&self) -> &std::collections::BTreeMap<String, String> {
        &self.headers
    }

    pub fn take_body(&mut self) -> GatewayResponseBody {
        mem::replace(&mut self.body, GatewayResponseBody::Empty)
    }

    pub async fn into_worker_response(mut self) -> Result<WorkerResponse, String> {
        let body_bytes = match self.take_body() {
            GatewayResponseBody::Empty => Vec::new(),
            GatewayResponseBody::Buffered(bytes) => bytes,
            GatewayResponseBody::Streaming(mut body) => {
                let mut bytes = Vec::new();
                while let Some(chunk) = body.read_next_chunk().await? {
                    bytes.extend_from_slice(&chunk);
                }
                bytes
            }
        };

        let body = if body_bytes.is_empty() {
            None
        } else {
            Some(String::from_utf8(body_bytes).map_err(|error| error.to_string())?)
        };

        Ok(WorkerResponse {
            status: self.status,
            headers: self.headers,
            body,
        })
    }
}

impl GatewayResponseBody {
    pub async fn read_next_chunk(&mut self) -> Result<Option<Vec<u8>>, String> {
        match self {
            GatewayResponseBody::Empty => Ok(None),
            GatewayResponseBody::Buffered(bytes) => Ok(Some(mem::take(bytes))),
            GatewayResponseBody::Streaming(body) => body.read_next_chunk().await,
        }
    }
}

impl RequestBodySource {
    fn buffered(bytes: Vec<u8>) -> Self {
        Self {
            state: Arc::new(Mutex::new(RequestBodyState::Buffered {
                bytes: Some(bytes),
            })),
        }
    }

    fn streaming() -> (Self, IngressRequestBody) {
        let (command_tx, command_rx) = tokio_mpsc::unbounded_channel();
        (
            Self {
                state: Arc::new(Mutex::new(RequestBodyState::Streaming {
                    command_tx,
                    started: false,
                    completed: false,
                    error: None,
                })),
            },
            IngressRequestBody {
                command_rx,
                finished: false,
            },
        )
    }

    fn is_retry_safe(&self) -> bool {
        let state = self
            .state
            .lock()
            .expect("request body state mutex should not be poisoned");
        match &*state {
            RequestBodyState::Buffered { .. } => true,
            RequestBodyState::Streaming { started, .. } => !started,
        }
    }

    fn requires_ingress_body_drive(&self) -> bool {
        let state = self
            .state
            .lock()
            .expect("request body state mutex should not be poisoned");
        matches!(&*state, RequestBodyState::Streaming { .. })
    }

    async fn read_next_chunk(&self) -> Result<Option<Vec<u8>>, String> {
        let command_tx = {
            let mut state = self
                .state
                .lock()
                .expect("request body state mutex should not be poisoned");
            match &mut *state {
                RequestBodyState::Buffered { bytes } => return Ok(bytes.take()),
                RequestBodyState::Streaming {
                    command_tx,
                    started,
                    completed,
                    error,
                } => {
                    if *completed {
                        if let Some(error) = error.as_ref() {
                            return Err(error.clone());
                        }
                        return Ok(None);
                    }
                    *started = true;
                    command_tx.clone()
                }
            }
        };

        let (response_tx, response_rx) = oneshot::channel();
        command_tx
            .send(RequestBodyCommand::ReadNext { response_tx })
            .map_err(|_| "request body bridge is not available".to_string())?;

        let result = response_rx
            .await
            .map_err(|_| "request body bridge dropped response channel".to_string())?;

        let mut state = self
            .state
            .lock()
            .expect("request body state mutex should not be poisoned");
        if let RequestBodyState::Streaming {
            completed, error, ..
        } = &mut *state
        {
            match &result {
                Ok(Some(_)) => {}
                Ok(None) => {
                    *completed = true;
                }
                Err(body_error) => {
                    *completed = true;
                    *error = Some(body_error.clone());
                }
            }
        }

        result
    }

    async fn read_all_bytes(&self) -> Result<Vec<u8>, String> {
        let mut body = Vec::new();
        while let Some(chunk) = self.read_next_chunk().await? {
            body.extend_from_slice(&chunk);
        }
        Ok(body)
    }
}

impl IngressRequestBody {
    pub async fn service_next(&mut self, http_stream: &mut ServerSession) -> bool {
        let Some(command) = self.command_rx.recv().await else {
            return false;
        };

        match command {
            RequestBodyCommand::ReadNext { response_tx } => {
                let result = if self.finished {
                    Ok(None)
                } else {
                    match http_stream.read_request_body().await {
                        Ok(Some(bytes)) => Ok(Some(bytes.to_vec())),
                        Ok(None) => {
                            self.finished = true;
                            Ok(None)
                        }
                        Err(error) => {
                            self.finished = true;
                            Err(error.to_string())
                        }
                    }
                };
                let _ = response_tx.send(result);
                true
            }
        }
    }

    pub async fn finish(
        &mut self,
        http_stream: &mut ServerSession,
        policy: RequestBodyCompletionPolicy,
    ) -> Result<(), String> {
        if self.finished {
            return Ok(());
        }

        match policy {
            RequestBodyCompletionPolicy::AlreadyComplete => {}
            RequestBodyCompletionPolicy::Drain => {
                http_stream
                    .drain_request_body()
                    .await
                    .map_err(|error| error.to_string())?;
            }
            RequestBodyCompletionPolicy::DisableKeepalive => {
                http_stream.set_keepalive(None);
            }
        }

        self.finished = true;
        Ok(())
    }
}

impl IngressResponseBody {
    pub async fn read_next_chunk(&mut self) -> Result<Option<Vec<u8>>, String> {
        if self.finished {
            return Ok(None);
        }

        let (response_tx, response_rx) = oneshot::channel();
        self.command_tx
            .send(ResponseBodyCommand::ReadNext { response_tx })
            .map_err(|_| "response body bridge is not available".to_string())?;

        let result = response_rx
            .await
            .map_err(|_| "response body bridge dropped response channel".to_string())?;
        if !matches!(result, Ok(Some(_))) {
            self.finished = true;
        }
        result
    }
}

impl RuntimeResponseBody {
    async fn service_next(&mut self, runtime: &mut DenoWorkerRuntime) -> bool {
        let Some(command) = self.command_rx.recv().await else {
            return false;
        };

        match command {
            ResponseBodyCommand::ReadNext { response_tx } => {
                let result = if self.finished {
                    Ok(None)
                } else {
                    runtime.read_next_response_chunk(&self.reader).await
                };
                if !matches!(result, Ok(Some(_))) {
                    self.finished = true;
                }
                let _ = response_tx.send(result);
                true
            }
        }
    }

    async fn finish(&mut self, runtime: &mut DenoWorkerRuntime) {
        while self.service_next(runtime).await {}
    }
}

#[derive(Debug)]
struct JsWorkerRequest {
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Option<RequestBodySource>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct JsWorkerRequestHead {
    method: String,
    url: String,
    has_body: bool,
}

unsafe impl GarbageCollected for JsWorkerRequest {
    fn trace(&self, _visitor: &mut v8::cppgc::Visitor) {}

    fn get_name(&self) -> &'static std::ffi::CStr {
        c"WorkerRequestHandle"
    }
}

#[op2(fast)]
fn op_worker_request_is_backing(#[cppgc] request: Option<&JsWorkerRequest>) -> bool {
    request.is_some()
}

#[op2]
#[serde]
fn op_worker_request_get_head(#[cppgc] request: &JsWorkerRequest) -> JsWorkerRequestHead {
    JsWorkerRequestHead {
        method: request.method.clone(),
        url: request.url.clone(),
        has_body: request.body.is_some(),
    }
}

#[op2]
#[serde]
fn op_worker_request_get_headers(#[cppgc] request: &JsWorkerRequest) -> Vec<(String, String)> {
    request.headers.clone()
}

#[op2]
async fn op_worker_request_read_next_chunk(
    #[cppgc] request: &JsWorkerRequest,
) -> Result<Option<Uint8Array>, JsErrorBox> {
    let Some(body) = request.body.as_ref() else {
        return Ok(None);
    };
    body.read_next_chunk()
        .await
        .map(|chunk| chunk.map(Into::into))
        .map_err(JsErrorBox::generic)
}

#[op2]
async fn op_worker_request_read_all_bytes(
    #[cppgc] request: &JsWorkerRequest,
) -> Result<Uint8Array, JsErrorBox> {
    let Some(body) = request.body.as_ref() else {
        return Ok(Vec::<u8>::new().into());
    };
    body.read_all_bytes()
        .await
        .map(Into::into)
        .map_err(JsErrorBox::generic)
}

deno_core::extension!(
    hardess_runtime_bridge,
    ops = [
        op_worker_request_is_backing,
        op_worker_request_get_head,
        op_worker_request_get_headers,
        op_worker_request_read_next_chunk,
        op_worker_request_read_all_bytes,
    ]
);

const WEB_RUNTIME_BOOTSTRAP: &str = r#"
const workerRequestOps = {
  isBacking(value) {
    return Deno.core.ops.op_worker_request_is_backing(value);
  },
  head(value) {
    return Deno.core.ops.op_worker_request_get_head(value);
  },
  headers(value) {
    return Deno.core.ops.op_worker_request_get_headers(value);
  },
  async readNextChunk(value) {
    return await Deno.core.ops.op_worker_request_read_next_chunk(value);
  },
  async readAllBytes(value) {
    return await Deno.core.ops.op_worker_request_read_all_bytes(value);
  },
};

class Headers {
  static _fromLazyEntries(loadEntries) {
    const headers = Object.create(Headers.prototype);
    headers._map = undefined;
    headers._entries = undefined;
    headers._lazyEntries = loadEntries;
    return headers;
  }

  constructor(init = undefined) {
    this._map = undefined;
    this._lazyEntries = undefined;
    this._entries = Headers._normalizeEntries(init);
  }

  _normalizeName(name) {
    return String(name).toLowerCase();
  }

  _normalizeValue(value) {
    return String(value);
  }

  static _normalizeEntries(init) {
    const headerPairs = [];

    if (init instanceof Headers) {
      for (const [key, value] of init.entries()) {
        headerPairs.push([key, value]);
      }
    } else if (Array.isArray(init)) {
      for (const entry of init) {
        if (!Array.isArray(entry) || entry.length !== 2) {
          throw new TypeError("Headers init entries must be [name, value]");
        }
        headerPairs.push(entry);
      }
    } else if (init && typeof init === "object") {
      for (const [key, value] of Object.entries(init)) {
        headerPairs.push([key, value]);
      }
    }

    const map = new Map();
    for (const [name, value] of headerPairs) {
      const normalizedName = String(name).toLowerCase();
      const normalizedValue = String(value);
      const previous = map.get(normalizedName);
      map.set(
        normalizedName,
        previous ? `${previous}, ${normalizedValue}` : normalizedValue,
      );
    }
    return Array.from(map.entries());
  }

  _ensureEntries() {
    if (this._entries !== undefined) {
      return this._entries;
    }

    if (this._map !== undefined) {
      this._entries = Array.from(this._map.entries());
      return this._entries;
    }

    if (this._lazyEntries !== undefined) {
      this._entries = Headers._normalizeEntries(this._lazyEntries());
      this._lazyEntries = undefined;
      return this._entries;
    }

    this._entries = [];
    return this._entries;
  }

  _ensureMap() {
    if (this._map !== undefined) {
      return this._map;
    }

    this._map = new Map(this._ensureEntries());
    return this._map;
  }

  _syncEntriesFromMap() {
    this._entries = Array.from(this._map.entries());
  }

  append(name, value) {
    const map = this._ensureMap();
    const normalizedName = this._normalizeName(name);
    const normalizedValue = this._normalizeValue(value);
    const previous = map.get(normalizedName);
    map.set(
      normalizedName,
      previous ? `${previous}, ${normalizedValue}` : normalizedValue,
    );
    this._syncEntriesFromMap();
  }

  delete(name) {
    this._ensureMap().delete(this._normalizeName(name));
    this._syncEntriesFromMap();
  }

  get(name) {
    const normalizedName = this._normalizeName(name);
    for (const [key, value] of this._ensureEntries()) {
      if (key === normalizedName) {
        return value;
      }
    }
    return null;
  }

  has(name) {
    const normalizedName = this._normalizeName(name);
    for (const [key] of this._ensureEntries()) {
      if (key === normalizedName) {
        return true;
      }
    }
    return false;
  }

  set(name, value) {
    this._ensureMap().set(this._normalizeName(name), this._normalizeValue(value));
    this._syncEntriesFromMap();
  }

  entries() {
    return this._ensureEntries()[Symbol.iterator]();
  }

  keys() {
    return this._ensureEntries().map(([key]) => key)[Symbol.iterator]();
  }

  values() {
    return this._ensureEntries().map(([, value]) => value)[Symbol.iterator]();
  }

  forEach(callback, thisArg = undefined) {
    for (const [key, value] of this._ensureEntries()) {
      callback.call(thisArg, value, key, this);
    }
  }

  [Symbol.iterator]() {
    return this.entries();
  }
}

class RequestBody {
  constructor(inner) {
    this._inner = inner;
  }

  async nextChunk() {
    return await this._inner.readNextChunk();
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      const chunk = await this.nextChunk();
      if (chunk === null) {
        return;
      }
      yield chunk;
    }
  }
}

class InnerRequest {
  static fromBacking(input) {
    const head = workerRequestOps.head(input);
    return new InnerRequest({
      backing: input,
      head,
      backingHasBody: head.hasBody,
      method: head.method,
      url: head.url,
    });
  }

  constructor(init = undefined) {
    this._backing = init?.backing ?? null;
    this._head = init?.head;
    this._streamingBody = null;
    this._backingHasBody = init?.backingHasBody ?? false;
    this._bodyBytes = init?.bodyBytes;
    this._bodyText = init?.bodyText;
    this._headers = init?.headers;
    this._body = undefined;
    this.bodyUsed = false;
    this.method = String(init?.method ?? "GET").toUpperCase();
    this.url = String(init?.url ?? "");
  }

  static cloneFromRequest(request, init = undefined) {
    if (request._inner.hasUnreadStreamingBody()) {
      throw new TypeError(
        "Request.clone() with a streaming body is not supported in this experiment",
      );
    }

    return new InnerRequest({
      backing: request._inner._backing,
      head: request._inner._head,
      backingHasBody: request._inner._backingHasBody,
      method: init?.method ?? request.method,
      url: init?.url ?? request.url,
      headers: new Headers(init?.headers ?? request.headers),
      bodyBytes: request._inner._bodyBytes,
      bodyText:
        init && Object.hasOwn(init, "body") ? init.body : request._inner._bodyText,
    });
  }

  ensureHeaders() {
    if (this._headers !== undefined) {
      return this._headers;
    }

    if (this._backing !== null) {
      this._headers = Headers._fromLazyEntries(() => workerRequestOps.headers(this._backing));
    } else {
      this._headers = new Headers();
    }
    return this._headers;
  }

  ensureStreamingBody() {
    if (this._bodyBytes !== undefined || this._bodyText !== undefined) {
      return;
    }

    if (this._streamingBody !== null || this._backing === null) {
      return;
    }

    if (this._backingHasBody === undefined) {
      this._backingHasBody = workerRequestOps.hasBody(this._backing);
    }

    if (this._backingHasBody) {
      this._streamingBody = this._backing;
    }
  }

  hasUnreadStreamingBody() {
    this.ensureStreamingBody();
    return this._streamingBody !== null &&
      this._bodyBytes === undefined &&
      this._bodyText === undefined;
  }

  getBody() {
    if (this._body !== undefined) {
      return this._body;
    }

    if (this._bodyBytes !== undefined || this._bodyText !== undefined) {
      this._body = null;
      return this._body;
    }

    this.ensureStreamingBody();
    this._body = this._streamingBody !== null ? new RequestBody(this) : null;
    return this._body;
  }

  async readNextChunk() {
    if (this._bodyBytes !== undefined || this._bodyText !== undefined) {
      return null;
    }

    this.ensureStreamingBody();
    if (this._streamingBody === null) {
      this._body = null;
      return null;
    }

    this.bodyUsed = true;
    const chunk = await workerRequestOps.readNextChunk(this._streamingBody);
    if (chunk === null) {
      this._streamingBody = null;
      this._body = null;
    }
    return chunk;
  }

  async readAllBytes() {
    if (this.bodyUsed && this._bodyBytes === undefined && this._bodyText === undefined) {
      throw new TypeError("Body already used");
    }

    if (this._bodyBytes !== undefined) {
      return this._bodyBytes.slice();
    }

    if (this._bodyText !== undefined) {
      this._bodyBytes = Deno.core.encode(this._bodyText);
      this._body = null;
      return this._bodyBytes.slice();
    }

    this.bodyUsed = true;
    this.ensureStreamingBody();
    if (this._streamingBody === null) {
      this._bodyBytes = new Uint8Array(0);
      this._body = null;
      return this._bodyBytes.slice();
    }

    this._bodyBytes = await workerRequestOps.readAllBytes(this._streamingBody);
    this._streamingBody = null;
    this._body = null;
    return this._bodyBytes.slice();
  }
}

class Request {
  static _fromBacking(input) {
    const request = Object.create(Request.prototype);
    request._inner = InnerRequest.fromBacking(input);
    return request;
  }

  constructor(input, init = undefined) {
    if (input instanceof Request) {
      this._inner = InnerRequest.cloneFromRequest(input, init);
    } else if (workerRequestOps.isBacking(input)) {
      const inner = InnerRequest.fromBacking(input);
      if (init && Object.hasOwn(init, "headers")) {
        inner._headers = new Headers(init.headers);
      }
      if (init && Object.hasOwn(init, "body")) {
        inner._bodyText = init.body;
      }
      inner.method = String(init?.method ?? inner.method).toUpperCase();
      inner.url = String(init?.url ?? inner.url);
      this._inner = inner;
    } else {
      this._inner = new InnerRequest({
        method: init?.method ?? "GET",
        url: String(input),
        headers: new Headers(init?.headers),
        bodyText: init && Object.hasOwn(init, "body") ? init.body : undefined,
      });
    }
  }

  get method() {
    return this._inner.method;
  }

  set method(value) {
    this._inner.method = String(value).toUpperCase();
  }

  get url() {
    return this._inner.url;
  }

  set url(value) {
    this._inner.url = String(value);
  }

  get headers() {
    return this._inner.ensureHeaders();
  }

  set headers(value) {
    this._inner._headers = value instanceof Headers ? value : new Headers(value);
  }

  get body() {
    return this._inner.getBody();
  }

  set body(value) {
    this._inner._body = value;
  }

  get bodyUsed() {
    return this._inner.bodyUsed;
  }

  set bodyUsed(value) {
    this._inner.bodyUsed = Boolean(value);
  }

  async _readNextChunkForBody() {
    return await this._inner.readNextChunk();
  }

  async _readAllBytes() {
    return await this._inner.readAllBytes();
  }

  async text() {
    if (this._inner._bodyText === undefined) {
      this._inner._bodyText = Deno.core.decode(await this._readAllBytes());
    }
    this.bodyUsed = true;
    return this._inner._bodyText;
  }

  async json() {
    return JSON.parse(await this.text());
  }

  async arrayBuffer() {
    const bytes = await this._readAllBytes();
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  clone() {
    return new Request(this);
  }
}

function cloneBytes(bytes) {
  return bytes.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function toBodyBytes(value) {
  if (value instanceof Uint8Array) {
    return cloneBytes(value);
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value.slice(0));
  }
  return Deno.core.encode(String(value));
}

class ResponseBody {
  constructor(owner) {
    this._owner = owner;
  }

  async nextChunk() {
    return await this._owner._readNextChunkForBody();
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      const chunk = await this.nextChunk();
      if (chunk === null) {
        return;
      }
      yield chunk;
    }
  }
}

class Response {
  constructor(body = null, init = undefined) {
    this.status = Math.trunc(init?.status ?? 200);
    this.statusText = String(init?.statusText ?? "");
    this.headers = new Headers(init?.headers);
    this._streamingBody = null;
    this._bodyBytes = undefined;
    this._bodyText = undefined;

    if (body == null) {
      this._bodyBytes = new Uint8Array(0);
    } else if (typeof body === "string") {
      this._bodyText = body;
    } else if (body instanceof Uint8Array) {
      this._bodyBytes = cloneBytes(body);
    } else if (body instanceof ArrayBuffer) {
      this._bodyBytes = new Uint8Array(body.slice(0));
    } else if (typeof body[Symbol.asyncIterator] === "function") {
      this._streamingBody = body[Symbol.asyncIterator]();
    } else {
      this._bodyText = String(body);
    }

    this.bodyUsed = false;
    this.body = this._streamingBody !== null ? new ResponseBody(this) : null;
  }

  async _readNextChunkForBody() {
    if (this._bodyBytes !== undefined) {
      const bytes = this._bodyBytes;
      this._bodyBytes = new Uint8Array(0);
      this.body = null;
      this.bodyUsed = true;
      return bytes.byteLength === 0 ? null : cloneBytes(bytes);
    }

    if (this._bodyText !== undefined) {
      const bytes = Deno.core.encode(this._bodyText);
      this._bodyText = "";
      this.body = null;
      this.bodyUsed = true;
      return bytes.byteLength === 0 ? null : bytes;
    }

    if (this._streamingBody === null) {
      this.body = null;
      return null;
    }

    this.bodyUsed = true;
    const next = await this._streamingBody.next();
    if (next.done) {
      this._streamingBody = null;
      this.body = null;
      return null;
    }

    return toBodyBytes(next.value);
  }

  async _readAllBytes() {
    if (this.bodyUsed && this._streamingBody !== null) {
      throw new TypeError("Body already used");
    }

    if (this._bodyBytes !== undefined) {
      this.bodyUsed = true;
      this.body = null;
      return cloneBytes(this._bodyBytes);
    }

    if (this._bodyText !== undefined) {
      this.bodyUsed = true;
      this.body = null;
      return Deno.core.encode(this._bodyText);
    }

    let total = 0;
    const chunks = [];
    while (true) {
      const chunk = await this._readNextChunkForBody();
      if (chunk === null) {
        break;
      }
      total += chunk.byteLength;
      chunks.push(chunk);
    }

    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this._bodyBytes = merged;
    return cloneBytes(merged);
  }

  _bridgeCanStreamBody() {
    return this._streamingBody !== null;
  }

  _bridgeBufferedBytes() {
    if (this._streamingBody !== null) {
      throw new TypeError("Streaming response body must be consumed through bodyChunkReader");
    }

    if (this._bodyBytes !== undefined) {
      return cloneBytes(this._bodyBytes);
    }

    if (this._bodyText !== undefined) {
      return Deno.core.encode(this._bodyText);
    }

    return new Uint8Array(0);
  }

  async _bridgeReadNextChunk() {
    return await this._readNextChunkForBody();
  }

  async text() {
    if (this._bodyText === undefined) {
      this._bodyText = Deno.core.decode(await this._readAllBytes());
    }
    this.bodyUsed = true;
    return this._bodyText;
  }

  async json() {
    return JSON.parse(await this.text());
  }

  async arrayBuffer() {
    const bytes = await this._readAllBytes();
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  clone() {
    if (this._streamingBody !== null) {
      throw new TypeError(
        "Response.clone() with a streaming body is not supported in this experiment",
      );
    }
    return new Response(this._bodyText, {
      status: this.status,
      statusText: this.statusText,
      headers: this.headers,
    });
  }
}

globalThis.Headers = Headers;
globalThis.Request = Request;
globalThis.Response = Response;
"#;

struct TypescriptModuleLoader {
    source_maps: SourceMapStore,
    project_config: Rc<WorkerProjectConfig>,
}

impl ModuleLoader for TypescriptModuleLoader {
    fn resolve(
        &self,
        specifier: &str,
        referrer: &str,
        _kind: ResolutionKind,
    ) -> Result<ModuleSpecifier, ModuleLoaderError> {
        self.resolve_specifier(specifier, referrer, 0)
    }

    fn load(
        &self,
        module_specifier: &ModuleSpecifier,
        _maybe_referrer: Option<&ModuleLoadReferrer>,
        _options: ModuleLoadOptions,
    ) -> ModuleLoadResponse {
        let source_maps = self.source_maps.clone();
        let project_config = self.project_config.clone();

        fn load_module(
            source_maps: SourceMapStore,
            project_config: Rc<WorkerProjectConfig>,
            module_specifier: &ModuleSpecifier,
        ) -> Result<ModuleSource, ModuleLoaderError> {
            let (source, media_type) = load_module_contents(&project_config, module_specifier)?;

            let (module_type, should_transpile) = match media_type {
                MediaType::JavaScript | MediaType::Mjs | MediaType::Cjs => {
                    (ModuleType::JavaScript, false)
                }
                MediaType::Jsx => (ModuleType::JavaScript, true),
                MediaType::TypeScript
                | MediaType::Mts
                | MediaType::Cts
                | MediaType::Dts
                | MediaType::Dmts
                | MediaType::Dcts
                | MediaType::Tsx => (ModuleType::JavaScript, true),
                MediaType::Json => (ModuleType::Json, false),
                _ => {
                    return Err(JsErrorBox::generic(format!(
                        "Unsupported module extension for {module_specifier}",
                    )));
                }
            };

            let code = if should_transpile {
                let parsed = deno_ast::parse_module(ParseParams {
                    specifier: module_specifier.clone(),
                    text: source.into(),
                    media_type,
                    capture_tokens: false,
                    scope_analysis: false,
                    maybe_syntax: None,
                })
                .map_err(JsErrorBox::from_err)?;

                let transpiled = parsed
                    .transpile(
                        &deno_ast::TranspileOptions {
                            imports_not_used_as_values: deno_ast::ImportsNotUsedAsValues::Remove,
                            decorators: deno_ast::DecoratorsTranspileOption::Ecma,
                            ..Default::default()
                        },
                        &deno_ast::TranspileModuleOptions { module_kind: None },
                        &deno_ast::EmitOptions {
                            source_map: SourceMapOption::Separate,
                            inline_sources: true,
                            ..Default::default()
                        },
                    )
                    .map_err(JsErrorBox::from_err)?
                    .into_source();

                let source_map = transpiled
                    .source_map
                    .expect("typescript transpilation should emit a source map")
                    .into_bytes();
                source_maps
                    .borrow_mut()
                    .insert(module_specifier.to_string(), source_map);
                transpiled.text
            } else {
                source
            };

            Ok(ModuleSource::new(
                module_type,
                ModuleSourceCode::String(code.into()),
                module_specifier,
                None,
            ))
        }

        ModuleLoadResponse::Sync(load_module(source_maps, project_config, module_specifier))
    }

    fn get_source_map(&self, specifier: &str) -> Option<Cow<'_, [u8]>> {
        self.source_maps
            .borrow()
            .get(specifier)
            .map(|source_map| source_map.clone().into())
    }
}

impl TypescriptModuleLoader {
    fn resolve_specifier(
        &self,
        specifier: &str,
        referrer: &str,
        depth: usize,
    ) -> Result<ModuleSpecifier, ModuleLoaderError> {
        if depth > 8 {
            return Err(JsErrorBox::generic(format!(
                "Import resolution recursion limit exceeded for {specifier}"
            ))
            .into());
        }

        if let Some(mapped) = self
            .project_config
            .resolve_import_map_specifier(specifier)?
        {
            if mapped != specifier {
                return self.resolve_specifier(&mapped, referrer, depth + 1);
            }
        }

        if let Some(rewritten) = rewrite_package_specifier(specifier) {
            return resolve_import(&rewritten, referrer).map_err(JsErrorBox::from_err);
        }

        resolve_import(specifier, referrer).map_err(JsErrorBox::from_err)
    }
}

pub struct DenoWorkerRuntime {
    js_runtime: JsRuntime,
    invoke_bridge: v8::Global<v8::Function>,
}

struct JsResponseChunkReader {
    next_chunk: v8::Global<v8::Function>,
}

struct PendingGatewayResponse {
    response: GatewayResponse,
    runtime_body: Option<RuntimeResponseBody>,
}

struct InvokeTimings {
    arg_serialize_nanos: u64,
    js_call_nanos: u64,
    response_decode_nanos: u64,
}

impl PendingGatewayResponse {
    async fn into_worker_response(
        mut self,
        runtime: &mut DenoWorkerRuntime,
    ) -> Result<WorkerResponse, String> {
        let body_bytes = match self.response.take_body() {
            GatewayResponseBody::Empty => Vec::new(),
            GatewayResponseBody::Buffered(bytes) => bytes,
            GatewayResponseBody::Streaming(_) => {
                let mut body = Vec::new();
                let runtime_body = self.runtime_body.as_mut().ok_or_else(|| {
                    "streaming response bridge is missing runtime body".to_string()
                })?;
                loop {
                    let Some(chunk) = runtime
                        .read_next_response_chunk(&runtime_body.reader)
                        .await?
                    else {
                        break;
                    };
                    body.extend_from_slice(&chunk);
                }
                body
            }
        };

        let body = if body_bytes.is_empty() {
            None
        } else {
            Some(String::from_utf8(body_bytes).map_err(|error| error.to_string())?)
        };

        Ok(WorkerResponse {
            status: self.response.status,
            headers: self.response.headers,
            body,
        })
    }
}

struct RuntimeThreadMessage {
    request: GatewayRequest,
    env: WorkerEnv,
    ctx: WorkerContext,
    enqueued_at: Instant,
    response_tx: RuntimeThreadResponseTx,
}

struct RuntimeThreadResponse {
    result: Result<GatewayResponse, RuntimePoolError>,
    response_sent_at: Instant,
}

enum RuntimeThreadResponseTx {
    Async(oneshot::Sender<RuntimeThreadResponse>),
    Blocking(mpsc::SyncSender<RuntimeThreadResponse>),
}

enum RuntimeThreadResponseRx {
    Async(oneshot::Receiver<RuntimeThreadResponse>),
    Blocking(mpsc::Receiver<RuntimeThreadResponse>),
}

impl RuntimeThreadResponseTx {
    fn send(self, response: RuntimeThreadResponse) {
        match self {
            Self::Async(sender) => {
                let _ = sender.send(response);
            }
            Self::Blocking(sender) => {
                let _ = sender.send(response);
            }
        }
    }
}

struct RuntimeThreadInstance {
    sender: tokio_mpsc::Sender<RuntimeThreadMessage>,
}

struct RuntimeSlotState {
    generation: u64,
    instance: RuntimeThreadInstance,
}

enum WatchdogCommand {
    Arm { request_id: u64 },
    Disarm { request_id: u64 },
}

fn recycling_error(runtime_index: usize) -> RuntimePoolError {
    RuntimePoolError::Recycling(format!(
        "worker runtime slot {runtime_index} is recycling after an unhealthy execution"
    ))
}

struct WorkerRuntimeSlot {
    runtime_index: usize,
    worker_entry: PathBuf,
    queue_capacity: usize,
    exec_timeout: Duration,
    completion_mode: RuntimeCompletionMode,
    state: Mutex<RuntimeSlotState>,
    metrics: Arc<WorkerThreadMetrics>,
    pool_metrics: Arc<RuntimePoolMetrics>,
}

impl WorkerRuntimeSlot {
    fn attach_runtime_metadata(&self, mut ctx: WorkerContext) -> WorkerContext {
        ctx.metadata
            .entry(HARDESS_RUNTIME_SHARD_METADATA_KEY.to_string())
            .or_insert_with(|| self.runtime_index.to_string());
        ctx
    }

    fn should_use_blocking_completion_for_request(&self, request: &GatewayRequest) -> bool {
        self.completion_mode.should_use_blocking() && !request.requires_ingress_body_drive()
    }

    fn new(
        worker_entry: PathBuf,
        runtime_index: usize,
        queue_capacity: usize,
        exec_timeout: Duration,
        completion_mode: RuntimeCompletionMode,
        pool_metrics: Arc<RuntimePoolMetrics>,
    ) -> Result<Self> {
        let metrics = Arc::new(WorkerThreadMetrics::new(runtime_index));
        let instance = Self::spawn_instance(
            worker_entry.clone(),
            runtime_index,
            queue_capacity,
            exec_timeout,
            metrics.clone(),
            pool_metrics.clone(),
        )?;

        Ok(Self {
            runtime_index,
            worker_entry,
            queue_capacity: queue_capacity.max(1),
            exec_timeout,
            completion_mode,
            state: Mutex::new(RuntimeSlotState {
                generation: 0,
                instance,
            }),
            metrics,
            pool_metrics,
        })
    }

    fn spawn_watchdog(
        runtime_index: usize,
        exec_timeout: Duration,
        isolate_handle: v8::IsolateHandle,
        timed_out_request_id: Arc<AtomicU64>,
    ) -> Result<mpsc::Sender<WatchdogCommand>> {
        let (watchdog_tx, watchdog_rx) = mpsc::channel::<WatchdogCommand>();
        thread::Builder::new()
            .name(format!("hardess-runtime-watchdog-{runtime_index}"))
            .spawn(move || {
                let mut armed_request_id = None;
                loop {
                    if let Some(request_id) = armed_request_id {
                        match watchdog_rx.recv_timeout(exec_timeout) {
                            Ok(WatchdogCommand::Arm { request_id }) => {
                                armed_request_id = Some(request_id);
                            }
                            Ok(WatchdogCommand::Disarm {
                                request_id: completed_request_id,
                            }) => {
                                if completed_request_id == request_id {
                                    armed_request_id = None;
                                }
                            }
                            Err(mpsc::RecvTimeoutError::Timeout) => {
                                timed_out_request_id.store(request_id, Ordering::Relaxed);
                                let _ = isolate_handle.terminate_execution();
                                armed_request_id = None;
                            }
                            Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        }
                    } else {
                        match watchdog_rx.recv() {
                            Ok(WatchdogCommand::Arm { request_id }) => {
                                armed_request_id = Some(request_id);
                            }
                            Ok(WatchdogCommand::Disarm { .. }) => {}
                            Err(_) => break,
                        }
                    }
                }
            })
            .context("failed to spawn worker runtime watchdog thread")?;

        Ok(watchdog_tx)
    }

    fn spawn_instance(
        worker_entry: PathBuf,
        runtime_index: usize,
        queue_capacity: usize,
        exec_timeout: Duration,
        thread_metrics: Arc<WorkerThreadMetrics>,
        pool_metrics: Arc<RuntimePoolMetrics>,
    ) -> Result<RuntimeThreadInstance> {
        let queue_capacity = queue_capacity.max(1);
        let (sender, mut receiver) = tokio_mpsc::channel::<RuntimeThreadMessage>(queue_capacity);
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let thread_metrics_for_thread = thread_metrics.clone();
        let pool_metrics_for_thread = pool_metrics.clone();

        thread::Builder::new()
            .name(format!("hardess-runtime-{runtime_index}"))
            .spawn(move || {
                let thread_runtime = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(error) => {
                        let _ = ready_tx.send(Err(error.to_string()));
                        return;
                    }
                };
                thread_runtime.block_on(async move {
                    let mut worker_runtime = match DenoWorkerRuntime::new(&worker_entry).await {
                        Ok(runtime) => runtime,
                        Err(error) => {
                            let _ = ready_tx.send(Err(error.to_string()));
                            return;
                        }
                    };
                    let timed_out_request_id = Arc::new(AtomicU64::new(0));
                    let watchdog_tx = match Self::spawn_watchdog(
                        runtime_index,
                        exec_timeout,
                        worker_runtime.thread_safe_handle(),
                        timed_out_request_id.clone(),
                    ) {
                        Ok(sender) => sender,
                        Err(error) => {
                            let _ = ready_tx.send(Err(error.to_string()));
                            return;
                        }
                    };
                    let _ = ready_tx.send(Ok(()));
                    let mut next_request_id = 1_u64;
                    let mut should_exit = false;

                    while let Some(message) = receiver.recv().await {
                        let RuntimeThreadMessage {
                            request,
                            env,
                            ctx,
                            enqueued_at,
                            response_tx,
                        } = message;
                        thread_metrics_for_thread
                            .queue_depth
                            .fetch_sub(1, Ordering::Relaxed);
                        pool_metrics_for_thread
                            .queued
                            .fetch_sub(1, Ordering::Relaxed);
                        thread_metrics_for_thread
                            .inflight
                            .fetch_add(1, Ordering::Relaxed);
                        pool_metrics_for_thread
                            .inflight
                            .fetch_add(1, Ordering::Relaxed);
                        let request_id = next_request_id;
                        next_request_id += 1;
                        let started_at = Instant::now();
                        let queue_wait = started_at.saturating_duration_since(enqueued_at);
                        let _ = watchdog_tx.send(WatchdogCommand::Arm { request_id });
                        let worker_result = worker_runtime
                            .start_gateway_response(request, env, ctx)
                            .await;
                        let invoke_elapsed = started_at.elapsed();
                        let invoke_component_nanos =
                            worker_result.as_ref().ok().map(|(_, invoke_timings)| {
                                (
                                    invoke_timings.arg_serialize_nanos,
                                    invoke_timings.js_call_nanos,
                                    invoke_timings.response_decode_nanos,
                                )
                            });
                        let mut response_tx = Some(response_tx);
                        let result = if timed_out_request_id.load(Ordering::Relaxed) == request_id {
                            Err(RuntimePoolError::TimedOut(exec_timeout.as_millis() as u64))
                        } else {
                            match worker_result {
                                Ok((mut pending_response, _invoke_timings)) => {
                                    if let Some(response_tx) = response_tx.take() {
                                        response_tx.send(RuntimeThreadResponse {
                                            result: Ok(pending_response.response),
                                            response_sent_at: Instant::now(),
                                        });
                                    }
                                    if let Some(runtime_body) =
                                        pending_response.runtime_body.as_mut()
                                    {
                                        runtime_body.finish(&mut worker_runtime).await;
                                    }
                                    Ok(())
                                }
                                Err(error) => Err(RuntimePoolError::Worker(error)),
                            }
                        };
                        let elapsed = started_at.elapsed().as_nanos() as u64;
                        let timed_out = timed_out_request_id.load(Ordering::Relaxed) == request_id;
                        let _ = watchdog_tx.send(WatchdogCommand::Disarm { request_id });
                        if timed_out {
                            timed_out_request_id.store(0, Ordering::Relaxed);
                        }
                        thread_metrics_for_thread
                            .inflight
                            .fetch_sub(1, Ordering::Relaxed);
                        pool_metrics_for_thread
                            .inflight
                            .fetch_sub(1, Ordering::Relaxed);
                        pool_metrics_for_thread
                            .total_queue_wait_nanos
                            .fetch_add(queue_wait.as_nanos() as u64, Ordering::Relaxed);
                        pool_metrics_for_thread
                            .total_invoke_nanos
                            .fetch_add(invoke_elapsed.as_nanos() as u64, Ordering::Relaxed);
                        if let Some((arg_serialize_nanos, js_call_nanos, response_decode_nanos)) =
                            invoke_component_nanos
                        {
                            pool_metrics_for_thread
                                .total_arg_serialize_nanos
                                .fetch_add(arg_serialize_nanos, Ordering::Relaxed);
                            pool_metrics_for_thread
                                .total_js_call_nanos
                                .fetch_add(js_call_nanos, Ordering::Relaxed);
                            pool_metrics_for_thread
                                .total_response_decode_nanos
                                .fetch_add(response_decode_nanos, Ordering::Relaxed);
                        }
                        pool_metrics_for_thread
                            .total_exec_nanos
                            .fetch_add(elapsed, Ordering::Relaxed);
                        pool_metrics_for_thread
                            .exec_count
                            .fetch_add(1, Ordering::Relaxed);
                        match &result {
                            Ok(_) => {
                                thread_metrics_for_thread
                                    .completed
                                    .fetch_add(1, Ordering::Relaxed);
                                pool_metrics_for_thread
                                    .completed
                                    .fetch_add(1, Ordering::Relaxed);
                            }
                            Err(RuntimePoolError::TimedOut(_)) => {
                                thread_metrics_for_thread
                                    .timed_out
                                    .fetch_add(1, Ordering::Relaxed);
                                thread_metrics_for_thread
                                    .failed
                                    .fetch_add(1, Ordering::Relaxed);
                                thread_metrics_for_thread
                                    .unhealthy_exits
                                    .fetch_add(1, Ordering::Relaxed);
                                pool_metrics_for_thread
                                    .timed_out
                                    .fetch_add(1, Ordering::Relaxed);
                                pool_metrics_for_thread
                                    .failed
                                    .fetch_add(1, Ordering::Relaxed);
                                should_exit = true;
                            }
                            Err(_) => {
                                thread_metrics_for_thread
                                    .failed
                                    .fetch_add(1, Ordering::Relaxed);
                                pool_metrics_for_thread
                                    .failed
                                    .fetch_add(1, Ordering::Relaxed);
                            }
                        }
                        if let Some(response_tx) = response_tx.take() {
                            response_tx.send(RuntimeThreadResponse {
                                result: match result {
                                    Ok(()) => Err(RuntimePoolError::Unavailable(
                                        "worker runtime completed without a response".to_string(),
                                    )),
                                    Err(error) => Err(error),
                                },
                                response_sent_at: Instant::now(),
                            });
                        }
                        if should_exit {
                            break;
                        }
                    }

                    receiver.close();
                    let mut recycled_queued = 0_usize;
                    while let Some(message) = receiver.recv().await {
                        recycled_queued += 1;
                        thread_metrics_for_thread
                            .recycled
                            .fetch_add(1, Ordering::Relaxed);
                        thread_metrics_for_thread
                            .failed
                            .fetch_add(1, Ordering::Relaxed);
                        pool_metrics_for_thread
                            .recycled
                            .fetch_add(1, Ordering::Relaxed);
                        pool_metrics_for_thread
                            .failed
                            .fetch_add(1, Ordering::Relaxed);
                        let _ = message.response_tx.send(RuntimeThreadResponse {
                            result: Err(recycling_error(runtime_index)),
                            response_sent_at: Instant::now(),
                        });
                    }
                    if recycled_queued > 0 {
                        thread_metrics_for_thread
                            .queue_depth
                            .fetch_sub(recycled_queued, Ordering::Relaxed);
                        pool_metrics_for_thread
                            .queued
                            .fetch_sub(recycled_queued as u64, Ordering::Relaxed);
                    }
                });
            })
            .context("failed to spawn worker runtime thread")?;

        ready_rx
            .recv()
            .context("worker runtime thread exited before initialization")?
            .map_err(anyhow::Error::msg)?;

        Ok(RuntimeThreadInstance { sender })
    }

    async fn execute(
        &self,
        request: GatewayRequest,
        env: WorkerEnv,
        ctx: WorkerContext,
    ) -> Result<GatewayResponse, RuntimePoolError> {
        let ctx = self.attach_runtime_metadata(ctx);
        let (generation, sender) = {
            let state = self
                .state
                .lock()
                .expect("worker runtime slot state mutex should not be poisoned");
            (state.generation, state.instance.sender.clone())
        };
        let enqueued_at = Instant::now();
        // On the multithreaded ingress runtime, a blocking wait avoids the
        // large async wakeup cost we measured on the response handoff path.
        // But requests with a streaming ingress body still need the caller task
        // to keep servicing body-read commands while the worker is running, so
        // they must stay on the async completion path.
        let use_blocking_completion = self.should_use_blocking_completion_for_request(&request);
        let response_rx = if use_blocking_completion {
            let (response_tx, response_rx) = mpsc::sync_channel(1);
            sender
                .try_send(RuntimeThreadMessage {
                    request,
                    env,
                    ctx,
                    enqueued_at,
                    response_tx: RuntimeThreadResponseTx::Blocking(response_tx),
                })
                .map_err(|error| match error {
                    tokio_mpsc::error::TrySendError::Full(_) => RuntimePoolError::Overloaded,
                    tokio_mpsc::error::TrySendError::Closed(_) => RuntimePoolError::Unavailable(
                        "worker runtime thread is not available".to_string(),
                    ),
                })
                .inspect(|_| {
                    self.metrics.queue_depth.fetch_add(1, Ordering::Relaxed);
                    self.pool_metrics.queued.fetch_add(1, Ordering::Relaxed);
                })?;
            RuntimeThreadResponseRx::Blocking(response_rx)
        } else {
            let (response_tx, response_rx) = oneshot::channel();
            sender
                .try_send(RuntimeThreadMessage {
                    request,
                    env,
                    ctx,
                    enqueued_at,
                    response_tx: RuntimeThreadResponseTx::Async(response_tx),
                })
                .map_err(|error| match error {
                    tokio_mpsc::error::TrySendError::Full(_) => RuntimePoolError::Overloaded,
                    tokio_mpsc::error::TrySendError::Closed(_) => RuntimePoolError::Unavailable(
                        "worker runtime thread is not available".to_string(),
                    ),
                })
                .inspect(|_| {
                    self.metrics.queue_depth.fetch_add(1, Ordering::Relaxed);
                    self.pool_metrics.queued.fetch_add(1, Ordering::Relaxed);
                })?;
            RuntimeThreadResponseRx::Async(response_rx)
        };
        let result = match response_rx {
            RuntimeThreadResponseRx::Async(response_rx) => response_rx.await.map_err(|_| {
                RuntimePoolError::Unavailable(
                    "worker runtime thread dropped response channel".to_string(),
                )
            })?,
            RuntimeThreadResponseRx::Blocking(response_rx) => {
                tokio::task::block_in_place(move || {
                    response_rx.recv().map_err(|_| {
                        RuntimePoolError::Unavailable(
                            "worker runtime thread dropped response channel".to_string(),
                        )
                    })
                })?
            }
        };
        let received_at = Instant::now();
        self.pool_metrics.total_roundtrip_nanos.fetch_add(
            received_at
                .saturating_duration_since(enqueued_at)
                .as_nanos() as u64,
            Ordering::Relaxed,
        );
        self.pool_metrics.total_response_handoff_nanos.fetch_add(
            received_at
                .saturating_duration_since(result.response_sent_at)
                .as_nanos() as u64,
            Ordering::Relaxed,
        );
        let result = result.result;

        if matches!(
            &result,
            Err(RuntimePoolError::TimedOut(_)) | Err(RuntimePoolError::Unavailable(_))
        ) {
            let _ = self.rebuild_if_generation(generation);
        }

        result
    }

    fn rebuild_if_generation(&self, generation: u64) -> Result<()> {
        let mut state = self
            .state
            .lock()
            .expect("worker runtime slot state mutex should not be poisoned");
        if state.generation != generation {
            return Ok(());
        }

        let instance = Self::spawn_instance(
            self.worker_entry.clone(),
            self.runtime_index,
            self.queue_capacity,
            self.exec_timeout,
            self.metrics.clone(),
            self.pool_metrics.clone(),
        )?;
        state.generation += 1;
        state.instance = instance;
        self.metrics.rebuilds.fetch_add(1, Ordering::Relaxed);
        self.pool_metrics.rebuilt.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimePoolError {
    Overloaded,
    TimedOut(u64),
    Recycling(String),
    Unavailable(String),
    Worker(String),
}

impl RuntimePoolError {
    pub fn is_overloaded(&self) -> bool {
        matches!(self, Self::Overloaded)
    }

    pub fn is_retryable_transient(&self) -> bool {
        matches!(self, Self::Recycling(_) | Self::Unavailable(_))
    }

    pub fn message(&self) -> String {
        match self {
            Self::Overloaded => "worker runtime pool is overloaded".to_string(),
            Self::TimedOut(timeout_ms) => {
                format!("worker execution timed out after {timeout_ms}ms")
            }
            Self::Recycling(message) | Self::Unavailable(message) | Self::Worker(message) => {
                message.clone()
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeCompletionMode {
    Auto,
    Async,
    Blocking,
}

impl RuntimeCompletionMode {
    fn should_use_blocking(self) -> bool {
        match self {
            Self::Async => false,
            Self::Blocking => true,
            Self::Auto => tokio::runtime::Handle::try_current()
                .map(|handle| matches!(handle.runtime_flavor(), RuntimeFlavor::MultiThread))
                .unwrap_or(false),
        }
    }
}

pub struct WorkerRuntimePool {
    handles: Vec<WorkerRuntimeSlot>,
    next: AtomicUsize,
    metrics: Arc<RuntimePoolMetrics>,
    queue_capacity: usize,
    exec_timeout: Duration,
    completion_mode: RuntimeCompletionMode,
}

impl WorkerRuntimePool {
    pub fn new(
        worker_entry: PathBuf,
        size: usize,
        queue_capacity: usize,
        exec_timeout: Duration,
        completion_mode: RuntimeCompletionMode,
    ) -> Result<Arc<Self>> {
        let size = size.max(1);
        let queue_capacity = queue_capacity.max(1);
        let metrics = Arc::new(RuntimePoolMetrics::new());
        let mut handles = Vec::with_capacity(size);
        for runtime_index in 0..size {
            handles.push(WorkerRuntimeSlot::new(
                worker_entry.clone(),
                runtime_index,
                queue_capacity,
                exec_timeout,
                completion_mode,
                metrics.clone(),
            )?);
        }

        Ok(Arc::new(Self {
            handles,
            next: AtomicUsize::new(0),
            metrics,
            queue_capacity,
            exec_timeout,
            completion_mode,
        }))
    }

    pub async fn execute(
        &self,
        request: WorkerRequest,
        env: WorkerEnv,
        ctx: WorkerContext,
    ) -> Result<WorkerResponse, RuntimePoolError> {
        self.execute_gateway(GatewayRequest::buffered(request), env, ctx)
            .await?
            .into_worker_response()
            .await
            .map_err(RuntimePoolError::Worker)
    }

    pub async fn execute_gateway(
        &self,
        request: GatewayRequest,
        env: WorkerEnv,
        ctx: WorkerContext,
    ) -> Result<GatewayResponse, RuntimePoolError> {
        self.metrics.submitted.fetch_add(1, Ordering::Relaxed);
        let start_index = self.next.fetch_add(1, Ordering::Relaxed) % self.handles.len();
        let mut last_error = None::<RuntimePoolError>;

        for attempt in 0..2 {
            let mut saw_retryable_transient = false;

            for offset in 0..self.handles.len() {
                let index = (start_index + offset) % self.handles.len();
                let result = self.handles[index]
                    .execute(request.clone(), env.clone(), ctx.clone())
                    .await;
                match result {
                    Ok(response) => return Ok(response),
                    Err(RuntimePoolError::Overloaded) => {
                        last_error = Some(RuntimePoolError::Overloaded);
                    }
                    Err(error) if error.is_retryable_transient() => {
                        if !request.is_retry_safe() {
                            return Err(error);
                        }
                        saw_retryable_transient = true;
                        last_error = Some(error);
                    }
                    Err(error) => return Err(error),
                }
            }

            if saw_retryable_transient && attempt == 0 {
                tokio::task::yield_now().await;
                continue;
            }

            break;
        }

        let error = last_error.unwrap_or(RuntimePoolError::Overloaded);
        if error.is_overloaded() {
            self.metrics.overloaded.fetch_add(1, Ordering::Relaxed);
        }
        Err(error)
    }

    pub fn size(&self) -> usize {
        self.handles.len()
    }

    pub fn queue_capacity(&self) -> usize {
        self.queue_capacity
    }

    pub fn exec_timeout(&self) -> Duration {
        self.exec_timeout
    }

    pub fn completion_mode(&self) -> RuntimeCompletionMode {
        self.completion_mode
    }

    pub fn metrics_snapshot(&self) -> RuntimePoolSnapshot {
        let per_thread = self
            .handles
            .iter()
            .map(|handle| handle.metrics.snapshot())
            .collect::<Vec<_>>();
        let total_exec_nanos = self.metrics.total_exec_nanos.load(Ordering::Relaxed);
        let total_queue_wait_nanos = self.metrics.total_queue_wait_nanos.load(Ordering::Relaxed);
        let total_invoke_nanos = self.metrics.total_invoke_nanos.load(Ordering::Relaxed);
        let total_arg_serialize_nanos = self
            .metrics
            .total_arg_serialize_nanos
            .load(Ordering::Relaxed);
        let total_js_call_nanos = self.metrics.total_js_call_nanos.load(Ordering::Relaxed);
        let total_response_decode_nanos = self
            .metrics
            .total_response_decode_nanos
            .load(Ordering::Relaxed);
        let total_roundtrip_nanos = self.metrics.total_roundtrip_nanos.load(Ordering::Relaxed);
        let total_response_handoff_nanos = self
            .metrics
            .total_response_handoff_nanos
            .load(Ordering::Relaxed);
        let exec_count = self.metrics.exec_count.load(Ordering::Relaxed);
        let average_queue_wait_ms = if exec_count == 0 {
            0.0
        } else {
            (total_queue_wait_nanos as f64 / exec_count as f64) / 1_000_000.0
        };
        let average_invoke_ms = if exec_count == 0 {
            0.0
        } else {
            (total_invoke_nanos as f64 / exec_count as f64) / 1_000_000.0
        };
        let average_arg_serialize_ms = if exec_count == 0 {
            0.0
        } else {
            (total_arg_serialize_nanos as f64 / exec_count as f64) / 1_000_000.0
        };
        let average_js_call_ms = if exec_count == 0 {
            0.0
        } else {
            (total_js_call_nanos as f64 / exec_count as f64) / 1_000_000.0
        };
        let average_response_decode_ms = if exec_count == 0 {
            0.0
        } else {
            (total_response_decode_nanos as f64 / exec_count as f64) / 1_000_000.0
        };
        let average_exec_ms = if exec_count == 0 {
            0.0
        } else {
            (total_exec_nanos as f64 / exec_count as f64) / 1_000_000.0
        };
        let average_roundtrip_ms = if exec_count == 0 {
            0.0
        } else {
            (total_roundtrip_nanos as f64 / exec_count as f64) / 1_000_000.0
        };
        let average_response_handoff_ms = if exec_count == 0 {
            0.0
        } else {
            (total_response_handoff_nanos as f64 / exec_count as f64) / 1_000_000.0
        };

        RuntimePoolSnapshot {
            runtime_threads: self.size(),
            queue_capacity_per_thread: self.queue_capacity(),
            exec_timeout_ms: self.exec_timeout().as_millis() as u64,
            completion_mode: self.completion_mode(),
            submitted: self.metrics.submitted.load(Ordering::Relaxed),
            completed: self.metrics.completed.load(Ordering::Relaxed),
            failed: self.metrics.failed.load(Ordering::Relaxed),
            overloaded: self.metrics.overloaded.load(Ordering::Relaxed),
            timed_out: self.metrics.timed_out.load(Ordering::Relaxed),
            recycled: self.metrics.recycled.load(Ordering::Relaxed),
            rebuilt: self.metrics.rebuilt.load(Ordering::Relaxed),
            inflight: self.metrics.inflight.load(Ordering::Relaxed) as usize,
            queued: self.metrics.queued.load(Ordering::Relaxed) as usize,
            average_queue_wait_ms,
            average_invoke_ms,
            average_arg_serialize_ms,
            average_js_call_ms,
            average_response_decode_ms,
            average_exec_ms,
            average_roundtrip_ms,
            average_response_handoff_ms,
            per_thread,
        }
    }
}

struct RuntimePoolMetrics {
    submitted: AtomicU64,
    completed: AtomicU64,
    failed: AtomicU64,
    overloaded: AtomicU64,
    timed_out: AtomicU64,
    recycled: AtomicU64,
    rebuilt: AtomicU64,
    inflight: AtomicU64,
    queued: AtomicU64,
    total_queue_wait_nanos: AtomicU64,
    total_invoke_nanos: AtomicU64,
    total_arg_serialize_nanos: AtomicU64,
    total_js_call_nanos: AtomicU64,
    total_response_decode_nanos: AtomicU64,
    total_exec_nanos: AtomicU64,
    total_roundtrip_nanos: AtomicU64,
    total_response_handoff_nanos: AtomicU64,
    exec_count: AtomicU64,
}

impl RuntimePoolMetrics {
    fn new() -> Self {
        Self {
            submitted: AtomicU64::new(0),
            completed: AtomicU64::new(0),
            failed: AtomicU64::new(0),
            overloaded: AtomicU64::new(0),
            timed_out: AtomicU64::new(0),
            recycled: AtomicU64::new(0),
            rebuilt: AtomicU64::new(0),
            inflight: AtomicU64::new(0),
            queued: AtomicU64::new(0),
            total_queue_wait_nanos: AtomicU64::new(0),
            total_invoke_nanos: AtomicU64::new(0),
            total_arg_serialize_nanos: AtomicU64::new(0),
            total_js_call_nanos: AtomicU64::new(0),
            total_response_decode_nanos: AtomicU64::new(0),
            total_exec_nanos: AtomicU64::new(0),
            total_roundtrip_nanos: AtomicU64::new(0),
            total_response_handoff_nanos: AtomicU64::new(0),
            exec_count: AtomicU64::new(0),
        }
    }
}

struct WorkerThreadMetrics {
    runtime_index: usize,
    queue_depth: AtomicUsize,
    inflight: AtomicUsize,
    completed: AtomicU64,
    failed: AtomicU64,
    timed_out: AtomicU64,
    recycled: AtomicU64,
    rebuilds: AtomicU64,
    unhealthy_exits: AtomicU64,
}

impl WorkerThreadMetrics {
    fn new(runtime_index: usize) -> Self {
        Self {
            runtime_index,
            queue_depth: AtomicUsize::new(0),
            inflight: AtomicUsize::new(0),
            completed: AtomicU64::new(0),
            failed: AtomicU64::new(0),
            timed_out: AtomicU64::new(0),
            recycled: AtomicU64::new(0),
            rebuilds: AtomicU64::new(0),
            unhealthy_exits: AtomicU64::new(0),
        }
    }

    fn snapshot(&self) -> RuntimeThreadSnapshot {
        RuntimeThreadSnapshot {
            runtime_index: self.runtime_index,
            queued: self.queue_depth.load(Ordering::Relaxed),
            inflight: self.inflight.load(Ordering::Relaxed),
            completed: self.completed.load(Ordering::Relaxed),
            failed: self.failed.load(Ordering::Relaxed),
            timed_out: self.timed_out.load(Ordering::Relaxed),
            recycled: self.recycled.load(Ordering::Relaxed),
            rebuilds: self.rebuilds.load(Ordering::Relaxed),
            unhealthy_exits: self.unhealthy_exits.load(Ordering::Relaxed),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct RuntimePoolSnapshot {
    pub runtime_threads: usize,
    pub queue_capacity_per_thread: usize,
    pub exec_timeout_ms: u64,
    pub completion_mode: RuntimeCompletionMode,
    pub submitted: u64,
    pub completed: u64,
    pub failed: u64,
    pub overloaded: u64,
    pub timed_out: u64,
    pub recycled: u64,
    pub rebuilt: u64,
    pub inflight: usize,
    pub queued: usize,
    pub average_queue_wait_ms: f64,
    pub average_invoke_ms: f64,
    pub average_arg_serialize_ms: f64,
    pub average_js_call_ms: f64,
    pub average_response_decode_ms: f64,
    pub average_exec_ms: f64,
    pub average_roundtrip_ms: f64,
    pub average_response_handoff_ms: f64,
    pub per_thread: Vec<RuntimeThreadSnapshot>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RuntimeThreadSnapshot {
    pub runtime_index: usize,
    pub queued: usize,
    pub inflight: usize,
    pub completed: u64,
    pub failed: u64,
    pub timed_out: u64,
    pub recycled: u64,
    pub rebuilds: u64,
    pub unhealthy_exits: u64,
}

pub struct RequestDrainController {
    draining: std::sync::atomic::AtomicBool,
    inflight_requests: AtomicUsize,
    wake_drained: Notify,
}

impl Default for RequestDrainController {
    fn default() -> Self {
        Self::new()
    }
}

impl RequestDrainController {
    pub fn new() -> Self {
        Self {
            draining: std::sync::atomic::AtomicBool::new(false),
            inflight_requests: AtomicUsize::new(0),
            wake_drained: Notify::new(),
        }
    }

    pub fn is_draining(&self) -> bool {
        self.draining.load(Ordering::Relaxed)
    }

    pub fn inflight_requests(&self) -> usize {
        self.inflight_requests.load(Ordering::Relaxed)
    }

    pub fn start_draining(&self) -> bool {
        !self.draining.swap(true, Ordering::SeqCst)
    }

    pub fn try_acquire(&self) -> Option<InFlightRequestGuard<'_>> {
        if self.is_draining() {
            return None;
        }

        self.inflight_requests.fetch_add(1, Ordering::SeqCst);
        if self.is_draining() {
            self.finish_request();
            return None;
        }

        Some(InFlightRequestGuard { controller: self })
    }

    pub async fn wait_for_drain(&self, timeout: Duration) -> bool {
        if self.inflight_requests() == 0 {
            return true;
        }

        tokio::select! {
            _ = async {
                loop {
                    if self.inflight_requests() == 0 {
                        break;
                    }
                    self.wake_drained.notified().await;
                }
            } => true,
            _ = tokio::time::sleep(timeout) => self.inflight_requests() == 0,
        }
    }

    pub fn snapshot(&self) -> DrainSnapshot {
        DrainSnapshot {
            draining: self.is_draining(),
            inflight_requests: self.inflight_requests(),
        }
    }

    fn finish_request(&self) {
        if self.inflight_requests.fetch_sub(1, Ordering::SeqCst) == 1 && self.is_draining() {
            self.wake_drained.notify_waiters();
        }
    }
}

pub struct InFlightRequestGuard<'a> {
    controller: &'a RequestDrainController,
}

impl Drop for InFlightRequestGuard<'_> {
    fn drop(&mut self) {
        self.controller.finish_request();
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DrainSnapshot {
    pub draining: bool,
    pub inflight_requests: usize,
}

impl DenoWorkerRuntime {
    pub async fn new(worker_entry: &Path) -> Result<Self> {
        let source_map_store = Rc::new(RefCell::new(HashMap::new()));
        let project_config = Rc::new(WorkerProjectConfig::discover(worker_entry)?);
        let mut js_runtime = JsRuntime::new(RuntimeOptions {
            module_loader: Some(Rc::new(TypescriptModuleLoader {
                source_maps: source_map_store,
                project_config,
            })),
            extensions: vec![hardess_runtime_bridge::init()],
            ..Default::default()
        });
        js_runtime
            .execute_script("<web-runtime-bootstrap>", WEB_RUNTIME_BOOTSTRAP)
            .context("unable to bootstrap minimal web runtime")?;

        let worker_specifier = resolve_path(
            worker_entry
                .to_str()
                .context("worker entry path must be valid UTF-8")?,
            &std::env::current_dir().context("unable to get current directory")?,
        )?;

        let module_id = js_runtime.load_main_es_module(&worker_specifier).await?;
        let evaluation = js_runtime.mod_evaluate(module_id);
        js_runtime.run_event_loop(Default::default()).await?;
        evaluation.await?;
        let invoke_bridge =
            Self::initialize_invocation_bridge(&mut js_runtime, &worker_specifier).await?;

        Ok(Self {
            js_runtime,
            invoke_bridge,
        })
    }

    async fn initialize_invocation_bridge(
        js_runtime: &mut JsRuntime,
        worker_specifier: &ModuleSpecifier,
    ) -> Result<v8::Global<v8::Function>> {
        let worker_specifier = serde_json::to_string(worker_specifier.as_str())?;
        let bridge_bootstrap_script = format!(
            r#"(async () => {{
  const normalizeHeaders = (headersLike) => {{
    if (headersLike instanceof Headers) {{
      return Object.fromEntries(headersLike.entries());
    }}

    if (headersLike && typeof headersLike === "object") {{
      return Object.fromEntries(new Headers(headersLike).entries());
    }}

    return {{}};
  }};

  const normalizeWebResponse = async (rawResponse) => {{
    if (rawResponse instanceof Response) {{
      if (rawResponse._bridgeCanStreamBody()) {{
        return {{
          status:
            typeof rawResponse.status === "number" ? Math.trunc(rawResponse.status) : 200,
          headers: normalizeHeaders(rawResponse.headers),
          streamBody: true,
          bodyChunkReader: async () => await rawResponse._bridgeReadNextChunk(),
        }};
      }}

        return {{
          status:
            typeof rawResponse.status === "number" ? Math.trunc(rawResponse.status) : 200,
        headers: normalizeHeaders(rawResponse.headers),
        streamBody: false,
        bodyBytes: rawResponse._bridgeBufferedBytes(),
      }};
    }}

    if (rawResponse == null || typeof rawResponse !== "object") {{
      throw new Error("worker fetch() must resolve to an object response");
    }}

    let normalizedBody = rawResponse.body ?? null;
    if (normalizedBody !== null && typeof normalizedBody !== "string") {{
      normalizedBody = JSON.stringify(normalizedBody);
    }}

    return {{
      status:
        typeof rawResponse.status === "number" ? Math.trunc(rawResponse.status) : 200,
      headers: normalizeHeaders(rawResponse.headers),
      streamBody: false,
      bodyBytes:
        normalizedBody === null ? new Uint8Array(0) : Deno.core.encode(normalizedBody),
    }};
  }};

  const workerModule = await import({worker_specifier});
  const webCandidate =
    typeof workerModule.fetch === "function"
      ? workerModule.fetch
      : typeof workerModule.default?.fetch === "function"
        ? workerModule.default.fetch
        : null;
  const invokeWeb = async (requestBacking, env, ctxBase) => {{
    const request = Request._fromBacking(requestBacking);
    const waitUntilPromises = [];
    const ctx = {{
      ...ctxBase,
      waitUntil(value) {{
        waitUntilPromises.push(Promise.resolve(value));
      }},
    }};

    const rawResponse = await webCandidate(request, env, ctx);
    await Promise.allSettled(waitUntilPromises);
    return await normalizeWebResponse(rawResponse);
  }};

  if (typeof webCandidate === "function") {{
    return invokeWeb;
  }}

  throw new Error("worker module must export fetch(request, env, ctx)");
}})()"#
        );
        let value = js_runtime.execute_script(
            "<worker-invocation-bridge-bootstrap>",
            bridge_bootstrap_script,
        )?;
        #[allow(deprecated, reason = "good enough for experiment bootstrap")]
        let resolved = js_runtime.resolve_value(value).await?;

        let invoke_bridge = {
            deno_core::scope!(scope, js_runtime);
            let local = v8::Local::new(scope, resolved);
            let invoke_bridge = v8::Local::<v8::Function>::try_from(local)
                .map_err(|_| anyhow::anyhow!("worker invocation bridge must return a function"))?;

            v8::Global::new(scope, invoke_bridge)
        };
        Ok(invoke_bridge)
    }

    fn thread_safe_handle(&mut self) -> v8::IsolateHandle {
        self.js_runtime.v8_isolate().thread_safe_handle()
    }

    fn object_property<'s, 'i>(
        scope: &mut v8::PinScope<'s, 'i>,
        object: v8::Local<'s, v8::Object>,
        name: &str,
    ) -> Result<v8::Local<'s, v8::Value>, String> {
        let key = v8::String::new(scope, name)
            .ok_or_else(|| format!("unable to allocate V8 string for `{name}`"))?;
        object
            .get(scope, key.into())
            .ok_or_else(|| format!("worker response is missing `{name}`"))
    }

    fn bytes_from_v8_value(value: v8::Local<v8::Value>) -> Result<Vec<u8>, String> {
        if let Ok(view) = v8::Local::<v8::ArrayBufferView>::try_from(value) {
            let len = view.byte_length();
            let mut bytes = vec![0_u8; len];
            let copied = view.copy_contents(&mut bytes);
            bytes.truncate(copied);
            return Ok(bytes);
        }

        if let Ok(buffer) = v8::Local::<v8::ArrayBuffer>::try_from(value) {
            let len = buffer.byte_length();
            if len == 0 {
                return Ok(Vec::new());
            }

            let Some(ptr) = buffer.data() else {
                return Ok(Vec::new());
            };
            let bytes =
                unsafe { std::slice::from_raw_parts(ptr.as_ptr().cast::<u8>(), len) }.to_vec();
            return Ok(bytes);
        }

        Err("worker response body must be ArrayBuffer or ArrayBufferView".to_string())
    }

    fn v8_string<'s>(
        scope: &mut v8::PinScope<'s, '_>,
        value: &str,
    ) -> Result<v8::Local<'s, v8::String>> {
        v8::String::new(scope, value).context(format!("unable to allocate V8 string for `{value}`"))
    }

    fn set_object_property<'s>(
        scope: &mut v8::PinScope<'s, '_>,
        object: v8::Local<'s, v8::Object>,
        name: &str,
        value: v8::Local<'s, v8::Value>,
    ) -> Result<()> {
        let key = Self::v8_string(scope, name)?;
        object
            .set(scope, key.into(), value)
            .context(format!("unable to set V8 object property `{name}`"))?;
        Ok(())
    }

    fn string_map_to_v8_object<'s>(
        scope: &mut v8::PinScope<'s, '_>,
        values: &std::collections::BTreeMap<String, String>,
    ) -> Result<v8::Local<'s, v8::Object>> {
        let object = v8::Object::new(scope);
        for (key, value) in values {
            let value = Self::v8_string(scope, value)?;
            Self::set_object_property(scope, object, key, value.into())?;
        }
        Ok(object)
    }

    fn worker_env_to_v8<'s>(
        scope: &mut v8::PinScope<'s, '_>,
        env: &WorkerEnv,
    ) -> Result<v8::Local<'s, v8::Value>> {
        let object = v8::Object::new(scope);
        let worker_id = Self::v8_string(scope, &env.worker_id)?;
        Self::set_object_property(scope, object, "worker_id", worker_id.into())?;
        let vars = Self::string_map_to_v8_object(scope, &env.vars)?;
        Self::set_object_property(scope, object, "vars", vars.into())?;
        Ok(object.into())
    }

    fn worker_context_to_v8<'s>(
        scope: &mut v8::PinScope<'s, '_>,
        ctx: &WorkerContext,
    ) -> Result<v8::Local<'s, v8::Value>> {
        let object = v8::Object::new(scope);
        let metadata = Self::string_map_to_v8_object(scope, &ctx.metadata)?;
        Self::set_object_property(scope, object, "metadata", metadata.into())?;
        Ok(object.into())
    }

    fn serialize_invocation_args(
        &mut self,
        request: GatewayRequest,
        env: &WorkerEnv,
        ctx: &WorkerContext,
    ) -> Result<[v8::Global<v8::Value>; 3]> {
        let runtime = &mut self.js_runtime;
        deno_core::scope!(scope, runtime);

        let request = v8::Local::<v8::Value>::from(deno_core::cppgc::make_cppgc_object(
            scope,
            request.into_js_request(),
        ));
        let values = [
            request,
            Self::worker_env_to_v8(scope, env)?,
            Self::worker_context_to_v8(scope, ctx)?,
        ];

        Ok(values.map(|value| v8::Global::new(scope, value)))
    }

    async fn read_next_response_chunk(
        &mut self,
        reader: &JsResponseChunkReader,
    ) -> Result<Option<Vec<u8>>, String> {
        #[allow(
            deprecated,
            reason = "good enough while migrating off the script bridge"
        )]
        let resolved = self
            .js_runtime
            .call_with_args_and_await(&reader.next_chunk, &[])
            .await
            .map_err(|error| error.to_string())?;

        let runtime = &mut self.js_runtime;
        deno_core::scope!(scope, runtime);
        let local = v8::Local::new(scope, resolved);
        if local.is_null_or_undefined() {
            return Ok(None);
        }

        Self::bytes_from_v8_value(local).map(Some)
    }

    async fn start_gateway_response(
        &mut self,
        request: GatewayRequest,
        env: WorkerEnv,
        ctx: WorkerContext,
    ) -> Result<(PendingGatewayResponse, InvokeTimings), String> {
        let serialize_started_at = Instant::now();
        let args = self
            .serialize_invocation_args(request, &env, &ctx)
            .map_err(|error| error.to_string())?;
        let arg_serialize_nanos = serialize_started_at.elapsed().as_nanos() as u64;
        let js_call_started_at = Instant::now();
        #[allow(
            deprecated,
            reason = "good enough while migrating off the script bridge"
        )]
        let resolved = self
            .js_runtime
            .call_with_args_and_await(&self.invoke_bridge, &args)
            .await
            .map_err(|error| error.to_string())?;
        let js_call_nanos = js_call_started_at.elapsed().as_nanos() as u64;

        let response_decode_started_at = Instant::now();
        let runtime = &mut self.js_runtime;
        deno_core::scope!(scope, runtime);
        let local = v8::Local::new(scope, resolved);
        let response_object = v8::Local::<v8::Object>::try_from(local)
            .map_err(|_| "worker response bridge must resolve to an object".to_string())?;

        let status_value = Self::object_property(scope, response_object, "status")?;
        let status =
            serde_v8::from_v8::<u16>(scope, status_value).map_err(|error| error.to_string())?;
        let headers_value = Self::object_property(scope, response_object, "headers")?;
        let headers =
            serde_v8::from_v8::<std::collections::BTreeMap<String, String>>(scope, headers_value)
                .map_err(|error| error.to_string())?;
        let stream_body_value = Self::object_property(scope, response_object, "streamBody")?;
        let stream_body = serde_v8::from_v8::<bool>(scope, stream_body_value)
            .map_err(|error| error.to_string())?;

        if stream_body {
            let reader_value = Self::object_property(scope, response_object, "bodyChunkReader")?;
            let reader_function = v8::Local::<v8::Function>::try_from(reader_value)
                .map_err(|_| "worker response bodyChunkReader must be a function".to_string())?;
            let (response, runtime_body) = GatewayResponse::streaming(
                status,
                headers,
                JsResponseChunkReader {
                    next_chunk: v8::Global::new(scope, reader_function),
                },
            );
            let response_decode_nanos = response_decode_started_at.elapsed().as_nanos() as u64;
            return Ok((
                PendingGatewayResponse {
                    response,
                    runtime_body: Some(runtime_body),
                },
                InvokeTimings {
                    arg_serialize_nanos,
                    js_call_nanos,
                    response_decode_nanos,
                },
            ));
        }

        let body_value = Self::object_property(scope, response_object, "bodyBytes")?;
        let body = if body_value.is_null_or_undefined() {
            Vec::new()
        } else {
            Self::bytes_from_v8_value(body_value)?
        };

        let response_decode_nanos = response_decode_started_at.elapsed().as_nanos() as u64;
        Ok((
            PendingGatewayResponse {
                response: GatewayResponse::buffered(status, headers, body),
                runtime_body: None,
            },
            InvokeTimings {
                arg_serialize_nanos,
                js_call_nanos,
                response_decode_nanos,
            },
        ))
    }
}

impl WorkerRuntime for DenoWorkerRuntime {
    fn name(&self) -> &'static str {
        "deno_core"
    }

    async fn fetch(
        &mut self,
        request: WorkerRequest,
        env: WorkerEnv,
        ctx: WorkerContext,
    ) -> Result<WorkerResponse, String> {
        self.fetch_gateway(GatewayRequest::buffered(request), env, ctx)
            .await
    }
}

impl DenoWorkerRuntime {
    async fn fetch_gateway(
        &mut self,
        request: GatewayRequest,
        env: WorkerEnv,
        ctx: WorkerContext,
    ) -> Result<WorkerResponse, String> {
        let (pending, _) = self.start_gateway_response(request, env, ctx).await?;
        pending.into_worker_response(self).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::io::Write;
    use std::net::TcpListener;
    use std::sync::mpsc as std_mpsc;
    use std::thread::JoinHandle;
    use std::time::SystemTime;
    use std::time::UNIX_EPOCH;
    use tokio::sync::Barrier;

    fn sample_worker_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../workers/hello/mod.ts")
    }

    fn blocking_worker_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../workers/blocking/mod.ts")
    }

    fn flaky_worker_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../workers/flaky/mod.ts")
    }

    fn import_map_worker_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../workers/import_map/mod.ts")
    }

    fn unique_temp_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after unix epoch")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "hardess-pingora-worker-runtime-{name}-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir should be created");
        dir
    }

    fn write_file(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("parent dir should exist");
        }
        std::fs::write(path, contents).expect("file should be written");
    }

    fn temp_worker_path(name: &str, source: &str) -> PathBuf {
        let worker_dir = unique_temp_dir(name);
        let worker_path = worker_dir.join("mod.ts");
        write_file(&worker_path, source);
        worker_path
    }

    async fn drive_ingress_chunks(mut ingress_body: IngressRequestBody, chunks: Vec<Vec<u8>>) {
        let mut chunks = chunks.into_iter();
        while let Some(command) = ingress_body.command_rx.recv().await {
            match command {
                RequestBodyCommand::ReadNext { response_tx } => {
                    if let Some(chunk) = chunks.next() {
                        let _ = response_tx.send(Ok(Some(chunk)));
                    } else {
                        ingress_body.finished = true;
                        let _ = response_tx.send(Ok(None));
                        break;
                    }
                }
            }
        }
    }

    fn sha256_integrity(contents: &str) -> String {
        let digest = Sha256::digest(contents.as_bytes());
        format!("sha256-{}", BASE64_STANDARD.encode(digest))
    }

    fn spawn_remote_module_server(
        routes: HashMap<String, (String, String)>,
    ) -> (String, std_mpsc::Sender<()>, JoinHandle<()>) {
        let listener =
            TcpListener::bind("127.0.0.1:0").expect("test remote module server should bind");
        listener
            .set_nonblocking(true)
            .expect("test listener should become nonblocking");
        let addr = listener
            .local_addr()
            .expect("test listener should have a local addr");
        let (shutdown_tx, shutdown_rx) = std_mpsc::channel::<()>();

        let handle = std::thread::spawn(move || loop {
            if shutdown_rx.try_recv().is_ok() {
                break;
            }

            match listener.accept() {
                Ok((mut stream, _)) => {
                    stream
                        .set_nonblocking(false)
                        .expect("accepted test stream should be blocking");
                    let mut buffer = [0_u8; 4096];
                    let read = stream
                        .read(&mut buffer)
                        .expect("test server should read request");
                    let request = String::from_utf8_lossy(&buffer[..read]);
                    let path = request
                        .lines()
                        .next()
                        .and_then(|line| line.split_whitespace().nth(1))
                        .unwrap_or("/");
                    let (status, content_type, body) = match routes.get(path) {
                        Some((content_type, body)) => {
                            ("200 OK", content_type.as_str(), body.as_str())
                        }
                        None => ("404 Not Found", "text/plain; charset=utf-8", "not found"),
                    };
                    let response = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    stream
                        .write_all(response.as_bytes())
                        .expect("test server should write response");
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("test server accept failed: {error}"),
            }
        });

        (format!("http://{addr}"), shutdown_tx, handle)
    }

    fn create_remote_lock_worker(
        name: &str,
        remote_url: &str,
        lock_contents: Option<&str>,
        frozen: bool,
    ) -> PathBuf {
        let worker_dir = unique_temp_dir(name);
        let deno_json = if frozen {
            r#"{
  "lock": {
    "path": "./deno.lock",
    "frozen": true
  }
}"#
        } else {
            r#"{
  "lock": {
    "path": "./deno.lock",
    "frozen": false
  }
}"#
        };
        write_file(&worker_dir.join("deno.json"), deno_json);
        if let Some(lock_contents) = lock_contents {
            write_file(&worker_dir.join("deno.lock"), lock_contents);
        }
        write_file(
            &worker_dir.join("mod.ts"),
            &format!(
                r#"import {{ remoteValue }} from "{remote_url}";

export function fetch(_request: Request, env: {{ worker_id: string }}) {{
  return new Response(`remote=${{remoteValue}} worker=${{env.worker_id}}`);
}}
"#
            ),
        );
        worker_dir.join("mod.ts")
    }

    #[test]
    fn rewrites_package_specifiers_for_experiment_loader() {
        assert_eq!(
            rewrite_package_specifier("jsr:@std/assert"),
            Some("https://jsr.io/@std/assert".to_string())
        );
        assert_eq!(
            rewrite_package_specifier("npm:is-odd@3"),
            Some("https://esm.sh/is-odd@3".to_string())
        );
        assert_eq!(rewrite_package_specifier("./local.ts"), None);
    }

    #[test]
    fn resolves_lockfile_configuration_from_deno_json() {
        let project_dir = unique_temp_dir("lock-config");
        write_file(
            &project_dir.join("deno.json"),
            r#"{
  "lock": {
    "path": "./locks/runtime.lock",
    "frozen": true
  }
}"#,
        );
        write_file(
            &project_dir.join("mod.ts"),
            "export function fetch() { return new Response('ok'); }\n",
        );
        write_file(
            &project_dir.join("locks/runtime.lock"),
            r#"{
  "version": "5",
  "remote": {}
}"#,
        );

        let project = WorkerProjectConfig::discover(&project_dir.join("mod.ts"))
            .expect("project config with lockfile should load");
        let lockfile = project
            .lockfile
            .as_ref()
            .expect("lockfile should be discovered");
        assert!(lockfile.frozen);
        assert!(lockfile.path.ends_with("locks/runtime.lock"));
        assert!(project.cache_dir.ends_with(".hardess-cache/remote_modules"));
        let snapshot = project.snapshot().expect("project snapshot should build");
        assert_eq!(snapshot.module_cache.entry_count, 0);
        assert_eq!(snapshot.module_cache.total_bytes, 0);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn runs_a_local_typescript_worker() {
        let mut runtime = DenoWorkerRuntime::new(&sample_worker_path())
            .await
            .expect("worker runtime should bootstrap");
        let response = runtime
            .fetch(
                WorkerRequest {
                    method: "POST".to_string(),
                    url: "http://localhost/hello".to_string(),
                    headers: [("x-test".to_string(), "1".to_string())]
                        .into_iter()
                        .collect(),
                    body: Some("ping".to_string()),
                },
                WorkerEnv {
                    worker_id: "hello-worker".to_string(),
                    vars: Default::default(),
                },
                WorkerContext::default(),
            )
            .await
            .expect("worker fetch should succeed");

        assert_eq!(response.status, 201);
        assert_eq!(
            response.headers.get("x-worker-id"),
            Some(&"hello-worker".to_string())
        );
        assert_eq!(
            response.headers.get("x-request-type"),
            Some(&"request".to_string())
        );
        assert_eq!(
            response.headers.get("x-request-header"),
            Some(&"1".to_string())
        );
        assert_eq!(
            response.body.as_deref(),
            Some("worker=hello-worker method=POST url=http://localhost/hello body=ping")
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn reads_streaming_request_body_across_multiple_chunks() {
        let worker_path = temp_worker_path(
            "streaming-body-text",
            r#"
export async function fetch(request: Request) {
  return new Response(await request.text());
}
"#,
        );
        let mut runtime = DenoWorkerRuntime::new(&worker_path)
            .await
            .expect("streaming worker runtime should bootstrap");
        let (request, ingress_body) = GatewayRequest::streaming(WorkerRequest {
            method: "POST".to_string(),
            url: "http://localhost/stream".to_string(),
            headers: [("content-length".to_string(), "10".to_string())]
                .into_iter()
                .collect(),
            body: None,
        });
        let ingress_driver = tokio::spawn(drive_ingress_chunks(
            ingress_body,
            vec![b"abc".to_vec(), b"defg".to_vec(), b"hij".to_vec()],
        ));

        let response = runtime
            .fetch_gateway(
                request,
                WorkerEnv {
                    worker_id: "streaming-worker".to_string(),
                    vars: Default::default(),
                },
                WorkerContext::default(),
            )
            .await
            .expect("streaming worker fetch should succeed");
        ingress_driver
            .await
            .expect("ingress body driver should complete");

        assert_eq!(response.status, 200);
        assert_eq!(response.body.as_deref(), Some("abcdefghij"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn blocking_completion_does_not_deadlock_streaming_request_body() {
        let worker_path = temp_worker_path(
            "blocking-completion-streaming-body",
            r#"
export async function fetch(request: Request) {
  return new Response(await request.text());
}
"#,
        );
        let pool = WorkerRuntimePool::new(
            worker_path,
            1,
            4,
            Duration::from_secs(5),
            RuntimeCompletionMode::Blocking,
        )
        .expect("runtime pool should initialize");
        let (request, mut ingress_body) = GatewayRequest::streaming(WorkerRequest {
            method: "POST".to_string(),
            url: "http://localhost/stream".to_string(),
            headers: [("content-length".to_string(), "4".to_string())]
                .into_iter()
                .collect(),
            body: None,
        });

        let response = tokio::time::timeout(Duration::from_secs(1), async {
            let worker_future = pool.execute_gateway(
                request,
                WorkerEnv {
                    worker_id: "streaming-worker".to_string(),
                    vars: Default::default(),
                },
                WorkerContext::default(),
            );
            tokio::pin!(worker_future);

            loop {
                tokio::select! {
                    result = &mut worker_future => break result,
                    command = ingress_body.command_rx.recv() => match command {
                        Some(RequestBodyCommand::ReadNext { response_tx }) => {
                            if ingress_body.finished {
                                let _ = response_tx.send(Ok(None));
                            } else {
                                ingress_body.finished = true;
                                let _ = response_tx.send(Ok(Some(b"ping".to_vec())));
                            }
                        }
                        None => panic!("streaming request body bridge should stay open until completion"),
                    }
                }
            }
        })
        .await
        .expect("streaming request body should not deadlock")
        .expect("gateway response should complete successfully");

        let response = response
            .into_worker_response()
            .await
            .expect("gateway response should convert back to worker response");
        assert_eq!(response.status, 200);
        assert_eq!(response.body.as_deref(), Some("ping"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn worker_can_return_without_consuming_streaming_request_body() {
        let worker_path = temp_worker_path(
            "streaming-body-unused",
            r#"
export async function fetch(_request: Request) {
  return new Response("ok");
}
"#,
        );
        let mut runtime = DenoWorkerRuntime::new(&worker_path)
            .await
            .expect("streaming worker runtime should bootstrap");
        let (request, mut ingress_body) = GatewayRequest::streaming(WorkerRequest {
            method: "POST".to_string(),
            url: "http://localhost/unused".to_string(),
            headers: [("content-length".to_string(), "4096".to_string())]
                .into_iter()
                .collect(),
            body: None,
        });

        let response = runtime
            .fetch_gateway(
                request,
                WorkerEnv {
                    worker_id: "unused-body-worker".to_string(),
                    vars: Default::default(),
                },
                WorkerContext::default(),
            )
            .await
            .expect("worker should succeed without consuming body");

        assert_eq!(response.status, 200);
        assert_eq!(response.body.as_deref(), Some("ok"));
        assert!(matches!(
            ingress_body.command_rx.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn runtime_pool_execute_gateway_streams_response_body() {
        let worker_path = temp_worker_path(
            "streaming-response-body",
            r#"
export async function fetch() {
  async function* body() {
    yield "alpha-";
    yield "beta-";
    yield "gamma";
  }

  return new Response(body(), {
    status: 202,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-streaming": "yes",
    },
  });
}
"#,
        );
        let pool = WorkerRuntimePool::new(
            worker_path,
            1,
            4,
            Duration::from_secs(5),
            RuntimeCompletionMode::Auto,
        )
        .expect("runtime pool should initialize");

        let mut response = pool
            .execute_gateway(
                GatewayRequest::buffered(WorkerRequest {
                    method: "GET".to_string(),
                    url: "http://localhost/streaming-response".to_string(),
                    headers: Default::default(),
                    body: None,
                }),
                WorkerEnv {
                    worker_id: "streaming-response-worker".to_string(),
                    vars: Default::default(),
                },
                WorkerContext::default(),
            )
            .await
            .expect("gateway response should stream successfully");

        assert_eq!(response.status(), 202);
        assert_eq!(
            response.headers().get("x-streaming"),
            Some(&"yes".to_string())
        );

        let mut body = match response.take_body() {
            GatewayResponseBody::Streaming(body) => body,
            other => panic!("expected streaming body, got {:?}", other),
        };

        assert_eq!(
            body.read_next_chunk().await.unwrap(),
            Some(b"alpha-".to_vec())
        );
        assert_eq!(
            body.read_next_chunk().await.unwrap(),
            Some(b"beta-".to_vec())
        );
        assert_eq!(
            body.read_next_chunk().await.unwrap(),
            Some(b"gamma".to_vec())
        );
        assert_eq!(body.read_next_chunk().await.unwrap(), None);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn runtime_pool_injects_runtime_shard_metadata_into_ctx() {
        let worker_path = temp_worker_path(
            "ctx-metadata",
            r#"
export async function fetch(_request: Request, _env: unknown, ctx: { metadata: Record<string, string> }) {
  return new Response(JSON.stringify(ctx.metadata), {
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}
"#,
        );
        let pool = WorkerRuntimePool::new(
            worker_path,
            1,
            4,
            Duration::from_secs(5),
            RuntimeCompletionMode::Auto,
        )
        .expect("runtime pool should initialize");

        let response = pool
            .execute(
                WorkerRequest {
                    method: "GET".to_string(),
                    url: "http://localhost/ctx".to_string(),
                    headers: Default::default(),
                    body: None,
                },
                WorkerEnv {
                    worker_id: "ctx-worker".to_string(),
                    vars: Default::default(),
                },
                WorkerContext {
                    metadata: [
                        (
                            HARDESS_REQUEST_TASK_ID_METADATA_KEY.to_string(),
                            "42".to_string(),
                        ),
                        ("custom".to_string(), "value".to_string()),
                    ]
                    .into_iter()
                    .collect(),
                },
            )
            .await
            .expect("runtime pool should execute");

        let metadata: serde_json::Value = serde_json::from_str(
            response
                .body
                .as_deref()
                .expect("worker should return metadata body"),
        )
        .expect("metadata body should be valid JSON");
        assert_eq!(
            metadata
                .get(HARDESS_REQUEST_TASK_ID_METADATA_KEY)
                .and_then(serde_json::Value::as_str),
            Some("42")
        );
        assert_eq!(
            metadata
                .get(HARDESS_RUNTIME_SHARD_METADATA_KEY)
                .and_then(serde_json::Value::as_str),
            Some("0")
        );
        assert_eq!(
            metadata.get("custom").and_then(serde_json::Value::as_str),
            Some("value")
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn resolves_deno_json_imports_for_worker_project() {
        let project = WorkerProjectConfig::discover(&import_map_worker_path())
            .expect("worker project config should load deno.json");
        assert!(project.root_dir.ends_with("workers/import_map"));
        let expected_import = resolve_path(
            project
                .root_dir
                .join("src/message.ts")
                .to_str()
                .expect("import path should be valid UTF-8"),
            &std::env::current_dir().expect("cwd should exist"),
        )
        .expect("resolved specifier should be valid")
        .to_string();
        assert_eq!(
            project
                .resolve_import_map_specifier("@lib/message.ts")
                .expect("prefix import should resolve"),
            Some(expected_import)
        );

        let mut runtime = DenoWorkerRuntime::new(&import_map_worker_path())
            .await
            .expect("import-map worker runtime should bootstrap");
        let response = runtime
            .fetch(
                WorkerRequest {
                    method: "GET".to_string(),
                    url: "http://localhost/imports".to_string(),
                    headers: Default::default(),
                    body: None,
                },
                WorkerEnv {
                    worker_id: "import-map-worker".to_string(),
                    vars: Default::default(),
                },
                WorkerContext::default(),
            )
            .await
            .expect("import-map worker fetch should succeed");

        assert_eq!(response.status, 200);
        assert_eq!(
            response.body.as_deref(),
            Some("message=hello-from-import-map worker=import-map-worker")
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn frozen_lockfile_allows_known_remote_module() {
        let remote_module_body = "export const remoteValue = 'from-remote';\n";
        let (base_url, shutdown_tx, server_thread) = spawn_remote_module_server(
            [(
                "/dep.ts".to_string(),
                (
                    "application/typescript".to_string(),
                    remote_module_body.to_string(),
                ),
            )]
            .into_iter()
            .collect(),
        );
        let remote_url = format!("{base_url}/dep.ts");
        let worker_path = create_remote_lock_worker(
            "frozen-lock-ok",
            &remote_url,
            Some(&format!(
                r#"{{
  "version": "5",
  "remote": {{
    "{remote_url}": "{}"
  }}
}}"#,
                sha256_integrity(remote_module_body)
            )),
            true,
        );

        let mut runtime = DenoWorkerRuntime::new(&worker_path)
            .await
            .expect("runtime should honor frozen lockfile for known remote");
        let response = runtime
            .fetch(
                WorkerRequest {
                    method: "GET".to_string(),
                    url: "http://localhost/frozen".to_string(),
                    headers: Default::default(),
                    body: None,
                },
                WorkerEnv {
                    worker_id: "frozen-ok".to_string(),
                    vars: Default::default(),
                },
                WorkerContext::default(),
            )
            .await
            .expect("worker fetch should succeed");
        let _ = shutdown_tx.send(());
        server_thread
            .join()
            .expect("test remote module server should join");

        assert_eq!(response.status, 200);
        assert_eq!(
            response.body.as_deref(),
            Some("remote=from-remote worker=frozen-ok")
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn remote_module_cache_reuses_cached_bytes_after_server_shutdown() {
        let remote_module_body = "export const remoteValue = 'from-cache';\n";
        let (base_url, shutdown_tx, server_thread) = spawn_remote_module_server(
            [(
                "/dep.ts".to_string(),
                (
                    "application/typescript".to_string(),
                    remote_module_body.to_string(),
                ),
            )]
            .into_iter()
            .collect(),
        );
        let remote_url = format!("{base_url}/dep.ts");
        let worker_path = create_remote_lock_worker(
            "remote-cache-hit",
            &remote_url,
            Some(&format!(
                r#"{{
  "version": "5",
  "remote": {{
    "{remote_url}": "{}"
  }}
}}"#,
                sha256_integrity(remote_module_body)
            )),
            true,
        );

        let project = WorkerProjectConfig::discover(&worker_path)
            .expect("worker project config should be discovered");
        let (_, cache_meta_path) = project.remote_cache_paths(
            &ModuleSpecifier::parse(&remote_url).expect("remote url should parse"),
        );
        assert!(!cache_meta_path.is_file());

        let mut first_runtime = DenoWorkerRuntime::new(&worker_path)
            .await
            .expect("first runtime should fetch and cache remote module");
        let first_response = first_runtime
            .fetch(
                WorkerRequest {
                    method: "GET".to_string(),
                    url: "http://localhost/cache-first".to_string(),
                    headers: Default::default(),
                    body: None,
                },
                WorkerEnv {
                    worker_id: "cache-first".to_string(),
                    vars: Default::default(),
                },
                WorkerContext::default(),
            )
            .await
            .expect("first worker fetch should succeed");
        assert_eq!(
            first_response.body.as_deref(),
            Some("remote=from-cache worker=cache-first")
        );
        assert!(cache_meta_path.is_file());

        let _ = shutdown_tx.send(());
        server_thread
            .join()
            .expect("test remote module server should join");

        let mut second_runtime = DenoWorkerRuntime::new(&worker_path)
            .await
            .expect("second runtime should reuse cached remote module");
        let second_response = second_runtime
            .fetch(
                WorkerRequest {
                    method: "GET".to_string(),
                    url: "http://localhost/cache-second".to_string(),
                    headers: Default::default(),
                    body: None,
                },
                WorkerEnv {
                    worker_id: "cache-second".to_string(),
                    vars: Default::default(),
                },
                WorkerContext::default(),
            )
            .await
            .expect("second worker fetch should succeed from cache");
        assert_eq!(
            second_response.body.as_deref(),
            Some("remote=from-cache worker=cache-second")
        );
        let snapshot = inspect_worker_project(&worker_path)
            .expect("worker project snapshot should inspect cache");
        assert!(snapshot.artifact_id.starts_with("local-sha256:"));
        assert_eq!(snapshot.module_cache.entry_count, 1);
        assert!(snapshot.module_cache.total_bytes > 0);
    }

    #[test]
    fn inspect_worker_project_prunes_stale_remote_cache_entries() {
        let remote_url = "https://example.com/active.ts";
        let stale_remote_url = "https://example.com/stale.ts";
        let worker_path = create_remote_lock_worker(
            "cache-prune",
            remote_url,
            Some(&format!(
                r#"{{
  "version": "5",
  "remote": {{
    "{remote_url}": "{}"
  }}
}}"#,
                sha256_integrity("export const remoteValue = 'active';\n")
            )),
            true,
        );
        let project = WorkerProjectConfig::discover(&worker_path)
            .expect("worker project config should be discovered");

        let stale_specifier =
            ModuleSpecifier::parse(stale_remote_url).expect("stale remote url should parse");
        let (stale_body_path, stale_meta_path) = project.remote_cache_paths(&stale_specifier);
        write_file(&stale_body_path, "export const remoteValue = 'stale';\n");
        write_file(
            &stale_meta_path,
            &serde_json::to_string_pretty(&CachedRemoteModuleMetadata {
                url: stale_remote_url.to_string(),
                content_type: Some("application/typescript".to_string()),
            })
            .expect("stale metadata should serialize"),
        );

        let snapshot = project
            .snapshot()
            .expect("project snapshot should prune cache");
        assert_eq!(snapshot.module_cache.entry_count, 0);
        assert!(!stale_body_path.exists());
        assert!(!stale_meta_path.exists());
    }

    #[test]
    fn inspect_worker_project_artifact_id_changes_when_worker_source_changes() {
        let worker_dir = unique_temp_dir("artifact-id");
        let worker_path = worker_dir.join("mod.ts");
        write_file(
            &worker_path,
            "export function fetch() { return new Response('v1'); }\n",
        );

        let first_snapshot =
            inspect_worker_project(&worker_path).expect("first worker snapshot should succeed");
        assert!(first_snapshot.artifact_id.starts_with("local-sha256:"));

        write_file(
            &worker_path,
            "export function fetch() { return new Response('v2'); }\n",
        );

        let second_snapshot =
            inspect_worker_project(&worker_path).expect("second worker snapshot should succeed");
        assert!(second_snapshot.artifact_id.starts_with("local-sha256:"));
        assert_ne!(first_snapshot.artifact_id, second_snapshot.artifact_id);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn frozen_lockfile_rejects_unknown_remote_module() {
        let remote_module_body = "export const remoteValue = 'from-remote';\n";
        let (base_url, shutdown_tx, server_thread) = spawn_remote_module_server(
            [(
                "/dep.ts".to_string(),
                (
                    "application/typescript".to_string(),
                    remote_module_body.to_string(),
                ),
            )]
            .into_iter()
            .collect(),
        );
        let remote_url = format!("{base_url}/dep.ts");
        let worker_path = create_remote_lock_worker(
            "frozen-lock-miss",
            &remote_url,
            Some(
                r#"{
  "version": "5",
  "remote": {}
}"#,
            ),
            true,
        );

        let error = match DenoWorkerRuntime::new(&worker_path).await {
            Ok(_) => panic!("runtime should reject remote module missing from frozen lockfile"),
            Err(error) => error,
        };
        let _ = shutdown_tx.send(());
        server_thread
            .join()
            .expect("test remote module server should join");

        assert!(error
            .to_string()
            .contains("Module not found in frozen lockfile"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn frozen_lockfile_rejects_remote_integrity_mismatch() {
        let remote_module_body = "export const remoteValue = 'from-remote';\n";
        let (base_url, shutdown_tx, server_thread) = spawn_remote_module_server(
            [(
                "/dep.ts".to_string(),
                (
                    "application/typescript".to_string(),
                    remote_module_body.to_string(),
                ),
            )]
            .into_iter()
            .collect(),
        );
        let remote_url = format!("{base_url}/dep.ts");
        let worker_path = create_remote_lock_worker(
            "frozen-lock-mismatch",
            &remote_url,
            Some(&format!(
                r#"{{
  "version": "5",
  "remote": {{
    "{remote_url}": "{}"
  }}
}}"#,
                sha256_integrity("export const remoteValue = 'tampered';\n")
            )),
            true,
        );

        let error = match DenoWorkerRuntime::new(&worker_path).await {
            Ok(_) => panic!("runtime should reject remote integrity mismatch"),
            Err(error) => error,
        };
        let _ = shutdown_tx.send(());
        server_thread
            .join()
            .expect("test remote module server should join");

        assert!(error.to_string().contains("Integrity check failed"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn runtime_pool_reuses_initialized_workers() {
        let pool = WorkerRuntimePool::new(
            sample_worker_path(),
            2,
            8,
            Duration::from_secs(5),
            RuntimeCompletionMode::Auto,
        )
        .expect("runtime pool should initialize");
        assert_eq!(pool.size(), 2);

        let response = pool
            .execute(
                WorkerRequest {
                    method: "POST".to_string(),
                    url: "http://localhost/from-pool".to_string(),
                    headers: [("x-test".to_string(), "9".to_string())]
                        .into_iter()
                        .collect(),
                    body: Some("pool-body".to_string()),
                },
                WorkerEnv {
                    worker_id: "pooled-worker".to_string(),
                    vars: Default::default(),
                },
                WorkerContext::default(),
            )
            .await
            .expect("pooled worker fetch should succeed");

        assert_eq!(response.status, 201);
        assert_eq!(
            response.headers.get("x-request-header"),
            Some(&"9".to_string())
        );
        assert_eq!(
            response.body.as_deref(),
            Some("worker=pooled-worker method=POST url=http://localhost/from-pool body=pool-body")
        );

        let snapshot = pool.metrics_snapshot();
        assert_eq!(snapshot.runtime_threads, 2);
        assert_eq!(snapshot.queue_capacity_per_thread, 8);
        assert_eq!(snapshot.exec_timeout_ms, 5_000);
        assert_eq!(snapshot.submitted, 1);
        assert_eq!(snapshot.completed, 1);
        assert_eq!(snapshot.failed, 0);
        assert_eq!(snapshot.overloaded, 0);
        assert_eq!(snapshot.timed_out, 0);
        assert_eq!(snapshot.rebuilt, 0);
        assert!(snapshot.average_exec_ms >= 0.0);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn runtime_pool_rejects_when_all_queues_are_full() {
        let pool = WorkerRuntimePool::new(
            blocking_worker_path(),
            1,
            1,
            Duration::from_secs(5),
            RuntimeCompletionMode::Auto,
        )
        .expect("runtime pool should initialize");
        let request_count = 6;
        let barrier = Arc::new(Barrier::new(request_count + 1));
        let mut tasks = Vec::with_capacity(request_count);

        for request_index in 0..request_count {
            let pool = pool.clone();
            let barrier = barrier.clone();
            tasks.push(tokio::spawn(async move {
                barrier.wait().await;
                pool.execute(
                    WorkerRequest {
                        method: "POST".to_string(),
                        url: format!("http://localhost/{request_index}"),
                        headers: Default::default(),
                        body: Some(format!("body-{request_index}")),
                    },
                    WorkerEnv {
                        worker_id: "blocking-worker".to_string(),
                        vars: Default::default(),
                    },
                    WorkerContext::default(),
                )
                .await
            }));
        }

        barrier.wait().await;

        let mut overloaded = 0;
        let mut succeeded = 0;
        for task in tasks {
            match task.await.expect("task should join") {
                Ok(response) => {
                    succeeded += 1;
                    assert_eq!(response.status, 200);
                }
                Err(error) => {
                    if error.is_overloaded() {
                        overloaded += 1;
                    } else {
                        panic!("unexpected runtime pool error: {:?}", error);
                    }
                }
            }
        }

        assert!(succeeded >= 1, "at least one request should run");
        assert!(
            overloaded >= 1,
            "at least one request should be rejected when queues are full"
        );

        let snapshot = pool.metrics_snapshot();
        assert_eq!(snapshot.runtime_threads, 1);
        assert_eq!(snapshot.queue_capacity_per_thread, 1);
        assert!(snapshot.submitted >= request_count as u64);
        assert!(snapshot.completed >= succeeded as u64);
        assert!(snapshot.overloaded >= overloaded as u64);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn runtime_pool_times_out_and_rebuilds_slot() {
        let pool = WorkerRuntimePool::new(
            flaky_worker_path(),
            1,
            4,
            Duration::from_millis(100),
            RuntimeCompletionMode::Auto,
        )
        .expect("runtime pool should initialize");

        let timed_out = pool
            .execute(
                WorkerRequest {
                    method: "GET".to_string(),
                    url: "http://localhost/demo?mode=hang".to_string(),
                    headers: Default::default(),
                    body: None,
                },
                WorkerEnv {
                    worker_id: "flaky-worker".to_string(),
                    vars: Default::default(),
                },
                WorkerContext::default(),
            )
            .await
            .expect_err("hanging request should time out");
        assert_eq!(timed_out, RuntimePoolError::TimedOut(100));

        let response = pool
            .execute(
                WorkerRequest {
                    method: "GET".to_string(),
                    url: "http://localhost/demo?mode=ok".to_string(),
                    headers: Default::default(),
                    body: None,
                },
                WorkerEnv {
                    worker_id: "flaky-worker".to_string(),
                    vars: Default::default(),
                },
                WorkerContext::default(),
            )
            .await
            .expect("healthy request should succeed after rebuild");
        assert_eq!(response.status, 200);
        assert_eq!(
            response.body.as_deref(),
            Some("mode=ok worker=flaky-worker")
        );

        let snapshot = pool.metrics_snapshot();
        assert_eq!(snapshot.runtime_threads, 1);
        assert_eq!(snapshot.queue_capacity_per_thread, 4);
        assert_eq!(snapshot.exec_timeout_ms, 100);
        assert_eq!(snapshot.timed_out, 1);
        assert_eq!(snapshot.recycled, 0);
        assert_eq!(snapshot.rebuilt, 1);
        assert_eq!(snapshot.completed, 1);
        assert_eq!(snapshot.failed, 1);
        assert_eq!(snapshot.per_thread[0].timed_out, 1);
        assert_eq!(snapshot.per_thread[0].recycled, 0);
        assert_eq!(snapshot.per_thread[0].rebuilds, 1);
        assert_eq!(snapshot.per_thread[0].unhealthy_exits, 1);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn queued_requests_retry_cleanly_after_slot_recycles() {
        let pool = WorkerRuntimePool::new(
            flaky_worker_path(),
            1,
            4,
            Duration::from_millis(100),
            RuntimeCompletionMode::Auto,
        )
        .expect("runtime pool should initialize");

        let timed_out_task = tokio::spawn({
            let pool = pool.clone();
            async move {
                pool.execute(
                    WorkerRequest {
                        method: "GET".to_string(),
                        url: "http://localhost/demo?mode=hang".to_string(),
                        headers: Default::default(),
                        body: None,
                    },
                    WorkerEnv {
                        worker_id: "flaky-worker".to_string(),
                        vars: Default::default(),
                    },
                    WorkerContext::default(),
                )
                .await
            }
        });

        tokio::time::sleep(Duration::from_millis(10)).await;

        let recycled_then_retried = pool
            .execute(
                WorkerRequest {
                    method: "GET".to_string(),
                    url: "http://localhost/demo?mode=ok".to_string(),
                    headers: Default::default(),
                    body: None,
                },
                WorkerEnv {
                    worker_id: "flaky-worker".to_string(),
                    vars: Default::default(),
                },
                WorkerContext::default(),
            )
            .await
            .expect("queued request should be retried after the slot rebuilds");
        assert_eq!(recycled_then_retried.status, 200);
        assert_eq!(
            recycled_then_retried.body.as_deref(),
            Some("mode=ok worker=flaky-worker")
        );

        let timed_out_error = timed_out_task
            .await
            .expect("timeout task should join")
            .expect_err("hanging request should time out");
        assert_eq!(timed_out_error, RuntimePoolError::TimedOut(100));

        let snapshot = pool.metrics_snapshot();
        assert_eq!(snapshot.timed_out, 1);
        assert_eq!(snapshot.recycled, 1);
        assert_eq!(snapshot.rebuilt, 1);
        assert_eq!(snapshot.completed, 1);
        assert_eq!(snapshot.failed, 2);
        assert_eq!(snapshot.per_thread[0].timed_out, 1);
        assert_eq!(snapshot.per_thread[0].recycled, 1);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn drain_controller_rejects_new_requests_after_draining_starts() {
        let drain = RequestDrainController::new();
        let guard = drain
            .try_acquire()
            .expect("request should be accepted before draining");

        assert!(drain.start_draining());
        assert!(drain.is_draining());
        assert!(drain.try_acquire().is_none());

        drop(guard);

        assert!(drain.wait_for_drain(Duration::from_millis(50)).await);
        assert_eq!(
            drain.snapshot(),
            DrainSnapshot {
                draining: true,
                inflight_requests: 0,
            }
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn drain_controller_times_out_when_inflight_does_not_finish() {
        let drain = RequestDrainController::new();
        let _guard = drain
            .try_acquire()
            .expect("request should be accepted before draining");

        assert!(drain.start_draining());
        assert!(!drain.wait_for_drain(Duration::from_millis(10)).await);
        assert_eq!(drain.inflight_requests(), 1);
    }
}
