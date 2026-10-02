import { app } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { CollectorScheduleInfo } from '../shared/types'

// Manages the Windows Scheduled Task that runs the headless IV collector.
//
// The task's action launches the Electron binary DIRECTLY in `--collector`
// mode (`electron.exe "<appPath>" --collector`) rather than `cmd.exe /c npm run
// collect`. Two reasons:
//   1. No console window. electron.exe is a GUI-subsystem binary and collector
//      mode never opens a BrowserWindow (see main/index.ts), so nothing is
//      visible — the old cmd.exe action is what popped a console every day.
//   2. It stays under the current user's INTERACTIVE logon, so Electron
//      safeStorage / Windows DPAPI can still decrypt the stored API keys. A
//      "run whether logged on or not" (S4U) task would run windowless too but
//      can't reach the user's DPAPI master key, silently breaking collection.
// Trade-off vs. the old action: no `electron-vite build` step, so the task runs
// whatever is compiled in `out/`. Fine for accumulation mode; a code change
// reaches the collector after the next `npm run build` (or any `npm run dev`).

const pexec = promisify(execFile)
const TASK_NAME = 'InvestingApp IV Collector'

// Windows weekly-trigger DaysOfWeek bitmask. Order = display order (weekdays first).
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const

const DEFAULTS = {
  days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
  time: '14:50' // ~3:50 PM ET when the machine is on US Central; 10 min before the close
}

function base(): CollectorScheduleInfo {
  return {
    supported: process.platform === 'win32',
    registered: false,
    enabled: false,
    days: [...DEFAULTS.days],
    time: DEFAULTS.time,
    lastRun: null,
    lastResult: null,
    nextRun: null
  }
}

function psSingleQuote(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'"
}

function psErr(e: unknown): string {
  if (e && typeof e === 'object' && 'stderr' in e) {
    const s = String((e as { stderr?: unknown }).stderr ?? '').trim()
    if (s) return s.split('\n')[0]
  }
  return e instanceof Error ? e.message : String(e)
}

async function runPs(script: string): Promise<string> {
  const { stdout } = await pexec(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024 }
  )
  return stdout
}

// Task Scheduler stores sentinel dates (e.g. 1899-11-30) for "never ran"; treat
// anything before 2000 as no value.
function cleanDate(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null
  const d = new Date(v)
  if (isNaN(d.getTime()) || d.getFullYear() < 2000) return null
  return v
}

const GET_SCRIPT = `$ErrorActionPreference='SilentlyContinue'
$name='${TASK_NAME}'
$t = Get-ScheduledTask -TaskName $name
if (-not $t) { Write-Output '{"registered":false}'; exit 0 }
$info = Get-ScheduledTaskInfo -TaskName $name
$trig = $t.Triggers | Select-Object -First 1
$map = [ordered]@{ 2='Monday'; 4='Tuesday'; 8='Wednesday'; 16='Thursday'; 32='Friday'; 64='Saturday'; 1='Sunday' }
$days = @()
$dow = 0
if ($trig -and $trig.DaysOfWeek) { $dow = [int]$trig.DaysOfWeek }
foreach ($k in $map.Keys) { if ($dow -band $k) { $days += $map[$k] } }
$time = ''
if ($trig -and $trig.StartBoundary) { try { $time = ([datetime]$trig.StartBoundary).ToString('HH:mm') } catch {} }
$lastRun = $null
if ($info -and $info.LastRunTime) { $lastRun = $info.LastRunTime.ToString('o') }
$nextRun = $null
if ($info -and $info.NextRunTime) { $nextRun = $info.NextRunTime.ToString('o') }
$lastResult = $null
if ($info) { $lastResult = [int]$info.LastTaskResult }
$obj = [ordered]@{ registered=$true; enabled=($t.State -ne 'Disabled'); days=@($days); time=$time; lastRun=$lastRun; lastResult=$lastResult; nextRun=$nextRun }
$obj | ConvertTo-Json -Compress`

export async function getCollectorSchedule(): Promise<CollectorScheduleInfo> {
  const b = base()
  if (process.platform !== 'win32') {
    return { ...b, message: 'Scheduled tasks are managed on Windows only.' }
  }
  try {
    const out = (await runPs(GET_SCRIPT)).trim()
    const raw = JSON.parse(out || '{}') as Record<string, unknown>
    if (!raw.registered) return { ...b, registered: false }
    const days = Array.isArray(raw.days) ? (raw.days as string[]) : raw.days ? [String(raw.days)] : []
    return {
      supported: true,
      registered: true,
      enabled: raw.enabled !== false,
      days: days.length ? days.filter((d) => (DAYS as readonly string[]).includes(d)) : [...DEFAULTS.days],
      time: typeof raw.time === 'string' && /^\d{2}:\d{2}$/.test(raw.time) ? raw.time : DEFAULTS.time,
      lastRun: cleanDate(raw.lastRun),
      lastResult: typeof raw.lastResult === 'number' ? raw.lastResult : null,
      nextRun: cleanDate(raw.nextRun)
    }
  } catch (e) {
    return { ...b, message: psErr(e) }
  }
}

function buildSetScript(enabled: boolean, days: string[], time: string): string {
  const exe = psSingleQuote(process.execPath)
  const appPath = psSingleQuote(app.getAppPath())
  const dayList = days.map(psSingleQuote).join(',')
  const enableCmd = enabled ? 'Enable-ScheduledTask' : 'Disable-ScheduledTask'
  // No `${` sequences below other than the intended JS interpolations — PowerShell
  // variables here are all `$word`, safe inside a JS template literal.
  return `$ErrorActionPreference='Stop'
$name='${TASK_NAME}'
$exe=${exe}
$appPath=${appPath}
$arg='"' + $appPath + '" --collector'
$action = New-ScheduledTaskAction -Execute $exe -Argument $arg -WorkingDirectory $appPath
$days = @(${dayList})
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $days -At '${time}'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
${enableCmd} -TaskName $name | Out-Null
Write-Output 'ok'`
}

export async function setCollectorSchedule(input: {
  enabled: boolean
  days: string[]
  time: string
}): Promise<CollectorScheduleInfo> {
  if (process.platform !== 'win32') {
    return { ...(await getCollectorSchedule()), message: 'Scheduled tasks are managed on Windows only.' }
  }
  // Whitelist + canonical order — days flow into a PowerShell command.
  const days = DAYS.filter((d) => Array.isArray(input.days) && input.days.includes(d))
  if (days.length === 0) {
    return { ...(await getCollectorSchedule()), message: 'Pick at least one day for the collector to run.' }
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time || '')) {
    return { ...(await getCollectorSchedule()), message: 'Enter a valid time as HH:mm (24-hour).' }
  }
  try {
    await runPs(buildSetScript(input.enabled !== false, days, input.time))
  } catch (e) {
    return { ...(await getCollectorSchedule()), message: psErr(e) }
  }
  return getCollectorSchedule()
}

export async function removeCollectorSchedule(): Promise<CollectorScheduleInfo> {
  if (process.platform !== 'win32') {
    return { ...(await getCollectorSchedule()), message: 'Scheduled tasks are managed on Windows only.' }
  }
  try {
    await runPs(`Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue; Write-Output 'ok'`)
  } catch (e) {
    return { ...(await getCollectorSchedule()), message: psErr(e) }
  }
  return getCollectorSchedule()
}
