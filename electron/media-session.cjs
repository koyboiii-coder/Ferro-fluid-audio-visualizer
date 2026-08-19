const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");

// Bridges into Windows' System Media Transport Controls (the same API that
// feeds the volume-flyout "now playing" card) via a WinRT-reflection trick
// that only works from a real powershell.exe process — there's no Node/N-API
// binding for WinRT, so this runs inside a PowerShell script instead of
// linking a native module (this project already had enough native-module
// packaging pain with electron-builder).
//
// Runs as one long-lived process (same reasoning as the volume server
// below): a fresh one-shot powershell.exe process cost ~470-500ms per call
// here too — mostly interpreter/WinRT startup, not any single slow step —
// which capped how often the "now playing" poll could usefully run and put
// a real floor under how fast a track change could show up in the bar.
// Compiling nothing and just holding the SessionManager open, each POLL
// after the first costs a few ms instead.
const MEDIA_SERVER_SCRIPT = [
  // Windows PowerShell writes stdout using the console's OEM/ANSI codepage
  // by default, not UTF-8 — track titles with tildes/ñ (very common in
  // Spanish) came out as mojibake once Node decoded the piped bytes as
  // UTF-8. Forcing the output encoding here fixes it at the source.
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "$ErrorActionPreference = 'SilentlyContinue'",
  "Add-Type -AssemblyName System.Runtime.WindowsRuntime",
  "$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]",
  "function Await($WinRtTask, $ResultType) { $asTask = $asTaskGeneric.MakeGenericMethod($ResultType); $netTask = $asTask.Invoke($null, @($WinRtTask)); $netTask.Wait(-1) | Out-Null; $netTask.Result }",
  "[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null",
  "$manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])",
  "function Get-SpotifySession { $manager.GetSessions() | Where-Object { $_.SourceAppUserModelId -match 'Spotify' } | Select-Object -First 1 }",
  "function Write-Line($s) { [Console]::Out.WriteLine($s); [Console]::Out.Flush() }",
  "while ($true) {",
  "  $line = [Console]::In.ReadLine()",
  "  if ($null -eq $line) { break }",
  "  $session = Get-SpotifySession",
  "  if ($line -eq 'POLL') {",
  "    if ($null -eq $session) {",
  "      Write-Line '{\"active\":false}'",
  "    } else {",
  "      $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])",
  "      $playback = $session.GetPlaybackInfo()",
  "      $timeline = $session.GetTimelineProperties()",
  // position/duration in seconds (as plain doubles, so ConvertTo-Json emits
  // invariant '.'-decimal numbers regardless of the system's locale) plus a
  // Unix-ms timestamp of when that position was last accurate — the
  // renderer interpolates real elapsed wall-clock time from these instead
  // of running its own ticking interval, so it never drifts from Spotify.
  "      $result = [PSCustomObject]@{",
  "        active = $true",
  // Hardcoded rather than derived from SourceAppUserModelId: the session
  // lookup above only ever matches Spotify (-match 'Spotify'), so this is
  // simply naming what was already filtered for. If another source is ever
  // added, that filter and this line grow together.
  "        source = 'Spotify'",
  "        title = $props.Title",
  "        artist = $props.Artist",
  "        status = $playback.PlaybackStatus.ToString()",
  "        position = [double]$timeline.Position.TotalSeconds",
  "        duration = [double]($timeline.EndTime.TotalSeconds - $timeline.StartTime.TotalSeconds)",
  "        lastUpdated = [int64]$timeline.LastUpdatedTime.ToUnixTimeMilliseconds()",
  "      }",
  "      Write-Line ($result | ConvertTo-Json -Compress)",
  "    }",
  "  } elseif ($null -ne $session -and $line -eq 'PLAY') {",
  "    Await ($session.TryPlayAsync()) ([System.Boolean]) | Out-Null; Write-Line 'ok'",
  "  } elseif ($null -ne $session -and $line -eq 'PAUSE') {",
  "    Await ($session.TryPauseAsync()) ([System.Boolean]) | Out-Null; Write-Line 'ok'",
  "  } elseif ($null -ne $session -and $line -eq 'NEXT') {",
  "    Await ($session.TrySkipNextAsync()) ([System.Boolean]) | Out-Null; Write-Line 'ok'",
  "  } elseif ($null -ne $session -and $line -eq 'PREVIOUS') {",
  "    Await ($session.TrySkipPreviousAsync()) ([System.Boolean]) | Out-Null; Write-Line 'ok'",
  "  } else {",
  "    Write-Line 'noop'",
  "  }",
  "}",
].join("\n");

let mediaProc = null;
let mediaQueue = []; // FIFO resolvers, matched 1:1 with response lines in order
let mediaScriptPath = null;

function getMediaScriptPath() {
  if (!mediaScriptPath) {
    mediaScriptPath = path.join(os.tmpdir(), "nikkiro-media-server.ps1");
    fs.writeFileSync(mediaScriptPath, MEDIA_SERVER_SCRIPT, "utf8");
  }
  return mediaScriptPath;
}

function ensureMediaProcess() {
  if (mediaProc && !mediaProc.killed) return;
  mediaProc = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", getMediaScriptPath()],
    { windowsHide: true }
  );
  const rl = readline.createInterface({ input: mediaProc.stdout });
  rl.on("line", (line) => {
    const resolve = mediaQueue.shift();
    if (resolve) resolve(line.trim());
  });
  const reset = () => {
    const pending = mediaQueue;
    mediaQueue = [];
    pending.forEach((resolve) => resolve(null));
    mediaProc = null;
  };
  mediaProc.on("exit", reset);
  mediaProc.on("error", reset);
}

function sendMediaLine(line) {
  return new Promise((resolve) => {
    ensureMediaProcess();
    mediaQueue.push(resolve);
    mediaProc.stdin.write(line + "\n");
  });
}

function stopMediaProcess() {
  if (mediaProc && !mediaProc.killed) mediaProc.kill();
}

// System master volume: SMTC (the WinRT API above) has no volume concept at
// all — it only exposes transport controls + metadata. Real volume lives in
// the separate, much older Core Audio COM API (IAudioEndpointVolume on the
// default output device), which has no WinRT/.NET-reflection shortcut — it
// has to be reached via raw COM interop, declared here as inline C#
// compiled by Add-Type. The interface declarations only need to be correct
// up through the last member actually called; earlier unused members are
// stubbed (NotImplN) purely to keep each interface's vtable slot order
// intact.
//
// Unlike the one-shot scripts above, this one runs as a long-lived
// PowerShell *process* instead of being spawned fresh per call: Add-Type's
// C# compile step alone costs ~400-500ms, which made every drag/keyboard
// volume change audibly lag behind the ring — nowhere near dial-like. The
// process compiles the helper exactly once at startup, then sits blocked on
// [Console]::In.ReadLine() reading one command per line ("GET" / "SET 0.42")
// and writing one response line back, so every call after the first is just
// a fast COM round-trip (single-digit ms) with no recompilation.
const VOLUME_SERVER_SCRIPT = [
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "$ErrorActionPreference = 'SilentlyContinue'",
  "Add-Type -Language CSharp -TypeDefinition @'",
  "using System;",
  "using System.Runtime.InteropServices;",
  "[Guid(\"BCDE0395-E52F-467C-8E3D-C4579291692E\")] class MMDeviceEnumeratorComObject { }",
  "[Guid(\"A95664D2-9614-4F35-A746-DE8DB63617E6\"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]",
  "interface IMMDeviceEnumerator {",
  "  int EnumAudioEndpoints(int dataFlow, int dwStateMask, out IntPtr ppDevices);",
  "  int GetDefaultAudioEndpoint(int dataFlow, int role, [MarshalAs(UnmanagedType.Interface)] out IMMDevice ppEndpoint);",
  "}",
  "[Guid(\"D666063F-1587-4E43-81F1-B948E807363F\"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]",
  "interface IMMDevice {",
  "  int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);",
  "}",
  "[Guid(\"5CDF2C82-841E-4546-9722-0CF74078229A\"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]",
  "interface IAudioEndpointVolume {",
  "  int NotImpl1(); int NotImpl2(); int NotImpl3();", // RegisterControlChangeNotify, UnregisterControlChangeNotify, GetChannelCount
  "  int SetMasterVolumeLevel(float fLevelDB, ref Guid pguidEventContext);",
  "  int SetMasterVolumeLevelScalar(float fLevel, ref Guid pguidEventContext);",
  "  int GetMasterVolumeLevel(out float pfLevelDB);",
  "  int GetMasterVolumeLevelScalar(out float pfLevel);",
  "}",
  "public class NikkiroAppAudio {",
  "  static IAudioEndpointVolume GetEndpointVolume() {",
  "    var enumeratorType = Type.GetTypeFromCLSID(Guid.Parse(\"BCDE0395-E52F-467C-8E3D-C4579291692E\"));",
  "    var enumerator = (IMMDeviceEnumerator)Activator.CreateInstance(enumeratorType);",
  "    IMMDevice device; enumerator.GetDefaultAudioEndpoint(0, 0, out device);",
  "    if (device == null) return null;",
  "    Guid iidVol = Guid.Parse(\"5CDF2C82-841E-4546-9722-0CF74078229A\");",
  "    object volObj; device.Activate(ref iidVol, 23, IntPtr.Zero, out volObj);",
  "    return (IAudioEndpointVolume)volObj;",
  "  }",
  "  public static object GetVolume() {",
  "    var vol = GetEndpointVolume();",
  "    if (vol == null) return null;",
  "    float level; vol.GetMasterVolumeLevelScalar(out level);",
  "    return (double)level;",
  "  }",
  "  public static object SetVolume(double level) {",
  "    var vol = GetEndpointVolume();",
  "    if (vol == null) return null;",
  "    float clamped = (float)Math.Max(0, Math.Min(1, level));",
  "    Guid ctx = Guid.Empty;",
  "    vol.SetMasterVolumeLevelScalar(clamped, ref ctx);",
  "    float check; vol.GetMasterVolumeLevelScalar(out check);",
  "    return (double)check;",
  "  }",
  "}",
  "'@",
  "function Write-Result($v) {",
  "  if ($null -eq $v) { [Console]::Out.WriteLine('null') }",
  "  else { [Console]::Out.WriteLine([string]::Format([System.Globalization.CultureInfo]::InvariantCulture, '{0}', $v)) }",
  "  [Console]::Out.Flush()",
  "}",
  "while ($true) {",
  "  $line = [Console]::In.ReadLine()",
  "  if ($null -eq $line) { break }",
  "  if ($line -eq 'GET') {",
  "    Write-Result ([NikkiroAppAudio]::GetVolume())",
  "  } elseif ($line.StartsWith('SET ')) {",
  "    $level = [double]::Parse($line.Substring(4), [System.Globalization.CultureInfo]::InvariantCulture)",
  "    Write-Result ([NikkiroAppAudio]::SetVolume($level))",
  "  } else {",
  "    Write-Result $null",
  "  }",
  "}",
].join("\n");

let volumeProc = null;
let volumeQueue = []; // FIFO resolvers, matched 1:1 with response lines in order
let volumeScriptPath = null;

function getVolumeScriptPath() {
  if (!volumeScriptPath) {
    volumeScriptPath = path.join(os.tmpdir(), "nikkiro-volume-server.ps1");
    fs.writeFileSync(volumeScriptPath, VOLUME_SERVER_SCRIPT, "utf8");
  }
  return volumeScriptPath;
}

function ensureVolumeProcess() {
  if (volumeProc && !volumeProc.killed) return;
  // The script has to come from a *file* (-File), not -Command via stdin:
  // stdin needs to stay open afterward for the script's own ReadLine() loop
  // to keep consuming GET/SET commands as plain data, not more PS code.
  volumeProc = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", getVolumeScriptPath()],
    { windowsHide: true }
  );
  const rl = readline.createInterface({ input: volumeProc.stdout });
  rl.on("line", (line) => {
    const resolve = volumeQueue.shift();
    if (resolve) resolve(line.trim());
  });
  const reset = () => {
    const pending = volumeQueue;
    volumeQueue = [];
    pending.forEach((resolve) => resolve(null));
    volumeProc = null;
  };
  volumeProc.on("exit", reset);
  volumeProc.on("error", reset);
}

function sendVolumeCommand(line) {
  return new Promise((resolve) => {
    ensureVolumeProcess();
    volumeQueue.push(resolve);
    volumeProc.stdin.write(line + "\n");
  });
}

function stopVolumeProcess() {
  if (volumeProc && !volumeProc.killed) volumeProc.kill();
}

const COMMAND_LINES = {
  play: "PLAY",
  pause: "PAUSE",
  next: "NEXT",
  previous: "PREVIOUS",
};

async function pollNowPlaying() {
  const out = await sendMediaLine("POLL");
  if (!out) return { active: false };
  try {
    return JSON.parse(out);
  } catch {
    return { active: false };
  }
}

async function sendMediaCommand(action) {
  const line = COMMAND_LINES[action];
  if (!line) return;
  await sendMediaLine(line);
}

async function pollVolume() {
  const out = await sendVolumeCommand("GET");
  if (!out || out === "null") return null;
  const value = Number(out);
  return Number.isFinite(value) ? value : null;
}

async function setMediaVolume(level) {
  const clamped = Math.max(0, Math.min(1, level));
  // Interpolated as a fixed, pre-validated decimal literal (not user text),
  // formatted with '.' regardless of locale — PowerShell number parsing is
  // set to InvariantCulture on the other end, so this is unambiguous.
  const out = await sendVolumeCommand(`SET ${clamped.toFixed(4)}`);
  if (!out || out === "null") return null;
  const value = Number(out);
  return Number.isFinite(value) ? value : null;
}

// Polls on an interval and only calls onUpdate when the reported state
// actually changes, so the renderer isn't re-rendering the bar every tick.
// 700ms (was 2000ms) is affordable now that each POLL is a few-ms round
// trip to the persistent process above instead of a fresh ~500ms process
// spawn — track changes in Spotify now show up in well under a second
// instead of up to ~2.5s late.
function startMediaPolling(onUpdate, intervalMs = 700) {
  if (process.platform !== "win32") return () => {};
  let stopped = false;
  let busy = false;
  let lastJson = "";
  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const state = await pollNowPlaying();
      const json = JSON.stringify(state);
      if (json !== lastJson) {
        lastJson = json;
        onUpdate(state);
      }
    } catch {
      // No active session / SMTC not available right now — treated the
      // same as "nothing playing" rather than crashing the poll loop.
    } finally {
      busy = false;
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

module.exports = {
  pollNowPlaying,
  sendMediaCommand,
  startMediaPolling,
  pollVolume,
  setMediaVolume,
  stopVolumeProcess,
  stopMediaProcess,
};
