# dsh-cpu-temp

在 DeepSeek Harness 对话输入框的「技能」按钮右侧显示温度胶囊，客户端每秒轮询一次本地 DSH 接口。本插件不会提权、安装驱动、上传读数或收集凭据。

## 平台支持

| 系统 | 内置数据源 | 限制 |
| --- | --- | --- |
| Windows | Windows `typeperf.exe` ACPI 热区计数器 | 固件可能返回固定值或无数据；ACPI 热区不一定是 CPU Package 传感器。只能视为近似热区读数，不能当安全告警。 |
| Linux | 部分 CPU hwmon 驱动（`coretemp`、`k10temp`、`zenpower`、`cpu_thermal`）及可识别的 CPU 标签 | 取决于内核驱动和权限。故意忽略通用 ACPI、GPU、磁盘及无标签的 `tempN` 读数。没有匹配传感器时显示不可用。 |
| macOS | 无内置数据源 | 需配置外部采样器快照；本插件没有使用可移植、免特权的 macOS CPU 温度 API。 |

所有系统都可以使用外部采样器写入本地 JSON 快照。Windows 默认路径为 `C:\\Users\\Public\\dsh-cpu-temp\\snapshot.json`；Linux/macOS 或自定义路径请设置 `DSH_CPU_TEMP_SNAPSHOT_FILE`。快照格式示例：`{"ok":true,"celsius":52.0,"sampledAt":"2026-11-14T12:00:00.000Z"}`。`sampledAt` 必须是可解析时间，且不早于当前时间 30 秒以上。外部采样器负责硬件访问和所需权限；本插件只读该文件。

本仓库**不附带** LibreHardwareMonitor/PawnIO、相关 DLL、驱动、管理员计划任务、采样器二进制或自动安装器。若自行安装第三方传感器软件/驱动，请从作者官方渠道获取并先审阅许可和安全说明。DSH 不会启动或重启它们。

## 安装

公开仓库：<https://github.com/maomaoxyz1/dsh-cpu-temp>。请使用你的 DSH 发行版/Profile 所支持的插件管理器进行安装。桌面版请用应用自带插件管理器；安装后刷新页面以加载浏览器组件，无需仅为本插件重启 DSH。

## 开发与测试

需要 Node.js 22.12 或更高版本。

```sh
npm test
```

## 隐私与安全

- 客户端每秒请求同源 `/dsh-cpu-temp/snapshot`；读数只在本机 DSH 宿主和浏览器之间传递。
- 宿主只读取配置的快照文件或上文所列系统数据源；不执行 PowerShell 命令、不安装软件。
- Windows ACPI 回退按需运行一个 `typeperf.exe` 进程；连续一分钟没有请求后自动停止。

## 许可

MIT，见 [LICENSE](LICENSE)。
