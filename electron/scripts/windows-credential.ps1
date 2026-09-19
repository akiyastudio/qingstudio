$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class PhotoFlowCredentialNative {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags;
    public UInt32 Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct NETRESOURCE {
    public UInt32 Scope;
    public UInt32 Type;
    public UInt32 DisplayType;
    public UInt32 Usage;
    public string LocalName;
    public string RemoteName;
    public string Comment;
    public string Provider;
  }

  [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredWrite(ref CREDENTIAL credential, UInt32 flags);
  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);
  [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredDelete(string target, UInt32 type, UInt32 flags);
  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern void CredFree(IntPtr buffer);
  [DllImport("mpr.dll", EntryPoint = "WNetAddConnection2W", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern int WNetAddConnection2(ref NETRESOURCE resource, string password, string username, UInt32 flags);
}
"@

function Read-PhotoFlowCredential([string]$target) {
  $pointer = [IntPtr]::Zero
  if (-not [PhotoFlowCredentialNative]::CredRead($target, 1, 0, [ref]$pointer)) {
    throw "Credential not found or expired ($([Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
  }
  try {
    $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($pointer, [type][PhotoFlowCredentialNative+CREDENTIAL])
    $password = if ($credential.CredentialBlobSize -gt 0) { [Runtime.InteropServices.Marshal]::PtrToStringUni($credential.CredentialBlob, [int]($credential.CredentialBlobSize / 2)) } else { '' }
    return @{ username = $credential.UserName; password = $password }
  } finally {
    [PhotoFlowCredentialNative]::CredFree($pointer)
  }
}

$requestText = [Console]::In.ReadToEnd()
$request = $null
if ($requestText.Length -gt 1048576) { throw 'Credential request is too large' }
$request = $requestText | ConvertFrom-Json
$operation = [string]$request.operation
$target = [string]$request.target
if ($target -notmatch '^PhotoFlow/NAS/[a-f0-9]{24}$') { throw 'Invalid credential reference' }
function Get-PhotoFlowCredentialTarget([string]$remotePath) {
  if ($remotePath -notmatch '^\\\\[^\\]+\\[^\\]+') { throw 'Invalid NAS share path' }
  $share = $Matches[0].TrimEnd('\').ToLowerInvariant()
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $digest = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($share)) }
  finally { $sha.Dispose() }
  $hex = -join ($digest | ForEach-Object { $_.ToString('x2') })
  return "PhotoFlow/NAS/$($hex.Substring(0, 24))"
}

if ($operation -eq 'write') {
  $passwordBytes = [Text.Encoding]::Unicode.GetBytes([string]$request.password)
  $allocationSize = [Math]::Max(1, $passwordBytes.Length)
  $passwordPointer = [Runtime.InteropServices.Marshal]::AllocHGlobal($allocationSize)
  try {
    if ($passwordBytes.Length -gt 0) { [Runtime.InteropServices.Marshal]::Copy($passwordBytes, 0, $passwordPointer, $passwordBytes.Length) }
    $credential = [PhotoFlowCredentialNative+CREDENTIAL]::new()
    $credential.Type = 1
    $credential.TargetName = $target
    $credential.UserName = [string]$request.username
    $credential.CredentialBlob = $passwordPointer
    $credential.CredentialBlobSize = $passwordBytes.Length
    $credential.Persist = 2
    if (-not [PhotoFlowCredentialNative]::CredWrite([ref]$credential, 0)) {
      throw "Credential write failed ($([Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
    }
  } finally {
    for ($index = 0; $index -lt $allocationSize; $index++) { [Runtime.InteropServices.Marshal]::WriteByte($passwordPointer, $index, 0) }
    [Runtime.InteropServices.Marshal]::FreeHGlobal($passwordPointer)
  }
  @{ success = $true; username = [string]$request.username } | ConvertTo-Json -Compress
  exit 0
}

if ($operation -eq 'inspect') {
  $credential = Read-PhotoFlowCredential $target
  @{ success = $true; username = $credential.username } | ConvertTo-Json -Compress
  exit 0
}

if ($operation -eq 'delete') {
  $deleted = [PhotoFlowCredentialNative]::CredDelete($target, 1, 0)
  $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  if (-not $deleted -and $errorCode -ne 1168) { throw "Credential delete failed ($errorCode)" }
  @{ success = $true } | ConvertTo-Json -Compress
  exit 0
}

if ($operation -eq 'connect') {
  if ((Get-PhotoFlowCredentialTarget ([string]$request.remotePath)) -ne $target) { throw 'Credential reference does not match NAS share path' }
  $credential = Read-PhotoFlowCredential $target
  try {
    $resource = [PhotoFlowCredentialNative+NETRESOURCE]::new()
    $resource.Type = 1
    $resource.RemoteName = [string]$request.remotePath
    $result = [PhotoFlowCredentialNative]::WNetAddConnection2([ref]$resource, $credential.password, $credential.username, 0)
    if ($result -ne 0 -and $result -ne 85) { throw "NAS connection failed (Windows error $result)" }
    @{ success = $true; username = $credential.username } | ConvertTo-Json -Compress
  } finally {
    $credential.password = $null
  }
  exit 0
}

throw 'Unsupported credential operation'
