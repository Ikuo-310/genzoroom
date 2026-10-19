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
        self.assertIn(
            f'!insertmacro GENZOROOM_REQUIRE_NAMED_MUTEX ${{CONTEXT}} "{mutex}" $GenzoRoomInstallerMutex',
            hooks,
        )
        self.assertIn(f'"{mutex}"', host.replace("\\\\", "\\"))
        self.assertIn("acquire_with_names(", host)
        self.assertIn("Var GenzoRoomInstallerMutex", hooks)
        self.assertIn("Var GenzoRoomInstallerGateMutex", hooks)
        self.assertIn("!macro GENZOROOM_REQUIRE_NAMED_MUTEX CONTEXT MUTEX_NAME HANDLE", hooks)
        self.assertIn("!macro NSIS_HOOK_PREINSTALL", hooks)
        self.assertIn("!macro NSIS_HOOK_PREUNINSTALL", hooks)
        self.assertEqual(hooks.count("GENZOROOM_REQUIRE_INSTALLATION_MUTEX"), 3)
        self.assertIn('"Local\\GenzoRoom.InstallerGate"', hooks)
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
        run_main = template.split("Function RunMainBinary", 1)[1].split("FunctionEnd", 1)[0]
        self.assertIn('IfFileExists "$INSTDIR\\${MAINBINARYNAME}.exe" run_main_exists', run_main)
        self.assertLess(run_main.index("$GenzoRoomInstallerMutex"), run_main.index("$GenzoRoomInstallerGateMutex"))
        self.assertLess(run_main.index("GENZOROOM_RELEASE_NAMED_MUTEX"), run_main.index("RunAsUser"))
        self.assertIn("kernel32::CloseHandle(p ${HANDLE})", hooks)
        release_contexts = re.findall(
            r"GENZOROOM_RELEASE_NAMED_MUTEX\s+\S+\s+\S+\s+(\w+)",
            template,
        )
        self.assertEqual(len(release_contexts), len(set(release_contexts)))
        self.assertIn('Pop $0', run_main)
        self.assertIn('StrCmp $0 0 run_main_done', run_main)
        self.assertNotIn("kernel32::ReleaseMutex", hooks)
        english = (ROOT / "desktop/nsis/languages/English.nsh").read_text(encoding="utf-8")
        japanese = (ROOT / "desktop/nsis/languages/Japanese.nsh").read_text(encoding="utf-8")
        self.assertIn("GenzoRoomInstallBlocked", english)
        self.assertIn("GenzoRoomInstallBlocked", japanese)
        self.assertRegex(english, r'LangString createDesktop \$\{LANG_ENGLISH\} ".+"')
        self.assertRegex(japanese, r'LangString createDesktop \$\{LANG_JAPANESE\} ".+"')
        self.assertIn("GenzoRoomLaunchFailed", english)
        self.assertIn("GenzoRoomLaunchFailed", japanese)
        self.assertIn("GenzoRoomLaunchLockFailed", english)
        self.assertIn("GenzoRoomLaunchLockFailed", japanese)

    def test_installer_locks_before_pages_and_hands_off_only_the_app_mutex_for_updates(self):
        template = (ROOT / "desktop/nsis/installer.nsi").read_text(encoding="utf-8")
        hooks = (ROOT / "desktop/nsis/installer-hooks.nsh").read_text(encoding="utf-8")
        host = (ROOT / "desktop/src/single_instance.rs").read_text(encoding="utf-8")

        installer_init = template.split("Function .onInit", 1)[1].split("FunctionEnd", 1)[0]
        self.assertLess(
            installer_init.index("GENZOROOM_REQUIRE_INSTALLER_GATE"),
            installer_init.index("GENZOROOM_REQUIRE_INSTALLATION_MUTEX"),
        )
        uninstaller_init = template.split("Function un.onInit", 1)[1].split("FunctionEnd", 1)[0]
        self.assertIn('"/GENZOROOM_HANDOFF"', uninstaller_init)
        self.assertIn("${If} $HandoffMode <> 1", uninstaller_init)
        self.assertLess(
            uninstaller_init.index("GENZOROOM_REQUIRE_INSTALLER_GATE"),
            uninstaller_init.index("GENZOROOM_REQUIRE_INSTALLATION_MUTEX"),
        )

        reinstall = template.split("Function PageLeaveReinstall", 1)[1].split("FunctionEnd", 1)[0]
        release = reinstall.index("GENZOROOM_RELEASE_NAMED_MUTEX $GenzoRoomInstallerMutex")
        self.assertIn('StrCpy $R1 "$R1 /GENZOROOM_HANDOFF"', reinstall)
        child = reinstall.index("ExecWait '$R1' $0")
        reacquire = reinstall.index("GENZOROOM_REQUIRE_INSTALLATION_MUTEX reinstall_mutex_reacquire")
        self.assertLess(release, child)
        self.assertLess(child, reacquire)
        self.assertNotIn("GENZOROOM_RELEASE_NAMED_MUTEX $GenzoRoomInstallerGateMutex", reinstall)

        install_section = template.split("Section Install", 1)[1].split("SectionEnd", 1)[0]
        self.assertLess(install_section.index("NSIS_HOOK_PREINSTALL"), install_section.index('File "${MAINBINARYSRCPATH}"'))
        uninstall_section = template.split("Section Uninstall", 1)[1].split("SectionEnd", 1)[0]
        self.assertLess(uninstall_section.index("NSIS_HOOK_PREUNINSTALL"), uninstall_section.index('Delete "$INSTDIR\\${MAINBINARYNAME}.exe"'))

        self.assertIn('"Local\\GenzoRoom.InstallerGate"', hooks)
        normalized_host = host.replace("\\\\", "\\")
        self.assertIn('"Local\\GenzoRoom.InstallerGate"', normalized_host)
        self.assertLess(normalized_host.index("create_named(installer_gate_name)"), normalized_host.index("acquire_named(application_name)"))
        self.assertLess(
            normalized_host.index("acquire_named(application_name)"),
            normalized_host.index("drop(gate)"),
            "the startup probe must stay held until the host mutex is established",
        )
        self.assertIn('Some("desktop_install_in_progress")', host)
        self.assertIn("an_active_installer_gate_blocks_host_startup_and_releases_cleanly", host)

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
