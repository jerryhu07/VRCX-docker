# Windows Installer

Download the installer from Game Log and double-click it. No Node.js installation is required.

The settings icon in Game Log edits the backend's saved client configuration. Saving does not change an already running Windows client; download the updated config or installer to apply it. Installer/config downloads inside the settings dialog save the edited fields first. Secrets are excluded from settings writes and generated separately by the backend.

Each editable setting and the complete form can be reset to defaults before saving. Defaults use `streamer_<VRChat user ID>` as the client ID, the browser origin as the backend URL, and Backfill for history (limited to 14 days and 20 files). Resetting defaults never rotates the secret or deletes checkpoint/server data.

Secret rotation requires confirmation, immediately revokes the previous secret and connected clients, and persists an override in SQLite (including when the initial secret came from `VRCX_LOG_STREAM_TOKEN`). Existing VRChat authentication and log records are not changed. Update every client with the new configuration after rotating. Rotation is not performed automatically on deployment or download.

The installer independently asks whether to replace the existing executable, replace the configuration, and reset checkpoints. Answering No skips only that item. Replaced exe/config files are backed up with `.previous`; reset checkpoints are renamed to `.before-reset-*`. Server records are never deleted.

Installers downloaded through Game Log include the complete configuration, generated at download time. No separate config file is required. The downloaded installer itself contains a secret: do not share it. Config extraction is independent of the installer's filename and location. Choosing No for configuration replacement still keeps the installed config unchanged. Configuration files and their backups also contain the secret. Existing checkpoint paths are retained when replacing configuration.

Locally built (not personalized) installers can still use `vrcx-log-streamer.config.json` beside the exe or ask for the backend URL. Installation errors include the failing step/line and are saved in `installer-error.log` in the installation directory.

Resetting checkpoints does not itself request backfill. On next startup, choose Backfill to re-read eligible logs, or Skip to ignore old logs. Backfill remains limited by `historyMaxDays` and `historyMaxFiles`; duplicate events are deduplicated by the backend. Windows clients without a terminal use a dialog for `historyMode=ask`.

Installation requires UAC approval to register the VRChat process-start trigger. The trigger starts an on-demand scheduled task under the initiating user's limited privileges, not SYSTEM. No streamer process runs while VRChat is closed. Launching the installer does not launch VRChat.

Startup registration queries existing WMI instances first: new objects use `-Class -PutType CreateOnly`, existing filter/consumer objects use `-InputObject -PutType UpdateOnly`, and existing bindings are reused. Class paths cannot be used with `UpdateOrCreate`. Antivirus blocking is not bypassed. If a security product reports a threat, keep its detection name and installation error step for investigation. Do not submit personalized installers to public scanners: they contain your secret. Only the locally built, unpersonalized template is suitable for a vendor review after checking it contains no private configuration.

The on-demand task is registered directly through Windows Task Scheduler COM, with interactive-user logon, limited privileges, no stored password, and `PT0S` for unlimited execution time. It has no boot/logon/timer trigger: WMI remains the only automatic start signal. Reinstallation validates the new definition first, backs up the old XML to `startup-task.before-rebuild.xml`, and recreates only the application's named task rather than retaining its previous runtime state. If creation fails, it attempts to restore the old definition. System tasks and the Windows TaskCache registry are never modified directly. Immediate startup uses the same `schtasks.exe /Run /TN` command as WMI and checks its exit code. Errors after successful registration explicitly distinguish installed-but-not-started from incomplete installation. Error reports include HRESULT and the initiating user's SID for native registration diagnosis.

The current task is `VRCXLogStreamerVRChatStartV2`, registered from serialized XML using `RegisterTask`. WMI points to that task. The legacy V1 task is not used; it has no automatic trigger. Diagnostic scripts/tasks are not included in the main executable.

Backend log deduplication identifies a source record by filename, byte offset, and raw line, independent of client ID. Renaming a client no longer turns a previously stored source record into an accepted event. Legacy records are matched through a source lookup; new records use a canonical source hash. Duplicates advance client checkpoints and restore in-memory instance context without replaying database activity writes. Previously stored duplicates are not removed automatically.

Build: `npm run build:log-streamer:win-x64` produces both the client and the installer in `build/`. The installer is not code-signed. Windows may show an unrecognized publisher warning.

Tests: `pwsh -NoProfile -File tools/log-streamer/install.test.ps1` checks all eight independent file-update/reset combinations and backups. Native Windows UAC, WMI, and Task Scheduler integration must also be verified on Windows.
