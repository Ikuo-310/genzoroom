//! Resolve once: restarts must not switch executable, working directory, or deployment mode.
use std::{
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Clone, Debug)]
pub struct BackendLaunch {
    pub executable: PathBuf,
    pub directory: PathBuf,
    script: Option<PathBuf>,
}

impl BackendLaunch {
    pub fn resolve() -> Result<Self, &'static str> {
        #[cfg(feature = "bundled-backend")]
        {
            let executable = std::env::current_exe().map_err(|_| "backend_bundle_missing")?;
            let directory = executable.parent().ok_or("backend_bundle_missing")?;
            Ok(Self::bundled(directory))
        }
        #[cfg(not(feature = "bundled-backend"))]
        {
            let root = Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .ok_or("repository_missing")?;
            Ok(Self::development(root))
        }
    }

    #[cfg(any(test, not(feature = "bundled-backend")))]
    fn development(root: &Path) -> Self {
        Self {
            executable: root.join(".venv/Scripts/python.exe"),
            directory: root.join("backend"),
            script: Some(root.join("backend/windows_local.py")),
        }
    }

    #[cfg(any(test, feature = "bundled-backend"))]
    fn bundled(root: &Path) -> Self {
        let directory = root.join("backend");
        Self {
            executable: directory.join("genzoroom-backend.exe"),
            directory,
            script: None,
        }
    }

    pub fn command(&self) -> Result<Command, &'static str> {
        if !self.executable.is_file()
            || self.script.as_ref().is_some_and(|script| !script.is_file())
        {
            return Err(if self.script.is_none() {
                "backend_bundle_missing"
            } else {
                "backend_python_or_entry_missing"
            });
        }
        let mut command = Command::new(&self.executable);
        if let Some(script) = &self.script {
            command.arg(script);
        }
        command
            .args(["--desktop", "--managed"])
            .current_dir(&self.directory);
        // Ignore ambient Python configuration; both runtimes own their module search path.
        command.env_remove("PYTHONHOME").env_remove("PYTHONPATH");
        Ok(command)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn layouts_never_guess_a_development_fallback() {
        let root = std::env::temp_dir().join("genzoroom-absent-bundle");
        let bundled = BackendLaunch::bundled(&root);
        assert_eq!(
            bundled.executable,
            root.join("backend/genzoroom-backend.exe")
        );
        assert!(bundled.script.is_none());
        assert!(matches!(bundled.command(), Err("backend_bundle_missing")));
        let development = BackendLaunch::development(&root);
        assert_eq!(
            development.script,
            Some(root.join("backend/windows_local.py"))
        );
    }
}
