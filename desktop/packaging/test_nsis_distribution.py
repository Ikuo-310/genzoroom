"""Guard the supported NSIS distribution configuration and localized pages."""
import json
from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[2]


class NsisDistributionTests(unittest.TestCase):
    def test_distribution_configuration_uses_per_user_nsis_and_offline_evergreen(self):
        config = json.loads((ROOT / "desktop/tauri.bundle.conf.json").read_text(encoding="utf-8"))
        self.assertEqual(config["productName"], "GenzoRoom")
        self.assertEqual(config["identifier"], "com.genzoroom.desktop")
        self.assertTrue(config["bundle"]["active"])
        self.assertEqual(config["bundle"]["targets"], ["nsis"])
        self.assertEqual(config["bundle"]["windows"]["nsis"]["installMode"], "currentUser")
        self.assertEqual(config["bundle"]["windows"]["webviewInstallMode"]["type"], "offlineInstaller")
        self.assertEqual(config["bundle"]["windows"]["nsis"]["installerIcon"], "icons/icon.ico")
        self.assertEqual(config["bundle"]["windows"]["nsis"]["uninstallerIcon"], "icons/icon.ico")
        self.assertEqual(config["bundle"]["windows"]["nsis"]["template"], "nsis/installer.nsi")

    def test_custom_template_keeps_data_cleanup_and_non_terminating_launch(self):
        template = (ROOT / "desktop/nsis/installer.nsi").read_text(encoding="utf-8")
        hooks = (ROOT / "desktop/nsis/installer-hooks.nsh").read_text(encoding="utf-8")
        self.assertIn('StrCpy $INSTDIR "$LOCALAPPDATA\\Programs\\${PRODUCTNAME}"', template)
        self.assertNotIn("DeleteAppDataCheckbox", template)
        self.assertNotRegex(template, r"(?i)RmDir\s+/r\s+\"\$LOCALAPPDATA\\\$\{BUNDLEID\}")
        for folder in ("backend", "licenses", "source"):
            self.assertIn(f'RMDir /r "$INSTDIR\\{folder}"', hooks)
        self.assertNotIn("NSIS_HOOK_PREUNINSTALL", hooks)

        run_main = template.split("Function RunMainBinary", 1)[1].split("FunctionEnd", 1)[0]
        self.assertIn('nsis_tauri_utils::RunAsUser "$INSTDIR\\${MAINBINARYNAME}.exe" ""', run_main)
        self.assertNotRegex(run_main, r"(?i)mutex|CreateMutex|RestartManager")
        self.assertNotRegex(template + hooks, r"(?i)CheckIfAppIsRunning|RmShutdown|TerminateProcess|taskkill")
        self.assertNotRegex(template + hooks, r"(?i)InstallerGate|GENZOROOM_HANDOFF|GENZOROOM_REQUIRE_.*MUTEX")

    def test_running_app_check_precedes_install_and_uninstall_with_retry_or_cancel(self):
        template = (ROOT / "desktop/nsis/installer.nsi").read_text(encoding="utf-8")
        hooks = (ROOT / "desktop/nsis/installer-hooks.nsh").read_text(encoding="utf-8")
        installer_init = template.split("Function .onInit", 1)[1].split("FunctionEnd", 1)[0]
        uninstaller_init = template.split("Function un.onInit", 1)[1].split("FunctionEnd", 1)[0]
        self.assertIn("GENZOROOM_CHECK_APP_NOT_RUNNING installer_process_check", installer_init)
        self.assertIn("GENZOROOM_CHECK_APP_NOT_RUNNING uninstaller_process_check", uninstaller_init)
        self.assertLess(template.index("Function .onInit"), template.index("Section WebView2"))
        self.assertLess(template.index("Function un.onInit"), template.index("Section Uninstall"))

        self.assertIn("!macro GENZOROOM_CHECK_APP_NOT_RUNNING CONTEXT", hooks)
        self.assertIn('"$SYSDIR\\tasklist.exe" /FI "IMAGENAME eq ${MAINBINARYNAME}.exe" /FO CSV /NH', hooks)
        self.assertIn('StrCpy $R7 $R9 1', hooks)
        self.assertIn('StrCmp $R7 $\\" ${CONTEXT}_running ${CONTEXT}_done', hooks)
        self.assertIn("MB_ICONEXCLAMATION|MB_RETRYCANCEL", hooks)
        self.assertIn("IDRETRY ${CONTEXT}_check_again", hooks)
        self.assertIn("IDCANCEL ${CONTEXT}_cancelled", hooks)
        self.assertIn('StrCmp $PassiveMode "1" ${CONTEXT}_silent_cancel', hooks)
        self.assertIn("Abort", hooks)
        self.assertIn("$(GenzoRoomMustExit)", hooks)
        self.assertIn("$(GenzoRoomProcessCheckFailed)", hooks)
        self.assertNotRegex(template + hooks, r"(?i)RmShutdown|TerminateProcess|taskkill|CheckIfAppIsRunning")

    def test_all_installer_language_references_are_defined_and_nonempty(self):
        template = (ROOT / "desktop/nsis/installer.nsi").read_text(encoding="utf-8")
        hooks = (ROOT / "desktop/nsis/installer-hooks.nsh").read_text(encoding="utf-8")
        references = set(re.findall(r"\$\(([^)]+)\)", f"{template}\n{hooks}"))
        references.discard("^RTL")  # This is an NSIS built-in, not a localized Tauri string.

        reinstall_strings = {
            "alreadyInstalledLong",
            "alreadyInstalled",
            "chooseMaintenanceOption",
            "addOrReinstall",
            "uninstallApp",
            "olderOrUnknownVersionInstalled",
            "uninstallBeforeInstalling",
            "dontUninstall",
            "choowHowToInstall",
            "newerVersionInstalled",
            "dontUninstallDowngrade",
        }
        self.assertTrue(reinstall_strings.issubset(references))

        for language, language_id in (("English", "LANG_ENGLISH"), ("Japanese", "LANG_JAPANESE")):
            with self.subTest(language=language):
                source = (ROOT / f"desktop/nsis/languages/{language}.nsh").read_text(encoding="utf-8")
                definitions = re.findall(
                    rf'^LangString\s+(\w+)\s+\$\{{{language_id}\}}\s+"([^"\r\n]*)"\s*$',
                    source,
                    re.MULTILINE,
                )
                keys = [key for key, _ in definitions]
                values = dict(definitions)
                self.assertEqual(len(keys), len(set(keys)), "language string keys must not be duplicated")
                self.assertTrue(references.issubset(values.keys()), f"missing strings: {references - values.keys()}")
                self.assertTrue(all(value.strip() for value in values.values()), "language strings must not be blank")


if __name__ == "__main__":
    unittest.main()
