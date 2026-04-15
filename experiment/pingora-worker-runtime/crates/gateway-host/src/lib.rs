mod compat_v1;

use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::HashMap;
use std::io::Read;
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
use deno_core::error::ModuleLoaderError;
use deno_core::resolve_import;
use deno_core::resolve_path;
use deno_core::serde_v8;
use deno_core::v8;
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
use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;
use sha2::Sha512;
use tokio::sync::mpsc as tokio_mpsc;
use tokio::sync::oneshot;
use tokio::sync::Notify;
use worker_abi::WorkerContext;
use worker_abi::WorkerEnv;
use worker_abi::WorkerRequest;
use worker_abi::WorkerResponse;
use worker_abi::WorkerRuntime;

pub use compat_v1::bad_request_public_error;
pub use compat_v1::build_compat_context;
pub use compat_v1::build_compat_env;
pub use compat_v1::build_host_execution_envelope;
pub use compat_v1::build_host_execution_envelope_from_context;
pub use compat_v1::internal_public_error;
pub use compat_v1::parse_v1_request;
pub use compat_v1::parse_v1_response;
pub use compat_v1::parsed_v1_response_to_worker_response;
pub use compat_v1::public_error_response;
pub use compat_v1::shutdown_draining_public_error;
pub use compat_v1::CompatContext;
pub use compat_v1::CompatEnv;
pub use compat_v1::CompatInvocationRecord;
pub use compat_v1::CompatMetadata;
pub use compat_v1::CompatPublicError;
pub use compat_v1::CompatPublicErrorCategory;
pub use compat_v1::HostExecutionEnvelope;
pub use compat_v1::ParsedV1Request;
pub use compat_v1::ParsedV1Response;

type SourceMapStore = Rc<RefCell<HashMap<String, Vec<u8>>>>;
const REMOTE_CACHE_MAX_ENTRIES: usize = 128;
const REMOTE_CACHE_MAX_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone)]
struct WorkerProjectConfig {
    #[allow(dead_code)]
    root_dir: PathBuf,
    config_path: Option<PathBuf>,
    cache_dir: PathBuf,
    config_specifier: ModuleSpecifier,
    imports: HashMap<String, String>,
    lockfile: Option<LoadedDenoLockfile>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct WorkerProjectSnapshot {
    pub root_dir: String,
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
        let start_dir = canonical_entry.parent().with_context(|| {
            format!(
                "worker entry {} must have a parent directory",
                canonical_entry.display()
            )
        })?;

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
                config_path: Some(deno_json_path),
                cache_dir,
                config_specifier,
                imports: parsed.imports,
                lockfile,
            });
        }

        let root_dir = start_dir.to_path_buf();
        let config_specifier = resolve_path(
            root_dir
                .join("__hardess_virtual_deno_json__")
                .to_str()
                .context("virtual deno.json path must be valid UTF-8")?,
            &std::env::current_dir().context("unable to get current directory")?,
        )?;

        Ok(Self {
            root_dir,
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

        Ok(WorkerProjectSnapshot {
            root_dir: self.root_dir.display().to_string(),
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

const WEB_RUNTIME_BOOTSTRAP: &str = r#"
class Headers {
  constructor(init = undefined) {
    this._map = new Map();

    if (init instanceof Headers) {
      for (const [key, value] of init.entries()) {
        this.append(key, value);
      }
      return;
    }

    if (Array.isArray(init)) {
      for (const entry of init) {
        if (!Array.isArray(entry) || entry.length !== 2) {
          throw new TypeError("Headers init entries must be [name, value]");
        }
        this.append(entry[0], entry[1]);
      }
      return;
    }

    if (init && typeof init === "object") {
      for (const [key, value] of Object.entries(init)) {
        this.append(key, value);
      }
    }
  }

  _normalizeName(name) {
    return String(name).toLowerCase();
  }

  _normalizeValue(value) {
    return String(value);
  }

  append(name, value) {
    const normalizedName = this._normalizeName(name);
    const normalizedValue = this._normalizeValue(value);
    const previous = this._map.get(normalizedName);
    this._map.set(
      normalizedName,
      previous ? `${previous}, ${normalizedValue}` : normalizedValue,
    );
  }

  delete(name) {
    this._map.delete(this._normalizeName(name));
  }

  get(name) {
    const value = this._map.get(this._normalizeName(name));
    return value === undefined ? null : value;
  }

  has(name) {
    return this._map.has(this._normalizeName(name));
  }

  set(name, value) {
    this._map.set(this._normalizeName(name), this._normalizeValue(value));
  }

  entries() {
    return this._map.entries();
  }

  keys() {
    return this._map.keys();
  }

  values() {
    return this._map.values();
  }

  forEach(callback, thisArg = undefined) {
    for (const [key, value] of this._map.entries()) {
      callback.call(thisArg, value, key, this);
    }
  }

  [Symbol.iterator]() {
    return this.entries();
  }
}

class Request {
  constructor(input, init = undefined) {
    if (input instanceof Request) {
      this.method = init?.method ?? input.method;
      this.url = init?.url ?? input.url;
      this.headers = new Headers(init?.headers ?? input.headers);
      this._bodyText = init?.body ?? input._bodyText;
    } else {
      this.method = init?.method ?? "GET";
      this.url = String(input);
      this.headers = new Headers(init?.headers);
      this._bodyText = init?.body ?? null;
    }

    this.method = String(this.method).toUpperCase();
    this.bodyUsed = false;
  }

  async text() {
    this.bodyUsed = true;
    return this._bodyText ?? "";
  }

  async json() {
    return JSON.parse(await this.text());
  }

  clone() {
    return new Request(this);
  }
}

class Response {
  constructor(body = null, init = undefined) {
    this.status = Math.trunc(init?.status ?? 200);
    this.statusText = String(init?.statusText ?? "");
    this.headers = new Headers(init?.headers);
    this._bodyText = body == null ? null : String(body);
    this.bodyUsed = false;
  }

  async text() {
    this.bodyUsed = true;
    return this._bodyText ?? "";
  }

  async json() {
    return JSON.parse(await this.text());
  }

  clone() {
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

fn build_public_error_runtime_bootstrap_script() -> Result<String> {
    let contract_json = serde_json::to_string(compat_v1::public_error_contract_json())?;

    Ok(format!(
        r#"(function () {{
  const contract = JSON.parse({contract_json});
  const byCode = Object.freeze(Object.fromEntries(
    contract.errors
      .filter((spec) => spec.public === true)
      .map((spec) => [
        spec.code,
        Object.freeze({{
          code: spec.code,
          category: spec.category,
          status: spec.status,
          retryable: spec.retryable,
        }}),
      ]),
  ));

  globalThis.HardessPublicErrors = Object.freeze({{
    version: contract.version,
    list: Object.freeze(Object.values(byCode)),
    codes() {{
      return Object.keys(byCode);
    }},
    has(code) {{
      return Object.prototype.hasOwnProperty.call(byCode, String(code));
    }},
    get(code) {{
      return byCode[String(code)] ?? null;
    }},
  }});
}})()"#
    ))
}

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
    invocation_mode: WorkerInvocationMode,
    invoke_bridge: v8::Global<v8::Function>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WorkerInvocationMode {
    WebFetch,
    CompatV1,
}

struct RuntimeThreadMessage {
    request: WorkerRequest,
    env: WorkerEnv,
    ctx: WorkerContext,
    response_tx: oneshot::Sender<Result<WorkerResponse, RuntimePoolError>>,
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
    state: Mutex<RuntimeSlotState>,
    metrics: Arc<WorkerThreadMetrics>,
    pool_metrics: Arc<RuntimePoolMetrics>,
}

impl WorkerRuntimeSlot {
    fn new(
        worker_entry: PathBuf,
        runtime_index: usize,
        queue_capacity: usize,
        exec_timeout: Duration,
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
                        let _ = watchdog_tx.send(WatchdogCommand::Arm { request_id });
                        let started_at = Instant::now();
                        let worker_result = worker_runtime
                            .fetch(message.request, message.env, message.ctx)
                            .await;
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
                            .total_exec_nanos
                            .fetch_add(elapsed, Ordering::Relaxed);
                        pool_metrics_for_thread
                            .exec_count
                            .fetch_add(1, Ordering::Relaxed);
                        let result = if timed_out {
                            Err(RuntimePoolError::TimedOut(exec_timeout.as_millis() as u64))
                        } else {
                            worker_result.map_err(RuntimePoolError::Worker)
                        };
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
                        let _ = message.response_tx.send(result);
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
                        let _ = message
                            .response_tx
                            .send(Err(recycling_error(runtime_index)));
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
        request: WorkerRequest,
        env: WorkerEnv,
        ctx: WorkerContext,
    ) -> Result<WorkerResponse, RuntimePoolError> {
        let (generation, sender) = {
            let state = self
                .state
                .lock()
                .expect("worker runtime slot state mutex should not be poisoned");
            (state.generation, state.instance.sender.clone())
        };
        let (response_tx, response_rx) = oneshot::channel();
        sender
            .try_send(RuntimeThreadMessage {
                request,
                env,
                ctx,
                response_tx,
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
        let result = response_rx.await.map_err(|_| {
            RuntimePoolError::Unavailable(
                "worker runtime thread dropped response channel".to_string(),
            )
        })?;

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

pub struct WorkerRuntimePool {
    handles: Vec<WorkerRuntimeSlot>,
    next: AtomicUsize,
    metrics: Arc<RuntimePoolMetrics>,
    queue_capacity: usize,
    exec_timeout: Duration,
}

impl WorkerRuntimePool {
    pub fn new(
        worker_entry: PathBuf,
        size: usize,
        queue_capacity: usize,
        exec_timeout: Duration,
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
                metrics.clone(),
            )?);
        }

        Ok(Arc::new(Self {
            handles,
            next: AtomicUsize::new(0),
            metrics,
            queue_capacity,
            exec_timeout,
        }))
    }

    pub async fn execute(
        &self,
        request: WorkerRequest,
        env: WorkerEnv,
        ctx: WorkerContext,
    ) -> Result<WorkerResponse, RuntimePoolError> {
        let start_index = self.next.fetch_add(1, Ordering::Relaxed) % self.handles.len();
        self.metrics.submitted.fetch_add(1, Ordering::Relaxed);
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

    pub fn metrics_snapshot(&self) -> RuntimePoolSnapshot {
        let per_thread = self
            .handles
            .iter()
            .map(|handle| handle.metrics.snapshot())
            .collect::<Vec<_>>();
        let total_exec_nanos = self.metrics.total_exec_nanos.load(Ordering::Relaxed);
        let exec_count = self.metrics.exec_count.load(Ordering::Relaxed);
        let average_exec_ms = if exec_count == 0 {
            0.0
        } else {
            (total_exec_nanos as f64 / exec_count as f64) / 1_000_000.0
        };

        RuntimePoolSnapshot {
            runtime_threads: self.size(),
            queue_capacity_per_thread: self.queue_capacity(),
            exec_timeout_ms: self.exec_timeout().as_millis() as u64,
            submitted: self.metrics.submitted.load(Ordering::Relaxed),
            completed: self.metrics.completed.load(Ordering::Relaxed),
            failed: self.metrics.failed.load(Ordering::Relaxed),
            overloaded: self.metrics.overloaded.load(Ordering::Relaxed),
            timed_out: self.metrics.timed_out.load(Ordering::Relaxed),
            recycled: self.metrics.recycled.load(Ordering::Relaxed),
            rebuilt: self.metrics.rebuilt.load(Ordering::Relaxed),
            inflight: self.metrics.inflight.load(Ordering::Relaxed) as usize,
            queued: self.metrics.queued.load(Ordering::Relaxed) as usize,
            average_exec_ms,
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
    total_exec_nanos: AtomicU64,
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
            total_exec_nanos: AtomicU64::new(0),
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
    pub submitted: u64,
    pub completed: u64,
    pub failed: u64,
    pub overloaded: u64,
    pub timed_out: u64,
    pub recycled: u64,
    pub rebuilt: u64,
    pub inflight: usize,
    pub queued: usize,
    pub average_exec_ms: f64,
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
            ..Default::default()
        });
        js_runtime
            .execute_script("<web-runtime-bootstrap>", WEB_RUNTIME_BOOTSTRAP)
            .context("unable to bootstrap minimal web runtime")?;
        js_runtime
            .execute_script(
                "<public-error-contract-bootstrap>",
                build_public_error_runtime_bootstrap_script()
                    .context("unable to build public error contract bootstrap script")?,
            )
            .context("unable to bootstrap public error contract runtime helper")?;

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
        let (invocation_mode, invoke_bridge) =
            Self::initialize_invocation_bridge(&mut js_runtime, &worker_specifier).await?;

        Ok(Self {
            js_runtime,
            invocation_mode,
            invoke_bridge,
        })
    }

    async fn initialize_invocation_bridge(
        js_runtime: &mut JsRuntime,
        worker_specifier: &ModuleSpecifier,
    ) -> Result<(WorkerInvocationMode, v8::Global<v8::Function>)> {
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
      return {{
        status:
          typeof rawResponse.status === "number" ? Math.trunc(rawResponse.status) : 200,
        headers: normalizeHeaders(rawResponse.headers),
        body: await rawResponse.text(),
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
      body: normalizedBody,
    }};
  }};

  const normalizeCompatResponse = async (rawResponse) => {{
    if (rawResponse instanceof Response) {{
      return {{
        status:
          typeof rawResponse.status === "number" ? Math.trunc(rawResponse.status) : 200,
        headers: normalizeHeaders(rawResponse.headers),
        body_text: await rawResponse.text(),
        error: null,
      }};
    }}

    if (rawResponse == null || typeof rawResponse !== "object") {{
      throw new Error("worker fetchCompat() must resolve to an object response");
    }}

    let normalizedBody = rawResponse.body_text ?? rawResponse.body ?? null;
    if (normalizedBody !== null && typeof normalizedBody !== "string") {{
      normalizedBody = JSON.stringify(normalizedBody);
    }}

    return {{
      status:
        typeof rawResponse.status === "number" ? Math.trunc(rawResponse.status) : 200,
      headers: normalizeHeaders(rawResponse.headers),
      body_text: normalizedBody,
      error: rawResponse.error ?? null,
    }};
  }};

  const workerModule = await import({worker_specifier});
  const webCandidate =
    typeof workerModule.fetch === "function"
      ? workerModule.fetch
      : typeof workerModule.default?.fetch === "function"
        ? workerModule.default.fetch
        : null;
  const compatCandidate =
    typeof workerModule.fetchCompat === "function"
      ? workerModule.fetchCompat
      : typeof workerModule.default?.fetchCompat === "function"
        ? workerModule.default.fetchCompat
        : null;

  const invokeWeb = async (requestInit, env, ctxBase) => {{
    const request = new Request(requestInit.url, {{
      method: requestInit.method,
      headers: requestInit.headers,
      body: requestInit.body ?? null,
    }});
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

  const invokeCompat = async (request, env, ctxBase) => {{
    const waitUntilPromises = [];
    const ctx = {{
      ...ctxBase,
      waitUntil(value) {{
        waitUntilPromises.push(Promise.resolve(value));
      }},
    }};

    const rawResponse = await compatCandidate(request, env, ctx);
    await Promise.allSettled(waitUntilPromises);
    return await normalizeCompatResponse(rawResponse);
  }};

  if (typeof compatCandidate === "function") {{
    return ["compat_v1", invokeCompat];
  }}

  if (typeof webCandidate === "function") {{
    return ["web_fetch", invokeWeb];
  }}

  throw new Error(
    "worker module must export fetch(request, env, ctx) or fetchCompat(request, env, ctx)",
  );
}})()"#
        );
        let value = js_runtime.execute_script(
            "<worker-invocation-bridge-bootstrap>",
            bridge_bootstrap_script,
        )?;
        #[allow(deprecated, reason = "good enough for experiment bootstrap")]
        let resolved = js_runtime.resolve_value(value).await?;

        let (mode, invoke_bridge) = {
            deno_core::scope!(scope, js_runtime);
            let local = v8::Local::new(scope, resolved);
            let bridge_tuple = v8::Local::<v8::Array>::try_from(local).map_err(|_| {
                anyhow::anyhow!("worker invocation bridge bootstrap must return [mode, invokeFn]")
            })?;
            let mode_value = bridge_tuple
                .get_index(scope, 0)
                .ok_or_else(|| anyhow::anyhow!("worker invocation bridge mode is missing"))?;
            let invoke_value = bridge_tuple
                .get_index(scope, 1)
                .ok_or_else(|| anyhow::anyhow!("worker invocation bridge function is missing"))?;
            let mode = serde_v8::from_v8::<String>(scope, mode_value)?;
            let invoke_bridge = v8::Local::<v8::Function>::try_from(invoke_value)
                .map_err(|_| anyhow::anyhow!("worker invocation bridge must return a function"))?;

            (mode, v8::Global::new(scope, invoke_bridge))
        };

        match mode.as_str() {
            "web_fetch" => Ok((WorkerInvocationMode::WebFetch, invoke_bridge)),
            "compat_v1" => Ok((WorkerInvocationMode::CompatV1, invoke_bridge)),
            other => bail!("unknown worker invocation mode `{other}`"),
        }
    }

    fn thread_safe_handle(&mut self) -> v8::IsolateHandle {
        self.js_runtime.v8_isolate().thread_safe_handle()
    }

    fn serialize_invocation_args(
        &mut self,
        arg0: &impl Serialize,
        arg1: &impl Serialize,
        arg2: &impl Serialize,
    ) -> Result<Vec<v8::Global<v8::Value>>> {
        let runtime = &mut self.js_runtime;
        deno_core::scope!(scope, runtime);

        let values = [
            serde_v8::to_v8(scope, arg0)?,
            serde_v8::to_v8(scope, arg1)?,
            serde_v8::to_v8(scope, arg2)?,
        ];

        Ok(values
            .into_iter()
            .map(|value| v8::Global::new(scope, value))
            .collect())
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
        let args = match self.invocation_mode {
            WorkerInvocationMode::WebFetch => self
                .serialize_invocation_args(&request, &env, &ctx)
                .map_err(|error| error.to_string())?,
            WorkerInvocationMode::CompatV1 => {
                let parsed_request = match parse_v1_request(&request) {
                    Ok(request) => request,
                    Err(error) => return Ok(public_error_response(error)),
                };
                let envelope = build_host_execution_envelope_from_context(&ctx);
                let compat_env = build_compat_env(&env, envelope.shadow_mode);
                let compat_ctx = build_compat_context(&ctx, &envelope);

                match self.serialize_invocation_args(&parsed_request, &compat_env, &compat_ctx) {
                    Ok(args) => args,
                    Err(error) => {
                        return Ok(public_error_response(internal_public_error(
                            error.to_string(),
                        )))
                    }
                }
            }
        };
        #[allow(
            deprecated,
            reason = "good enough while migrating off the script bridge"
        )]
        let resolved = self
            .js_runtime
            .call_with_args_and_await(&self.invoke_bridge, &args)
            .await
            .map_err(|error| error.to_string())?;

        let runtime = &mut self.js_runtime;
        deno_core::scope!(scope, runtime);
        let local = v8::Local::new(scope, resolved);
        match self.invocation_mode {
            WorkerInvocationMode::WebFetch => {
                serde_v8::from_v8::<WorkerResponse>(scope, local).map_err(|error| error.to_string())
            }
            WorkerInvocationMode::CompatV1 => serde_v8::from_v8::<ParsedV1Response>(scope, local)
                .map(parsed_v1_response_to_worker_response)
                .map_err(|error| error.to_string()),
        }
    }
}

pub struct CliArgs {
    pub worker_entry: PathBuf,
    pub method: String,
    pub url: String,
    pub body: Option<String>,
    pub worker_id: String,
}

impl CliArgs {
    pub fn parse() -> Result<Self> {
        let mut args = std::env::args().skip(1);
        let worker_entry = args.next().map(PathBuf::from).context(
            "usage: cargo run -p gateway-host -- <path-to-worker> [--method METHOD] [--url URL] [--body TEXT] [--worker-id ID]",
        )?;

        let mut parsed = Self {
            worker_entry,
            method: "GET".to_string(),
            url: "http://localhost/experimental".to_string(),
            body: None,
            worker_id: "example".to_string(),
        };

        while let Some(flag) = args.next() {
            match flag.as_str() {
                "--method" => {
                    parsed.method = args.next().context("--method requires a value")?;
                }
                "--url" => {
                    parsed.url = args.next().context("--url requires a value")?;
                }
                "--body" => {
                    parsed.body = Some(args.next().context("--body requires a value")?);
                }
                "--worker-id" => {
                    parsed.worker_id = args.next().context("--worker-id requires a value")?;
                }
                other => bail!("unknown argument: {other}"),
            }
        }

        Ok(parsed)
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

    fn compat_worker_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../workers/compat_v1/mod.ts")
    }

    fn compat_error_worker_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../workers/compat_v1_error/mod.ts")
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
    async fn runs_a_v1_compat_worker() {
        let mut runtime = DenoWorkerRuntime::new(&compat_worker_path())
            .await
            .expect("compat worker runtime should bootstrap");
        let response = runtime
            .fetch(
                WorkerRequest {
                    method: "POST".to_string(),
                    url: "http://localhost/compat?x=1&x=2".to_string(),
                    headers: [("x-test".to_string(), "1".to_string())]
                        .into_iter()
                        .collect(),
                    body: Some("ping".to_string()),
                },
                WorkerEnv {
                    worker_id: "compat-worker".to_string(),
                    vars: [("feature".to_string(), "beta".to_string())]
                        .into_iter()
                        .collect(),
                },
                WorkerContext {
                    metadata: [
                        ("request_id".to_string(), "req-compat-1".to_string()),
                        ("trace_id".to_string(), "trace-compat-7".to_string()),
                        ("shadow_mode".to_string(), "true".to_string()),
                    ]
                    .into_iter()
                    .collect(),
                },
            )
            .await
            .expect("compat worker fetch should succeed");

        assert_eq!(response.status, 202);
        assert_eq!(
            response.headers.get("x-compat-mode"),
            Some(&"v2-compat-v1".to_string())
        );
        assert_eq!(
            response.headers.get("x-request-id"),
            Some(&"req-compat-1".to_string())
        );
        assert_eq!(
            response.headers.get("x-shadow-mode"),
            Some(&"true".to_string())
        );
        assert_eq!(response.headers.get("x-query-x"), Some(&"1|2".to_string()));
        assert_eq!(
            response.body.as_deref(),
            Some(
                "worker=compat-worker protocol=v1 path=/compat body=ping trace=trace-compat-7 feature=beta",
            )
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn compat_worker_returns_public_bad_request_for_invalid_v1_url() {
        let mut runtime = DenoWorkerRuntime::new(&compat_worker_path())
            .await
            .expect("compat worker runtime should bootstrap");
        let response = runtime
            .fetch(
                WorkerRequest {
                    method: "GET".to_string(),
                    url: "not-a-valid-url".to_string(),
                    headers: Default::default(),
                    body: None,
                },
                WorkerEnv {
                    worker_id: "compat-worker".to_string(),
                    vars: Default::default(),
                },
                WorkerContext::default(),
            )
            .await
            .expect("compat worker should map bad input into public response");

        assert_eq!(response.status, 400);
        assert_eq!(
            response.headers.get("content-type"),
            Some(&"application/json; charset=utf-8".to_string())
        );
        assert!(response
            .body
            .as_deref()
            .expect("compat bad-request response should have body")
            .contains("\"code\":\"bad_request\""));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn compat_worker_error_field_is_normalized_to_public_error_response() {
        let mut runtime = DenoWorkerRuntime::new(&compat_error_worker_path())
            .await
            .expect("compat error worker runtime should bootstrap");
        let response = runtime
            .fetch(
                WorkerRequest {
                    method: "GET".to_string(),
                    url: "http://localhost/limited".to_string(),
                    headers: Default::default(),
                    body: None,
                },
                WorkerEnv {
                    worker_id: "compat-error-worker".to_string(),
                    vars: Default::default(),
                },
                WorkerContext {
                    metadata: [("request_id".to_string(), "req-error-1".to_string())]
                        .into_iter()
                        .collect(),
                },
            )
            .await
            .expect("compat worker error response should normalize");

        assert_eq!(response.status, 429);
        assert_eq!(
            response.headers.get("content-type"),
            Some(&"application/json; charset=utf-8".to_string())
        );
        assert_eq!(
            response.headers.get("x-worker-id"),
            Some(&"compat-error-worker".to_string())
        );
        assert_eq!(
            response.headers.get("x-request-id"),
            Some(&"req-error-1".to_string())
        );
        assert_eq!(
            response.headers.get("x-path"),
            Some(&"/limited".to_string())
        );
        assert_eq!(
            response.headers.get("x-error-contract-version"),
            Some(&"1".to_string())
        );
        let body = response
            .body
            .as_deref()
            .expect("compat error response should have body");
        assert!(body.contains("\"category\":\"rate_limited\""));
        assert!(body.contains("\"code\":\"tenant_over_quota\""));
        assert!(!body.contains("ignored"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn runtime_pool_reuses_initialized_workers() {
        let pool = WorkerRuntimePool::new(sample_worker_path(), 2, 8, Duration::from_secs(5))
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
        let pool = WorkerRuntimePool::new(blocking_worker_path(), 1, 1, Duration::from_secs(5))
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
        let pool = WorkerRuntimePool::new(flaky_worker_path(), 1, 4, Duration::from_millis(100))
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
        let pool = WorkerRuntimePool::new(flaky_worker_path(), 1, 4, Duration::from_millis(100))
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
