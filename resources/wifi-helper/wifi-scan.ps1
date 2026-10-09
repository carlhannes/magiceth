# magiceth Wi-Fi helper for Windows.
#
# The Windows twin of the macOS helper (main.swift next to this file). It exists because Windows has
# no command that lists access points with their beacon elements: `netsh wlan show networks` gives a
# percentage for signal, no BSS Load, no information elements, and no way to ask for a fresh sweep.
# The native WLAN API has all of it, so this script calls it through P/Invoke and prints one JSON
# object — the same envelope the Swift helper prints — and decodes nothing. Every parser lives in
# TypeScript, where it is tested against real captures.
#
# Since Windows 11 24H2 these calls return ERROR_ACCESS_DENIED (5) unless the user allows precise
# location for desktop apps. A one-time consent prompt exists, but Windows only raises it for a
# process outside C:\Windows\System32, and powershell.exe lives inside it — so this script can only
# report needs-permission and leave it to the app to open the Location settings page.
#
# Exit codes: 0 ok, 2 needs-permission, 3 no-interface, 4 error.

param([string]$Interface = '')

$ErrorActionPreference = 'Stop'
# Windows PowerShell writes the console code page by default, which would mangle an SSID with
# anything outside ASCII before Node ever saw it. Without a byte-order mark: JSON.parse rejects one.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

function Emit([hashtable]$Object, [int]$Code) {
  # -InputObject rather than the pipeline, so a one-element networks array stays an array.
  Write-Output (ConvertTo-Json -InputObject $Object -Compress -Depth 5)
  exit $Code
}

function Bail([string]$Status, [string]$Message, [int]$Code) {
  Emit @{ status = $Status; message = $Message; networks = @() } $Code
}

if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
  Bail 'error' 'PowerShell is in constrained language mode, which blocks the WLAN API calls this scan needs.' 4
}

$source = @'
using System;
using System.Runtime.InteropServices;

public static class Wlan {
  [DllImport("wlanapi.dll")]
  public static extern int WlanOpenHandle(uint clientVersion, IntPtr reserved, out uint negotiated, out IntPtr handle);
  [DllImport("wlanapi.dll")]
  public static extern int WlanCloseHandle(IntPtr handle, IntPtr reserved);
  [DllImport("wlanapi.dll")]
  public static extern int WlanEnumInterfaces(IntPtr handle, IntPtr reserved, out IntPtr list);
  [DllImport("wlanapi.dll")]
  public static extern int WlanScan(IntPtr handle, ref Guid guid, IntPtr ssid, IntPtr ieData, IntPtr reserved);
  [DllImport("wlanapi.dll")]
  public static extern int WlanGetNetworkBssList(IntPtr handle, ref Guid guid, IntPtr ssid, int bssType, bool securityEnabled, IntPtr reserved, out IntPtr list);
  [DllImport("wlanapi.dll")]
  public static extern void WlanFreeMemory(IntPtr memory);

  // WLAN_INTERFACE_INFO: GUID, a 256-character description, a state.
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct InterfaceInfo {
    public Guid Guid;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string Description;
    public int State;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct Ssid {
    public uint Length;
    [MarshalAs(UnmanagedType.ByValArray, SizeConst = 32)] public byte[] Bytes;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct RateSet {
    public uint Length;
    [MarshalAs(UnmanagedType.ByValArray, SizeConst = 126)] public ushort[] Rates;
  }

  // WLAN_BSS_ENTRY, field for field, so the CLR lays it out exactly as the C compiler did.
  [StructLayout(LayoutKind.Sequential)]
  public struct BssEntry {
    public Ssid Ssid;
    public uint PhyId;
    [MarshalAs(UnmanagedType.ByValArray, SizeConst = 6)] public byte[] Bssid;
    public int BssType;
    public int PhyType;
    public int Rssi;
    public uint LinkQuality;
    public byte InRegDomain;
    public ushort BeaconPeriod;
    public ulong Timestamp;
    public ulong HostTimestamp;
    public ushort CapabilityInformation;
    public uint CenterFrequencyKhz;
    public RateSet Rates;
    public uint IeOffset;
    public uint IeSize;
  }
}
'@

try {
  Add-Type -TypeDefinition $source -ErrorAction Stop
} catch {
  Bail 'error' "The WLAN API bindings could not be compiled: $($_.Exception.Message)" 4
}

$M = [System.Runtime.InteropServices.Marshal]
$ACCESS_DENIED = 5
$handle = [IntPtr]::Zero
$list = [IntPtr]::Zero
$bssList = [IntPtr]::Zero

try {
  $version = [uint32]0
  $rc = [Wlan]::WlanOpenHandle(2, [IntPtr]::Zero, [ref]$version, [ref]$handle)
  if ($rc -ne 0) { Bail 'error' "WlanOpenHandle failed with code $rc (is the WLAN AutoConfig service running?)." 4 }

  $rc = [Wlan]::WlanEnumInterfaces($handle, [IntPtr]::Zero, [ref]$list)
  if ($rc -ne 0) { Bail 'error' "WlanEnumInterfaces failed with code $rc." 4 }
  $count = $M::ReadInt32($list, 0)
  if ($count -lt 1) { Bail 'no-interface' 'This machine has no Wi-Fi interface.' 3 }

  $infoSize = $M::SizeOf([type][Wlan+InterfaceInfo])
  $interfaces = @()
  for ($i = 0; $i -lt $count; $i++) {
    $ptr = [IntPtr]($list.ToInt64() + 8 + $i * $infoSize)
    $interfaces += $M::PtrToStructure($ptr, [type][Wlan+InterfaceInfo])
  }

  # The app names adapters the way Get-NetAdapter does ("Wi-Fi"); the WLAN API knows them by GUID.
  $chosen = $interfaces[0]
  if ($Interface -ne '') {
    $wanted = $null
    try { $wanted = [Guid](Get-NetAdapter -Name $Interface -ErrorAction Stop).InterfaceGuid } catch { $wanted = $null }
    foreach ($info in $interfaces) {
      if (($wanted -ne $null -and $info.Guid -eq $wanted) -or $info.Description -eq $Interface) { $chosen = $info }
    }
  }
  $guid = $chosen.Guid

  # Ask for a sweep and give the driver the four seconds the API contract allows it. A refused
  # request still leaves the cache readable, so only access-denied is fatal here.
  $rc = [Wlan]::WlanScan($handle, [ref]$guid, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero)
  if ($rc -eq $ACCESS_DENIED) { Bail 'needs-permission' '' 2 }
  Start-Sleep -Milliseconds 4000

  # dot11_BSS_type_any = 3
  $rc = [Wlan]::WlanGetNetworkBssList($handle, [ref]$guid, [IntPtr]::Zero, 3, $false, [IntPtr]::Zero, [ref]$bssList)
  if ($rc -eq $ACCESS_DENIED) { Bail 'needs-permission' '' 2 }
  if ($rc -ne 0) { Bail 'error' "WlanGetNetworkBssList failed with code $rc." 4 }

  $totalSize = $M::ReadInt32($bssList, 0)
  $entries = $M::ReadInt32($bssList, 4)
  $entrySize = $M::SizeOf([type][Wlan+BssEntry])
  $networks = @()
  for ($i = 0; $i -lt $entries; $i++) {
    $entryOffset = 8 + $i * $entrySize
    $entryPtr = [IntPtr]($bssList.ToInt64() + $entryOffset)
    $e = $M::PtrToStructure($entryPtr, [type][Wlan+BssEntry])
    $ssid = ''
    if ($e.Ssid.Length -gt 0 -and $e.Ssid.Length -le 32) {
      $ssid = [System.Text.Encoding]::UTF8.GetString($e.Ssid.Bytes, 0, [int]$e.Ssid.Length)
    }
    # The element blob is addressed relative to its own entry and comes off the air, so it is
    # bounds-checked against the buffer before a byte of it is read.
    $ie = ''
    $ieEnd = [int64]$entryOffset + [int64]$e.IeOffset + [int64]$e.IeSize
    if ($e.IeSize -gt 0 -and $ieEnd -le $totalSize) {
      $bytes = New-Object byte[] $e.IeSize
      $M::Copy([IntPtr]($entryPtr.ToInt64() + $e.IeOffset), $bytes, 0, [int]$e.IeSize)
      $ie = ([System.BitConverter]::ToString($bytes)).Replace('-', '').ToLower()
    }
    $networks += @{
      bssid = (($e.Bssid | ForEach-Object { $_.ToString('x2') }) -join ':')
      ssid = $ssid
      rssi = $e.Rssi
      freqMhz = [int][math]::Round($e.CenterFrequencyKhz / 1000)
      phyType = $e.PhyType
      capability = $e.CapabilityInformation
      ie = $ie
    }
  }

  Emit @{
    status = 'ok'
    interface = $chosen.Description
    interfaces = @($interfaces | ForEach-Object { $_.Description })
    networks = $networks
  } 0
} catch {
  Bail 'error' "Scan failed: $($_.Exception.Message)" 4
} finally {
  if ($bssList -ne [IntPtr]::Zero) { [Wlan]::WlanFreeMemory($bssList) }
  if ($list -ne [IntPtr]::Zero) { [Wlan]::WlanFreeMemory($list) }
  if ($handle -ne [IntPtr]::Zero) { [void][Wlan]::WlanCloseHandle($handle, [IntPtr]::Zero) }
}
