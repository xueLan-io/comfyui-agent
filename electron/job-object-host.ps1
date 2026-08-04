param(
  [Parameter(Mandatory = $true)][int]$ChildPid,
  [Parameter(Mandatory = $true)][int]$ParentPid
)

$source = @'
using System;
using System.Runtime.InteropServices;

public static class AgentJob {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr handle);

  [StructLayout(LayoutKind.Sequential)]
  public struct BasicLimitInformation {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct IoCounters {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct ExtendedLimitInformation {
    public BasicLimitInformation BasicLimitInformation;
    public IoCounters IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }
}
'@

Add-Type -TypeDefinition $source
$job = [AgentJob]::CreateJobObject([IntPtr]::Zero, $null)
if ($job -eq [IntPtr]::Zero) { throw "CreateJobObject failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }

$limits = New-Object AgentJob+ExtendedLimitInformation
$limits.BasicLimitInformation.LimitFlags = 0x2000 -bor 0x8 -bor 0x400
$limits.BasicLimitInformation.ActiveProcessLimit = 8
$size = [Runtime.InteropServices.Marshal]::SizeOf($limits)
$memory = [Runtime.InteropServices.Marshal]::AllocHGlobal($size)
try {
  [Runtime.InteropServices.Marshal]::StructureToPtr($limits, $memory, $false)
  if (-not [AgentJob]::SetInformationJobObject($job, 9, $memory, [uint32]$size)) {
    throw "SetInformationJobObject failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }
  $child = [AgentJob]::OpenProcess(0x100101, $false, $ChildPid)
  if ($child -eq [IntPtr]::Zero) { throw "OpenProcess child failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
  try {
    if (-not [AgentJob]::AssignProcessToJobObject($job, $child)) {
      throw "AssignProcessToJobObject failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
  } finally {
    [AgentJob]::CloseHandle($child) | Out-Null
  }
  $parent = [AgentJob]::OpenProcess(0x100000, $false, $ParentPid)
  if ($parent -eq [IntPtr]::Zero) { throw "OpenProcess parent failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
  Write-Output 'READY'
  [Console]::Out.Flush()
  try { [AgentJob]::WaitForSingleObject($parent, 0xffffffff) | Out-Null }
  finally { [AgentJob]::CloseHandle($parent) | Out-Null }
} finally {
  [Runtime.InteropServices.Marshal]::FreeHGlobal($memory)
  [AgentJob]::CloseHandle($job) | Out-Null
}
