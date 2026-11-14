# dsh-cpu-temp

Shows a temperature chip in the DeepSeek Harness composer, to the right of the **Skills** button. The client polls the local DSH endpoint once per second. The plugin does not elevate privileges, install drivers, upload readings, or collect credentials.

## Platform support

| Platform | Built-in provider | Limitations |
| --- | --- | --- |
| Windows | Windows `typeperf.exe` ACPI thermal-zone counters | Firmware may report a fixed value or no value. An ACPI zone is not necessarily the CPU package sensor; treat it as an approximate thermal-zone reading, not a safety alarm. |
| Linux | Selected CPU hwmon drivers (`coretemp`, `k10temp`, `zenpower`, `cpu_thermal`) with recognized CPU labels | Depends on kernel drivers and permissions. Generic ACPI, GPU, disk, or unlabeled `tempN` readings are intentionally ignored. No matching sensor means unavailable. |
| macOS | None built in | Configure an external sampler snapshot; there is no portable, unprivileged CPU-temperature API used by this plugin. |

All platforms can use an external sampler that writes a local JSON snapshot. On Windows the default path is `C:\\Users\\Public\\dsh-cpu-temp\\snapshot.json`; set `DSH_CPU_TEMP_SNAPSHOT_FILE` to override it or to configure the path on Linux/macOS. A compatible snapshot contains `{"ok":true,"celsius":52.0,"sampledAt":"2026-11-14T12:00:00.000Z"}`. `sampledAt` must be a parseable timestamp and no more than 30 seconds old. The external sampler owns hardware access and any required permissions; this plugin only reads the file.

This repository does **not** bundle LibreHardwareMonitor/PawnIO, their DLLs, drivers, elevated scheduled tasks, sampler binaries, or an automatic installer. If you install third-party sensor software or drivers, obtain them from their authors' official release channels and review their licenses and security notes. DSH does not start or restart them.

## Install

Find this public repository at <https://github.com/maomaoxyz1/dsh-cpu-temp>. Install it using the plugin manager/profile supported by your DSH distribution. For DSH Desktop, use its plugin manager. Refresh the page after installation so the browser component loads; do not restart DSH solely for this plugin.

## Development and tests

Requires Node.js 22.12 or newer.

```sh
npm test
```

## Privacy and security

- The browser requests the same-origin `/dsh-cpu-temp/snapshot` endpoint once per second. Readings stay between the local DSH host and browser.
- The host reads the configured snapshot file, or the platform-specific built-in provider described above. It does not execute PowerShell commands or install software.
- The Windows ACPI fallback runs one on-demand `typeperf.exe` process and stops it after one minute without requests.

## License

MIT. See [LICENSE](LICENSE).
