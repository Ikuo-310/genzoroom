"""Guard the installer/host mutual exclusion and user-data boundary configuration."""
import json
from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[2]


class InstallerGuardTests(unittest.TestCase):
    def test_distribution_configuration_uses_per_user_nsis_and_offline_evergreen(self):
        config = json.loads((ROOT / "desktop/tauri.bundle.conf.json").read_text(encoding="utf-8"))
        self.assertEqual(config["productName"], "GenzoRoom")
        self.assertEqual(config["identifier"], "com.genzoroom.desktop")
        self.assertEqual(config["version"], "0.0.0-validation")
        self.assertTrue(config["bundle"]["active"])
        self.assertEqual(config["bundle"]["targets"], ["nsis"])
        self.assertEqual(config["bundle"]["license"], "AGPL-3.0-only")
        self.assertEqual(config["bundle"]["licenseFile"], "../LICENSE")
        self.assertFalse(config["bundle"]["windows"]["allowDowngrades"])
        self.assertEqual(config["bundle"]["windows"]["nsis"]["installMode"], "currentUser")
        self.assertEqual(config["bundle"]["windows"]["webviewInstallMode"]["type"], "offlineInstaller")
        self.assertEqual(config["bundle"]["windows"]["nsis"]["installerIcon"], "icons/icon.ico")
        self.assertEqual(config["bundle"]["windows"]["nsis"]["uninstallerIcon"], "icons/icon.ico")
        self.assertEqual(config["bundle"]["windows"]["nsis"]["template"], "nsis/installer.nsi")
        self.assertEqual(set(config["bundle"]["windows"]["nsis"]["customLanguageFiles"]), {"English", "Japanese"})
        self.assertIn("packaging/out/staged/source/", config["bundle"]["resources"])
        self.assertIn("packaging/out/staged/licenses/", config["bundle"]["resources"])

    def test_install_and_uninstall_hooks_fail_closed_on_the_live_host_mutex(self):
        hooks = (ROOT / "desktop/nsis/installer-hooks.nsh").read_text(encoding="utf-8")
        host = (ROOT / "desktop/src/single_instance.rs").read_text(encoding="utf-8")
        mutex = "Local\\GenzoRoom.WindowsPoC"
        self.assertEqual(hooks.count(f'w "{mutex}"'), 1)
        self.assertIn(f'acquire_named("{mutex}")', host.replace("\\\\", "\\"))
        self.assertIn("Var GenzoRoomInstallerMutex", hooks)
        self.assertIn('StrCmp $GenzoRoomInstallerMutex ""', hooks)
        self.assertIn("!macro NSIS_HOOK_PREINSTALL", hooks)
        self.assertIn("!macro NSIS_HOOK_PREUNINSTALL", hooks)
        self.assertEqual(hooks.count("GENZOROOM_REQUIRE_INSTALLATION_MUTEX"), 3)
        self.assertIn("SetErrorLevel 2", hooks)
        self.assertIn("SetErrorLevel 3", hooks)
        self.assertEqual(len(re.findall(r"\bAbort\b", hooks)), 4)
        self.assertNotRegex(hooks, r"(?i)KillProcess|TerminateProcess|taskkill")
        self.assertNotRegex(hooks, r"(?i)RMDir\s+/r.*(?:LOCALAPPDATA|APPDATA)")
        for folder in ("backend", "licenses", "source"):
            self.assertIn(f'RMDir /r "$INSTDIR\\{folder}"', hooks)
        template = (ROOT / "desktop/nsis/installer.nsi").read_text(encoding="utf-8")
        self.assertIn('StrCpy $INSTDIR "$LOCALAPPDATA\\Programs\\${PRODUCTNAME}"', template)
        self.assertNotIn("!insertmacro CheckIfAppIsRunning", template)
        self.assertIn("!insertmacro GENZOROOM_REQUIRE_INSTALLATION_MUTEX webview", template)
        self.assertIn("NSIS_HOOK_PREINSTALL", template)
        self.assertIn("NSIS_HOOK_PREUNINSTALL", template)
        self.assertNotIn("DeleteAppDataCheckbox", template)
        self.assertNotRegex(template, r"(?i)RmDir\s+/r\s+\"\$LOCALAPPDATA\\\$\{BUNDLEID\}")
        english = (ROOT / "desktop/nsis/languages/English.nsh").read_text(encoding="utf-8")
        japanese = (ROOT / "desktop/nsis/languages/Japanese.nsh").read_text(encoding="utf-8")
        self.assertIn("GenzoRoomInstallBlocked", english)
        self.assertIn("GenzoRoomInstallBlocked", japanese)


if __name__ == "__main__":
    unittest.main()
