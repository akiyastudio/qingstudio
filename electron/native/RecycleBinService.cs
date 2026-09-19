using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

internal static class RecycleBinService
{
    private sealed class RecoveryFailureException : IOException
    {
        internal readonly string CodeValue; internal readonly string RecoveryPathValue; internal readonly string PhaseValue; internal readonly bool OriginalMissingValue; internal readonly bool PublishedValue; internal readonly bool OutcomeUnknownValue;
        internal RecoveryFailureException(string message, string code, string recoveryPath, bool originalMissing, bool published, bool outcomeUnknown, Exception inner, string phase = null) : base(message, inner) { CodeValue = code; RecoveryPathValue = recoveryPath; PhaseValue = phase; OriginalMissingValue = originalMissing; PublishedValue = published; OutcomeUnknownValue = outcomeUnknown; }
    }
    private const uint FOF_SILENT = 0x0004;
    private const uint FOF_NOCONFIRMATION = 0x0010;
    private const uint FOF_ALLOWUNDO = 0x0040;
    private const uint FOF_NOERRORUI = 0x0400;
    private const uint FOF_WANTNUKEWARNING = 0x4000;
    private const uint FOFX_RECYCLEONDELETE = 0x00080000;
    private const uint FOFX_ADDUNDORECORD = 0x20000000;
    private const uint SIGDN_NORMALDISPLAY = 0;
    private const uint SICHINT_CANONICAL = 0x10000000;
    private const uint MOVEFILE_WRITE_THROUGH = 0x00000008;
    private const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
    private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
    private const uint INVALID_FILE_ATTRIBUTES = 0xffffffff;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint FILE_SHARE_DELETE = 0x00000004;
    private const uint OPEN_EXISTING = 3;
    private const uint GENERIC_READ = 0x80000000;
    private const uint FILE_LIST_DIRECTORY = 0x00000001;
    private const uint FILE_READ_ATTRIBUTES = 0x00000080;
    private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    private const uint DRIVE_REMOVABLE = 2;
    private const uint DRIVE_FIXED = 3;
    private static readonly Encoding StrictUnicode = new UnicodeEncoding(false, false, true);
    private static readonly PROPERTYKEY RecycleDeletedFromKey = new PROPERTYKEY(new Guid("9B174B33-40FF-11D2-A27E-00C04FC30871"), 2);

    private sealed class RecycleEvidence
    {
        internal string OriginalPath;
        internal FileIdentity Identity;
    }

    private sealed class ResolvedReparseEvidence
    {
        internal string Path;
        internal FileIdentity Identity;
    }

    private struct FileIdentity
    {
        internal uint VolumeSerial;
        internal ulong FileIndex;
        internal ulong Size;
        internal ulong LastWriteTime;
        internal bool Directory;
        internal bool ReparsePoint;
    }

    [STAThread]
    private static int Main(string[] args)
    {
        AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling", false);
        AppContext.SetSwitch("Switch.System.IO.BlockLongPaths", false);
        // Node writes batch JSON as UTF-8.  On Chinese Windows a redirected
        // console otherwise defaults to the legacy system code page, which can
        // consume one byte of a JSON path escape and produce an "unrecognized
        // escape sequence" error for Chinese file names.
        Console.InputEncoding = Encoding.UTF8;
        Console.OutputEncoding = Encoding.UTF8;
        if (args.Length == 1 && args[0] == "serve") return Serve();
        try
        {
            if (args.Length < 1) throw new ArgumentException("缺少操作名称");
            var options = ParseOptions(args);
            object result;
            if (args[0] == "trash") result = Trash(Required(options, "path"));
            else if (args[0] == "trash-many") result = TrashMany(ReadPaths());
            else if (args[0] == "restore") { var target = Required(options, "target"); result = Restore(Required(options, "pidl"), Optional(options, "original") ?? target, target, Optional(options, "staging")); }
            else if (args[0] == "probe") result = Probe(Required(options, "pidl"));
            else if (args[0] == "probe-many") result = ProbeMany(ReadValues(5000));
            else if (args[0] == "check") result = Check(Required(options, "directory"));
#if RECYCLE_VALIDATION_TESTS
            else if (args[0] == "validate-recycle-fixture") result = ValidateRecycleFixture(Required(options, "payload"), Required(options, "metadata"), Required(options, "target"), Required(options, "parent"));
            else if (args[0] == "validate-recycle-location") result = ValidateRecycleLocation(Required(options, "path"));
            else if (args[0] == "validate-publish-path") result = ValidatePublishPath(Required(options, "path"));
            else if (args[0] == "hold-publish-lock") result = HoldPublishLock(Required(options, "target"), Required(options, "ready"), Required(options, "release"));
            else if (args[0] == "stress-publish-lock") result = StressPublishLock(Required(options, "target"), Required(options, "iterations"));
            else if (args[0] == "validate-resolved-final-path") result = ValidateResolvedFinalPath(Required(options, "path"));
#endif
            else throw new ArgumentException("不支持的操作：" + args[0]);
            WriteJson(result);
            return 0;
        }
        catch (Exception error)
        {
            var failure = new Dictionary<string, object> {
                { "success", false },
                { "error", error.Message },
                { "hresult", error.HResult }
            };
            var recovery = error as RecoveryFailureException;
            if (recovery != null) { var recoveryExists = File.Exists(recovery.RecoveryPathValue) || Directory.Exists(recovery.RecoveryPathValue); failure["code"] = recovery.CodeValue; if (!String.IsNullOrEmpty(recovery.PhaseValue)) failure["phase"] = recovery.PhaseValue; if (recovery.InnerException != null) { failure["causeHresult"] = recovery.InnerException.HResult; failure["causeType"] = recovery.InnerException.GetType().FullName; } if (recoveryExists) failure["recoveryPath"] = recovery.RecoveryPathValue; else failure["attemptedStagingPath"] = recovery.RecoveryPathValue; failure["recoveryAvailable"] = recoveryExists; failure["staged"] = recoveryExists; failure["originalMissing"] = recovery.OriginalMissingValue; failure["published"] = recovery.PublishedValue; failure["publishedConfirmed"] = true; failure["publicationState"] = recovery.PublishedValue ? "published" : "not-published"; failure["outcomeUnknown"] = recovery.OutcomeUnknownValue; }
            WriteJson(failure);
            return 1;
        }
    }

    private static int Serve()
    {
        var serializer = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024 };
        WriteJson(new { ready = true, protocol = "photoflow-recycle-v1" });
        string line;
        while ((line = Console.ReadLine()) != null) {
            string id = ""; object result;
            try {
                if (line.Length > 1024 * 1024) throw new ArgumentException("请求过大");
                var request = serializer.Deserialize<Dictionary<string, string>>(line);
                id = Required(request, "id");
                if (id.Length > 64) throw new ArgumentException("请求序号无效");
                var operation = Required(request, "operation");
                if (operation == "trash") result = Trash(Required(request, "path"));
                else if (operation == "probe") result = Probe(Required(request, "pidl"));
                else {
                    var values = serializer.Deserialize<string[]>(Required(request, "values"));
                    if (values == null || values.Length > (operation == "trash-many" ? 500 : 5000) || values.Any(value => String.IsNullOrWhiteSpace(value))) throw new ArgumentException("批量项目无效");
                    if (operation == "trash-many") result = TrashMany(values);
                    else if (operation == "probe-many") result = ProbeMany(values);
                    else throw new ArgumentException("不支持的常驻操作");
                }
            } catch (Exception error) { result = new { success = false, error = error.Message, hresult = error.HResult, code = "RECYCLE_BIN_FAILED" }; }
            WriteJson(new { id = id, result = result });
        }
        return 0;
    }
    private static object Check(string requestedDirectory)
    {
        var directory = Path.GetFullPath(requestedDirectory);
        if (!Directory.Exists(directory)) throw new DirectoryNotFoundException("检测目录不存在");
        var canary = Path.Combine(directory, ".photoflow-recycle-check-" + Guid.NewGuid().ToString("N") + ".tmp");
        File.WriteAllText(canary, "Photoflow recycle capability check");
        try
        {
            Dictionary<string, object> recycled;
            try { recycled = (Dictionary<string, object>)Trash(canary); }
            catch (Exception error)
            {
                return new Dictionary<string, object> { { "success", true }, { "supported", false }, { "reason", error.Message } };
            }
            var pidl = Convert.ToString(recycled["recyclePidl"]);
            try {
                var restored = Restore(pidl, canary, canary) as Dictionary<string, object>;
                if (restored == null || !restored.ContainsKey("success") || !Convert.ToBoolean(restored["success"])) { var restoreError = restored != null && restored.ContainsKey("error") ? restored["error"] : "回收站项目无法还原"; return new Dictionary<string, object> { { "success", true }, { "supported", false }, { "code", restored != null && restored.ContainsKey("code") ? restored["code"] : "RECYCLE_RESTORE_FAILED" }, { "error", restoreError }, { "reason", restoreError } }; }
            }
            catch (Exception error)
            {
                var recovery = error as RecoveryFailureException;
                return new Dictionary<string, object> { { "success", true }, { "supported", false }, { "code", recovery == null ? "RECYCLE_RESTORE_FAILED" : recovery.CodeValue }, { "error", error.Message }, { "reason", "回收站项目无法还原：" + error.Message } };
            }
            return new Dictionary<string, object> { { "success", true }, { "supported", true } };
        }
        finally
        {
            if (File.Exists(canary)) File.Delete(canary);
        }
    }

    private static object Trash(string requestedPath)
    {
        var sourcePath = Path.GetFullPath(requestedPath);
        if (!File.Exists(sourcePath) && !Directory.Exists(sourcePath)) throw new FileNotFoundException("文件或文件夹不存在", sourcePath);

        IShellItem source;
        ThrowIfFailed(SHCreateItemFromParsingName(sourcePath, IntPtr.Zero, typeof(IShellItem).GUID, out source));
        var operation = (IFileOperation)new FileOperation();
        var sink = new ProgressSink();
        try
        {
            // Skip the routine second confirmation after PhotoFlow's own dialog,
            // but let Windows show its standard warning when recycling is not
            // possible and the item would be deleted permanently.
            ThrowIfFailed(operation.SetOperationFlags(FOF_NOCONFIRMATION | FOF_ALLOWUNDO | FOF_WANTNUKEWARNING | FOFX_RECYCLEONDELETE | FOFX_ADDUNDORECORD));
            ThrowIfFailed(operation.DeleteItem(source, sink));
            ThrowIfFailed(operation.PerformOperations());
            bool aborted;
            ThrowIfFailed(operation.GetAnyOperationsAborted(out aborted));
            if (aborted) throw new OperationCanceledException("系统取消了删除操作");
            if (sink.DeleteResult < 0) Marshal.ThrowExceptionForHR(sink.DeleteResult);
            var permanent = sink.RecycledPidl == null || sink.RecycledPidl.Length == 0;
            if (permanent && (File.Exists(sourcePath) || Directory.Exists(sourcePath)))
                throw new InvalidOperationException("Windows 未能删除该文件或文件夹");
            return new Dictionary<string, object> {
                { "success", true },
                { "originalPath", sourcePath },
                { "recyclePidl", permanent ? "" : Convert.ToBase64String(sink.RecycledPidl) },
                { "preciseRestore", !permanent },
                { "permanent", permanent }
            };
        }
        finally
        {
            Release(source);
            Release(operation);
        }
    }

    private static string[] ReadPaths()
    {
        var paths = ReadValues(500);
        if (paths == null || paths.Length == 0) throw new ArgumentException("没有要删除的文件或文件夹");
        return paths;
    }

    private static string[] ReadValues(int maximum)
    {
        var input = Console.In.ReadToEnd();
        var values = new JavaScriptSerializer().Deserialize<string[]>(input);
        if (values == null || values.Length == 0) throw new ArgumentException("没有输入项目");
        if (values.Length > maximum) throw new ArgumentException("输入项目数量过多");
        return values;
    }

    private static object TrashMany(string[] requestedPaths)
    {
        var sourcePaths = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var requestedPath in requestedPaths)
        {
            var sourcePath = Path.GetFullPath(requestedPath);
            if (!File.Exists(sourcePath) && !Directory.Exists(sourcePath)) throw new FileNotFoundException("文件或文件夹不存在", sourcePath);
            if (seen.Add(sourcePath)) sourcePaths.Add(sourcePath);
        }

        var operation = (IFileOperation)new FileOperation();
        var sources = new List<IShellItem>();
        var sinks = new List<ProgressSink>();
        try
        {
            ThrowIfFailed(operation.SetOperationFlags(FOF_NOCONFIRMATION | FOF_ALLOWUNDO | FOF_WANTNUKEWARNING | FOFX_RECYCLEONDELETE | FOFX_ADDUNDORECORD));
            foreach (var sourcePath in sourcePaths)
            {
                IShellItem source;
                ThrowIfFailed(SHCreateItemFromParsingName(sourcePath, IntPtr.Zero, typeof(IShellItem).GUID, out source));
                var sink = new ProgressSink();
                sources.Add(source);
                sinks.Add(sink);
                ThrowIfFailed(operation.DeleteItem(source, sink));
            }

            var operationResult = operation.PerformOperations();
            bool aborted = false;
            if (operationResult >= 0) ThrowIfFailed(operation.GetAnyOperationsAborted(out aborted));
            var items = new List<Dictionary<string, object>>();
            for (var index = 0; index < sourcePaths.Count; index++)
            {
                var sourcePath = sourcePaths[index];
                var sink = sinks[index];
                var itemResult = sink.DeleteCompleted ? sink.DeleteResult : operationResult;
                if (!sink.DeleteCompleted || itemResult < 0)
                {
                    items.Add(new Dictionary<string, object> {
                        { "success", false },
                        { "originalPath", sourcePath },
                        { "error", itemResult < 0 ? ErrorMessage(itemResult) : aborted ? "系统取消了删除操作" : "Windows 未能删除该文件或文件夹" },
                        { "hresult", itemResult }
                    });
                    continue;
                }
                var permanent = sink.RecycledPidl == null || sink.RecycledPidl.Length == 0;
                var stillExists = File.Exists(sourcePath) || Directory.Exists(sourcePath);
                if (permanent && stillExists)
                {
                    items.Add(new Dictionary<string, object> {
                        { "success", false },
                        { "originalPath", sourcePath },
                        { "error", "Windows 未能删除该文件或文件夹" }
                    });
                    continue;
                }
                items.Add(new Dictionary<string, object> {
                    { "success", true },
                    { "originalPath", sourcePath },
                    { "recyclePidl", permanent ? "" : Convert.ToBase64String(sink.RecycledPidl) },
                    { "preciseRestore", !permanent },
                    { "permanent", permanent }
                });
            }
            return new Dictionary<string, object> {
                { "success", true },
                { "aborted", aborted },
                { "items", items }
            };
        }
        finally
        {
            foreach (var source in sources) Release(source);
            Release(operation);
        }
    }

    private static string ErrorMessage(int result)
    {
        try { Marshal.ThrowExceptionForHR(result); }
        catch (Exception error) { return error.Message; }
        return "Windows 回收站操作失败";
    }

    private static object Restore(string encodedPidl, string requestedOriginalPath, string requestedTarget, string requestedStaging = null)
    {
        RejectRawDeviceOrAds(requestedOriginalPath);
        RejectRawDeviceOrAds(requestedTarget);
        var originalPath = NormalizeAbsolutePath(requestedOriginalPath);
        var targetPath = Path.GetFullPath(requestedTarget);
        RequireSafePublishPath(targetPath);
        var temporaryPath = ApprovedStaging(targetPath, requestedStaging);
        if (File.Exists(targetPath) || Directory.Exists(targetPath))
            return new Dictionary<string, object> { { "success", false }, { "code", "DESTINATION_EXISTS" }, { "error", "原位置已有同名文件或文件夹" }, { "phase", "preflight" }, { "attemptedStagingPath", temporaryPath }, { "recoveryAvailable", false }, { "staged", false }, { "originalMissing", false }, { "published", false }, { "publishedConfirmed", true }, { "publicationState", "not-published" }, { "outcomeUnknown", false } };
        var parentPath = Path.GetDirectoryName(targetPath);
        if (String.IsNullOrEmpty(parentPath)) throw new InvalidOperationException("无法确定恢复目录");
        List<SafeFileHandle> publishLocks = null;

        IntPtr pidl = IntPtr.Zero;
        IShellItem recycled = null;
        IShellItem destination = null;
        IShellItem restoredItem = null;
        var phase = "resolve-recycle-item";
        try
        {
            phase = "lock-publish-ancestors";
            publishLocks = LockPublishAncestors(parentPath);
            if (File.Exists(targetPath) || Directory.Exists(targetPath))
                return new Dictionary<string, object> { { "success", false }, { "code", "DESTINATION_EXISTS" }, { "error", "原位置已有同名文件或文件夹" }, { "phase", "locked-preflight" }, { "attemptedStagingPath", temporaryPath }, { "recoveryAvailable", false }, { "staged", false }, { "originalMissing", false }, { "published", false }, { "publishedConfirmed", true }, { "publicationState", "not-published" }, { "outcomeUnknown", false } };
            phase = "resolve-recycle-item";
            pidl = DecodePidl(encodedPidl);
            phase = "create-recycle-item";
            ThrowIfFailed(SHCreateItemFromIDList(pidl, typeof(IShellItem).GUID, out recycled));
            phase = "verify-recycle-item";
            var evidence = EnsureRecycleItem(recycled, originalPath);
            phase = "create-destination-item";
            ThrowIfFailed(SHCreateItemFromParsingName(parentPath, IntPtr.Zero, typeof(IShellItem).GUID, out destination));
            phase = "create-file-operation";
            var operation = (IFileOperation)new FileOperation();
            var sink = new ProgressSink();
            try
            {
                phase = "reverify-recycle-item";
                var currentEvidence = EnsureRecycleItem(recycled, originalPath);
                if (!SameIdentity(evidence.Identity, currentEvidence.Identity)) throw new IOException("回收站项目身份在还原前发生变化");
                phase = "move-to-staging";
                ThrowIfFailed(operation.SetOperationFlags(FOF_SILENT | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOFX_ADDUNDORECORD));
                ThrowIfFailed(operation.MoveItem(recycled, destination, Path.GetFileName(temporaryPath), sink));
                ThrowIfFailed(operation.PerformOperations());
                bool aborted;
                ThrowIfFailed(operation.GetAnyOperationsAborted(out aborted));
                if (aborted) throw new OperationCanceledException("系统取消了还原操作");
                if (!sink.MoveCompleted) throw new IOException("Windows 未报告还原项目结果");
                if (sink.MoveResult < 0) Marshal.ThrowExceptionForHR(sink.MoveResult);
                if (sink.MovedItem == null) throw new IOException("Windows 未返回已恢复对象身份");
                phase = "verify-staging";
                ThrowIfFailed(SHCreateItemFromParsingName(temporaryPath, IntPtr.Zero, typeof(IShellItem).GUID, out restoredItem));
                int order;
                ThrowIfFailed(sink.MovedItem.Compare(restoredItem, SICHINT_CANONICAL, out order));
                if (order != 0) throw new IOException("恢复对象身份与目标临时路径不匹配");
                var stagedIdentity = CaptureIdentity(temporaryPath, true);
                if (!SameIdentity(evidence.Identity, stagedIdentity)) throw new IOException("已恢复对象与验证过的回收站项目身份不匹配");
            }
            catch (Exception error)
            {
                if (File.Exists(temporaryPath) || Directory.Exists(temporaryPath))
                    throw new RecoveryFailureException(error.Message, "RECYCLE_RESTORE_VERIFY_FAILED", temporaryPath, true, false, false, error, phase);
                throw;
            }
            finally { sink.ReleaseMovedItem(); Release(operation); }

            try
            {
                phase = "commit-target";
                if (!MoveFileEx(temporaryPath, targetPath, MOVEFILE_WRITE_THROUGH))
                {
                    var nativeError = Marshal.GetLastWin32Error();
                    return new Dictionary<string, object> {
                        { "success", false }, { "code", File.Exists(targetPath) || Directory.Exists(targetPath) ? "DESTINATION_EXISTS" : "RECYCLE_RESTORE_COMMIT_FAILED" },
                        { "error", "恢复对象已安全保留在临时路径，无法无覆盖提交到原位置" }, { "nativeError", nativeError }, { "phase", "commit-target" },
                        { "recoveryPath", temporaryPath }, { "recoveryAvailable", true }, { "staged", true }, { "originalMissing", !File.Exists(targetPath) && !Directory.Exists(targetPath) }, { "published", false }, { "publishedConfirmed", true }, { "publicationState", "not-published" }, { "outcomeUnknown", false }, { "identityVerified", true }
                    };
                }
            }
            catch (Exception error) { throw new RecoveryFailureException(error.Message, "RECYCLE_RESTORE_COMMIT_FAILED", temporaryPath, !File.Exists(targetPath) && !Directory.Exists(targetPath), false, false, error, phase); }
        }
        catch (RecoveryFailureException) { throw; }
        catch (Exception error)
        {
            throw new RecoveryFailureException(error.Message, "RECYCLE_RESTORE_FAILED", temporaryPath, !File.Exists(targetPath) && !Directory.Exists(targetPath), false, true, error, phase);
        }
        finally
        {
            if (pidl != IntPtr.Zero) Marshal.FreeCoTaskMem(pidl);
            Release(recycled);
            Release(destination);
            Release(restoredItem);
            ReleaseHandles(publishLocks);
        }
        if (!File.Exists(targetPath) && !Directory.Exists(targetPath)) throw new IOException("Windows 未能把项目恢复到原位置");
        return new Dictionary<string, object> { { "success", true }, { "restoredPath", targetPath }, { "identityVerified", true } };
    }

    private static object Probe(string encodedPidl)
    {
        IntPtr pidl;
        try { pidl = DecodePidl(encodedPidl); }
        catch (FormatException error) { return new Dictionary<string, object> { { "success", true }, { "exists", false }, { "invalidPidl", true }, { "error", error.Message } }; }
        catch (ArgumentException error) { return new Dictionary<string, object> { { "success", true }, { "exists", false }, { "invalidPidl", true }, { "error", error.Message } }; }
        IShellItem item = null;
        try
        {
            var hr = SHCreateItemFromIDList(pidl, typeof(IShellItem).GUID, out item);
            if (hr < 0 || item == null) return IsNotFound(hr)
                ? new Dictionary<string, object> { { "success", true }, { "exists", false } }
                : ProbeFailure(hr, "Windows 无法探测回收站项目");
            try { EnsureRecycleItem(item, null); }
            catch (ArgumentException error) { return new Dictionary<string, object> { { "success", true }, { "exists", false }, { "invalidPidl", true }, { "error", error.Message } }; }
            catch (IOException error) { return new Dictionary<string, object> { { "success", true }, { "exists", false }, { "invalidPidl", true }, { "error", error.Message } }; }
            IntPtr displayName;
            hr = item.GetDisplayName(SIGDN_NORMALDISPLAY, out displayName);
            if (hr < 0) { if (displayName != IntPtr.Zero) Marshal.FreeCoTaskMem(displayName); return IsNotFound(hr) ? new Dictionary<string, object> { { "success", true }, { "exists", false } } : ProbeFailure(hr, "Windows 无法读取回收站项目"); }
            var name = hr >= 0 && displayName != IntPtr.Zero ? Marshal.PtrToStringUni(displayName) : "";
            if (displayName != IntPtr.Zero) Marshal.FreeCoTaskMem(displayName);
            return new Dictionary<string, object> { { "success", true }, { "exists", true }, { "name", name ?? "" } };
        }
        catch (COMException error)
        {
            return IsNotFound(error.HResult) ? new Dictionary<string, object> { { "success", true }, { "exists", false } } : ProbeFailure(error.HResult, error.Message);
        }
        finally
        {
            Marshal.FreeCoTaskMem(pidl);
            Release(item);
        }
    }

    private static object ProbeMany(string[] encodedPidls)
    {
        var items = new List<Dictionary<string, object>>();
        foreach (var encodedPidl in encodedPidls)
        {
            try
            {
                var result = (Dictionary<string, object>)Probe(encodedPidl);
                result["pidl"] = encodedPidl;
                items.Add(result);
            }
            catch (Exception error)
            {
                items.Add(new Dictionary<string, object> {
                    { "success", false }, { "exists", false }, { "pidl", encodedPidl },
                    { "error", error.Message }, { "hresult", error.HResult }
                });
            }
        }
        return new Dictionary<string, object> { { "success", true }, { "items", items } };
    }

    private static IntPtr DecodePidl(string encoded)
    {
        var bytes = Convert.FromBase64String(encoded);
        if (bytes.Length < 2 || bytes.Length > 1024 * 1024) throw new ArgumentException("无效的回收站项目标识");
        var offset = 0;
        var terminated = false;
        while (offset + 2 <= bytes.Length)
        {
            var itemSize = bytes[offset] | (bytes[offset + 1] << 8);
            if (itemSize == 0) { terminated = offset + 2 == bytes.Length; break; }
            if (itemSize < 2 || itemSize > bytes.Length - offset) throw new ArgumentException("回收站 ITEMIDLIST 边界无效");
            offset += itemSize;
        }
        if (!terminated) throw new ArgumentException("回收站 ITEMIDLIST 未正确终止");
        var pointer = Marshal.AllocCoTaskMem(bytes.Length);
        Marshal.Copy(bytes, 0, pointer, bytes.Length);
        return pointer;
    }

    private static string ApprovedStaging(string targetPath, string requested)
    {
        var targetParent = Path.GetDirectoryName(targetPath); var targetName = Path.GetFileName(targetPath);
        var staging = String.IsNullOrWhiteSpace(requested) ? Path.Combine(targetParent, ".photoflow-restore-" + Guid.NewGuid().ToString("N") + "-" + targetName) : Path.GetFullPath(requested);
        var stagingName = Path.GetFileName(staging); const string prefix = ".photoflow-restore-"; var suffix = "-" + targetName; Guid stagingId;
        var tokenLength = stagingName.Length - prefix.Length - suffix.Length;
        var token = tokenLength > 0 ? stagingName.Substring(prefix.Length, tokenLength) : "";
        if (!String.Equals(Path.GetDirectoryName(staging), targetParent, StringComparison.OrdinalIgnoreCase) || !stagingName.StartsWith(prefix, StringComparison.Ordinal) || !stagingName.EndsWith(suffix, StringComparison.OrdinalIgnoreCase) || !Guid.TryParse(token, out stagingId) || String.Equals(staging, targetPath, StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("恢复暂存路径未获批准");
        if (File.Exists(staging) || Directory.Exists(staging)) throw new IOException("恢复暂存路径已被占用");
        return staging;
    }

    private static Dictionary<string, object> ProbeFailure(int hr, string message) { return new Dictionary<string, object> { { "success", false }, { "exists", false }, { "code", "RECYCLE_PROBE_FAILED" }, { "error", message }, { "hresult", hr }, { "transient", true } }; }
    private static bool IsNotFound(int hr) { return hr == unchecked((int)0x80070002) || hr == unchecked((int)0x80070003) || hr == unchecked((int)0x800401E5); }

    private static RecycleEvidence EnsureRecycleItem(IShellItem item, string requestedTarget)
    {
        IntPtr itemPidl = IntPtr.Zero;
        try
        {
            ThrowIfFailed(SHGetIDListFromObject(item, out itemPidl));
            var pathBuffer = new StringBuilder(32768);
            if (!SHGetPathFromIDListEx(itemPidl, pathBuffer, (uint)pathBuffer.Capacity, 0)) throw new ArgumentException("回收站项目没有可验证的文件系统路径");
            var itemPath = NormalizeAbsolutePath(pathBuffer.ToString());
            var volumeRoot = RequireLocalVolumeRoot(itemPath);
            var identity = WindowsIdentity.GetCurrent();
            if (identity == null || identity.User == null) throw new ArgumentException("无法确定当前 Windows 用户");
            var expectedParent = volumeRoot + "$Recycle.Bin\\" + identity.User.Value;
            var evidence = ValidateRecyclePair(itemPath, expectedParent, requestedTarget, true);
            var shellDeletedFrom = TryGetShellDeletedFrom(item);
            if (!String.IsNullOrEmpty(shellDeletedFrom) && !SamePath(shellDeletedFrom, ParentPath(evidence.OriginalPath))) throw new ArgumentException("Windows 回收站来源目录与元数据记录不一致");
            return evidence;
        }
        finally { if (itemPidl != IntPtr.Zero) Marshal.FreeCoTaskMem(itemPidl); }
    }

#if RECYCLE_VALIDATION_TESTS
    private static object ValidateRecycleFixture(string payloadPath, string metadataPath, string requestedTarget, string expectedParent)
    {
        try
        {
            var expectedMetadata = MetadataPathForPayload(payloadPath, expectedParent);
            if (!SamePath(expectedMetadata, metadataPath)) throw new ArgumentException("$I 元数据路径与 $R 项目不配对");
            var evidence = ValidateRecyclePair(payloadPath, expectedParent, requestedTarget, false);
            return new Dictionary<string, object> { { "success", true }, { "valid", true }, { "originalPath", evidence.OriginalPath }, { "directory", evidence.Identity.Directory }, { "reparsePayload", evidence.Identity.ReparsePoint } };
        }
        catch (Exception error)
        {
            return new Dictionary<string, object> { { "success", true }, { "valid", false }, { "error", error.Message }, { "errorType", error.GetType().FullName } };
        }
    }

    private static object ValidateRecycleLocation(string path)
    {
        try { return new Dictionary<string, object> { { "success", true }, { "valid", true }, { "root", RequireLocalVolumeRoot(path) } }; }
        catch (Exception error) { return new Dictionary<string, object> { { "success", true }, { "valid", false }, { "error", error.Message }, { "errorType", error.GetType().FullName } }; }
    }

    private static object ValidatePublishPath(string path)
    {
        try { return new Dictionary<string, object> { { "success", true }, { "valid", true }, { "root", RequireSafePublishPath(path) } }; }
        catch (Exception error) { return new Dictionary<string, object> { { "success", true }, { "valid", false }, { "error", error.Message }, { "errorType", error.GetType().FullName } }; }
    }

    private static object HoldPublishLock(string target, string readyPath, string releasePath)
    {
        List<SafeFileHandle> locks = null;
        var parent = ParentPath(target);
        try
        {
            locks = LockPublishAncestors(parent);
            File.WriteAllText(readyPath, "locked");
            var deadline = DateTime.UtcNow.AddSeconds(15);
            while (!File.Exists(releasePath) && DateTime.UtcNow < deadline) Thread.Sleep(10);
            if (!File.Exists(releasePath)) throw new TimeoutException("发布目录锁测试等待释放超时");
            return new Dictionary<string, object> { { "success", true }, { "locked", true } };
        }
        finally { ReleaseHandles(locks); }
    }

    private static object StressPublishLock(string target, string requestedIterations)
    {
        int iterations;
        if (!Int32.TryParse(requestedIterations, out iterations) || iterations < 1 || iterations > 2000) throw new ArgumentException("锁压力测试次数无效");
        var parent = ParentPath(target);
        for (var index = 0; index < iterations; index++)
        {
            List<SafeFileHandle> locks = null;
            try { locks = LockPublishAncestors(parent); }
            finally { ReleaseHandles(locks); }
        }
        return new Dictionary<string, object> { { "success", true }, { "acquired", iterations } };
    }

    private static object ValidateResolvedFinalPath(string path)
    {
        try { return new Dictionary<string, object> { { "success", true }, { "valid", true }, { "volumeRoot", RequireResolvedLocalVolume(path) } }; }
        catch (Exception error) { return new Dictionary<string, object> { { "success", true }, { "valid", false }, { "error", error.Message }, { "errorType", error.GetType().FullName } }; }
    }
#endif

    private static RecycleEvidence ValidateRecyclePair(string payloadPath, string expectedParent, string requestedTarget, bool enforceVolume)
    {
        var payload = NormalizeAbsolutePath(payloadPath);
        var parent = NormalizeAbsolutePath(expectedParent).TrimEnd('\\') ;
        if (enforceVolume)
        {
            var root = RequireLocalVolumeRoot(payload);
            if (!parent.StartsWith(root + "$Recycle.Bin\\", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("回收站目录不位于本地卷根");
        }
        if (!SamePath(ParentPath(payload), parent)) throw new ArgumentException("$R 项目不是当前用户回收站目录的直属项目");
        RejectReparseDirectory(parent);
        if (enforceVolume) RejectReparseDirectory(ParentPath(parent));
        var metadataPath = MetadataPathForPayload(payload, parent);
        var payloadIdentity = CaptureIdentity(payload, true);
        var metadataIdentity = CaptureIdentity(metadataPath, false);
        if (metadataIdentity.Directory || metadataIdentity.ReparsePoint) throw new ArgumentException("$I 元数据必须是普通文件");
        ulong originalSize;
        var originalPath = ReadRecycleMetadata(metadataPath, out originalSize);
        var metadataIdentityAfterRead = CaptureIdentity(metadataPath, false);
        if (!SameIdentity(metadataIdentity, metadataIdentityAfterRead)) throw new IOException("$I 元数据身份在验证期间发生变化");
        if (!payloadIdentity.Directory && !payloadIdentity.ReparsePoint && payloadIdentity.Size != originalSize) throw new InvalidDataException("$I 元数据记录的文件大小与 $R 项目不一致");
        if (enforceVolume && !NormalizeAbsolutePath(originalPath).StartsWith(RequireLocalVolumeRoot(payload), StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("$I 元数据原路径不属于 $R 项目所在卷");
        if (!String.IsNullOrEmpty(requestedTarget) && !SamePath(originalPath, requestedTarget)) throw new ArgumentException("$I 元数据记录的原路径与请求目标不一致");
        return new RecycleEvidence { OriginalPath = originalPath, Identity = payloadIdentity };
    }

    private static string TryGetShellDeletedFrom(IShellItem item)
    {
        var item2 = item as IShellItem2;
        if (item2 == null) return null;
        IntPtr deletedFromPointer = IntPtr.Zero;
        try
        {
            var deletedFromKey = RecycleDeletedFromKey;
            try { ThrowIfFailed(item2.GetString(ref deletedFromKey, out deletedFromPointer)); }
            catch (COMException) { return null; }
            if (deletedFromPointer == IntPtr.Zero) return null;
            var deletedFrom = deletedFromPointer == IntPtr.Zero ? "" : Marshal.PtrToStringUni(deletedFromPointer);
            if (String.IsNullOrWhiteSpace(deletedFrom)) return null;
            return NormalizeAbsolutePath(deletedFrom);
        }
        catch (COMException) { throw new ArgumentException("Windows 回收站属性读取失败"); }
        finally
        {
            if (deletedFromPointer != IntPtr.Zero) Marshal.FreeCoTaskMem(deletedFromPointer);
        }
    }

    private static string ReadRecycleMetadata(string metadataPath, out ulong originalSize)
    {
        byte[] bytes;
        using (var handle = OpenPath(metadataPath, false, true))
        using (var stream = new FileStream(handle, FileAccess.Read))
        {
            if (stream.Length < 28 || stream.Length > 65536) throw new InvalidDataException("$I 元数据长度无效");
            bytes = new byte[checked((int)stream.Length)];
            var offset = 0;
            while (offset < bytes.Length)
            {
                var read = stream.Read(bytes, offset, bytes.Length - offset);
                if (read == 0) throw new EndOfStreamException("$I 元数据被截断");
                offset += read;
            }
        }
        var version = ReadUInt64(bytes, 0);
        originalSize = ReadUInt64(bytes, 8);
        var deletedAt = ReadUInt64(bytes, 16);
        if (deletedAt == 0) throw new InvalidDataException("$I 元数据删除时间无效");
        string originalPath;
        if (version == 1)
        {
            if (bytes.Length != 544) throw new InvalidDataException("$I v1 元数据长度无效");
            originalPath = DecodeTerminatedPath(bytes, 24, 520, true);
        }
        else if (version == 2)
        {
            var characters = ReadUInt32(bytes, 24);
            if (characters == 0 || characters > 32768 || bytes.Length != 28 + checked((int)characters * 2)) throw new InvalidDataException("$I v2 元数据长度无效");
            originalPath = DecodeTerminatedPath(bytes, 28, checked((int)characters * 2), false);
        }
        else throw new InvalidDataException("不支持的 $I 元数据版本");
        RejectRawDeviceOrAds(originalPath);
        return NormalizeAbsolutePath(originalPath);
    }

    private static string DecodeTerminatedPath(byte[] bytes, int offset, int count, bool requirePadding)
    {
        var value = StrictUnicode.GetString(bytes, offset, count);
        var terminator = value.IndexOf('\0');
        if (terminator >= 0)
        {
            if (requirePadding && value.Substring(terminator).Trim('\0').Length != 0) throw new InvalidDataException("$I 元数据路径填充无效");
            if (!requirePadding && terminator != value.Length - 1) throw new InvalidDataException("$I v2 元数据路径终止位置无效");
            value = value.Substring(0, terminator);
        }
        else throw new InvalidDataException(requirePadding ? "$I v1 元数据路径未终止" : "$I v2 元数据路径未终止");
        if (String.IsNullOrWhiteSpace(value) || value.IndexOf('\0') >= 0) throw new InvalidDataException("$I 元数据原路径无效");
        return value;
    }

    private static ulong ReadUInt64(byte[] bytes, int offset)
    {
        if (offset < 0 || offset + 8 > bytes.Length) throw new EndOfStreamException("$I 元数据被截断");
        return BitConverter.ToUInt64(bytes, offset);
    }

    private static uint ReadUInt32(byte[] bytes, int offset)
    {
        if (offset < 0 || offset + 4 > bytes.Length) throw new EndOfStreamException("$I 元数据被截断");
        return BitConverter.ToUInt32(bytes, offset);
    }

    private static string MetadataPathForPayload(string payloadPath, string expectedParent)
    {
        var payload = NormalizeAbsolutePath(payloadPath);
        var name = FileName(payload);
        if (name.Length <= 2 || !name.StartsWith("$R", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("回收站项目名称不是 $R 项目");
        return NormalizeAbsolutePath(expectedParent).TrimEnd('\\') + "\\$I" + name.Substring(2);
    }

    private static string RequireLocalVolumeRoot(string path)
    {
        var value = NormalizeAbsolutePath(path);
        if (value.Length < 3 || !Char.IsLetter(value[0]) || value[1] != ':' || value[2] != '\\' || value.StartsWith("\\\\", StringComparison.Ordinal)) throw new ArgumentException("回收站项目必须位于本地盘符卷");
        var root = Char.ToUpperInvariant(value[0]) + ":\\";
        var driveType = GetDriveType(root);
        if (driveType != DRIVE_FIXED && driveType != DRIVE_REMOVABLE) throw new ArgumentException("回收站项目不在受支持的本地卷");
        var volumeBuffer = new StringBuilder(32768);
        if (!GetVolumePathName(value, volumeBuffer, (uint)volumeBuffer.Capacity)) throw new IOException("无法验证回收站项目所在卷");
        if (!SamePath(volumeBuffer.ToString(), root)) throw new ArgumentException("回收站项目不位于盘符卷根");
        return root;
    }

    private static string RequireSafePublishPath(string path)
    {
        RejectRawDeviceOrAds(path);
        var value = NormalizeAbsolutePath(path);
        if (value.Length < 3 || !Char.IsLetter(value[0]) || value[1] != ':' || value[2] != '\\' || value.StartsWith("\\\\", StringComparison.Ordinal) || value.IndexOf(':', 2) >= 0) throw new ArgumentException("恢复发布路径必须是无 ADS 的本地盘符绝对路径");
        var root = Char.ToUpperInvariant(value[0]) + ":\\";
        var driveType = GetDriveType(root);
        if (driveType != DRIVE_FIXED && driveType != DRIVE_REMOVABLE) throw new ArgumentException("恢复发布路径不在受支持的本地卷");
        return root;
    }

    private static List<SafeFileHandle> LockPublishAncestors(string parentPath)
    {
        var parent = NormalizeAbsolutePath(parentPath);
        var root = RequireSafePublishPath(parent);
        var locks = new List<SafeFileHandle>();
        var reparseLinks = new List<ResolvedReparseEvidence>();
        try
        {
            var relative = parent.Substring(root.Length);
            var current = root.TrimEnd('\\');
            var paths = new List<string>();
            foreach (var component in relative.Split(new[] { '\\' }, StringSplitOptions.RemoveEmptyEntries))
            {
                if (component == "." || component == ".." || component.IndexOf(':') >= 0) throw new ArgumentException("恢复发布目录组件无效");
                current += "\\" + component;
                if (!Directory.Exists(current) && !CreateDirectory(ToExtendedPath(current), IntPtr.Zero) && !Directory.Exists(current)) throw new IOException("无法创建恢复发布目录");
                paths.Add(current);
            }
            var initialLeaf = CaptureResolvedDirectoryIdentity(parent);
            foreach (var candidate in paths)
            {
                var attributes = GetFileAttributes(ToExtendedPath(candidate));
                if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0) throw new ArgumentException("恢复发布目录祖先必须是目录");
                if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0) continue;
                var observed = CaptureIdentity(candidate, true);
                var handle = CreateFile(ToExtendedPath(candidate), FILE_LIST_DIRECTORY, FILE_SHARE_READ, IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
                if (handle == null || handle.IsInvalid) { if (handle != null) handle.Dispose(); throw new IOException("无法锁定恢复发布重解析目录"); }
                BY_HANDLE_FILE_INFORMATION information;
                if (!GetFileInformationByHandle(handle, out information)) { handle.Dispose(); throw new IOException("无法验证恢复发布重解析目录"); }
                var locked = IdentityFromInformation(information);
                if (!SameIdentity(observed, locked) || !locked.Directory || !locked.ReparsePoint) { handle.Dispose(); throw new IOException("恢复发布重解析目录在加锁期间发生变化"); }
                locks.Add(handle);
                reparseLinks.Add(new ResolvedReparseEvidence { Path = candidate, Identity = locked });
            }
            var leafHandle = CreateFile(ToExtendedPath(parent), FILE_LIST_DIRECTORY, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero);
            if (leafHandle == null || leafHandle.IsInvalid) { if (leafHandle != null) leafHandle.Dispose(); throw new IOException("无法锁定恢复发布目标目录"); }
            BY_HANDLE_FILE_INFORMATION leafInformation;
            if (!GetFileInformationByHandle(leafHandle, out leafInformation)) { leafHandle.Dispose(); throw new IOException("无法验证恢复发布目标目录"); }
            var lockedLeaf = IdentityFromInformation(leafInformation);
            if (!SameDirectoryObjectIdentity(initialLeaf, lockedLeaf) || !lockedLeaf.Directory) { leafHandle.Dispose(); throw new IOException("恢复发布目标目录在加锁期间发生变化"); }
            VerifyResolvedLeafVolume(leafHandle, lockedLeaf);
            locks.Add(leafHandle);
            foreach (var link in reparseLinks)
            {
                var verification = CaptureIdentity(link.Path, true);
                if (!SameIdentity(link.Identity, verification)) throw new IOException("恢复发布重解析目录在父链加锁期间发生变化");
            }
            if (!SameDirectoryObjectIdentity(lockedLeaf, CaptureResolvedDirectoryIdentity(parent))) throw new IOException("恢复发布目标解析在加锁期间发生变化");
            return locks;
        }
        catch { ReleaseHandles(locks); throw; }
    }

    private static FileIdentity CaptureResolvedDirectoryIdentity(string path)
    {
        using (var handle = CreateFile(ToExtendedPath(path), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero))
        {
            if (handle == null || handle.IsInvalid) throw new IOException("无法打开恢复发布目标目录");
            BY_HANDLE_FILE_INFORMATION information;
            if (!GetFileInformationByHandle(handle, out information)) throw new IOException("无法读取恢复发布目标目录身份");
            var identity = IdentityFromInformation(information);
            if (!identity.Directory) throw new ArgumentException("恢复发布目标父路径必须是目录");
            return identity;
        }
    }

    private static void VerifyResolvedLeafVolume(SafeFileHandle leafHandle, FileIdentity leafIdentity)
    {
        var buffer = new StringBuilder(32768);
        var length = GetFinalPathNameByHandle(leafHandle, buffer, (uint)buffer.Capacity, 0);
        if (length == 0 || length >= buffer.Capacity) throw new IOException("无法解析恢复发布目标最终路径");
        var volumeRoot = RequireResolvedLocalVolume(buffer.ToString());
        using (var volumeHandle = CreateFile(ToExtendedPath(volumeRoot), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero))
        {
            if (volumeHandle == null || volumeHandle.IsInvalid) throw new IOException("无法打开恢复发布目标本地卷");
            BY_HANDLE_FILE_INFORMATION volumeInformation;
            if (!GetFileInformationByHandle(volumeHandle, out volumeInformation) || volumeInformation.VolumeSerialNumber != leafIdentity.VolumeSerial) throw new IOException("恢复发布目标最终卷身份不一致");
        }
    }

    private static string RequireResolvedLocalVolume(string finalPath)
    {
        if (String.IsNullOrWhiteSpace(finalPath)) throw new ArgumentException("最终路径为空");
        var value = finalPath.Replace('/', '\\');
        if (value.StartsWith("\\\\?\\UNC\\", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("恢复发布目标不能解析到远程 UNC 卷");
        if (value.StartsWith("\\\\?\\", StringComparison.OrdinalIgnoreCase)) value = value.Substring(4);
        else if (value.StartsWith("\\\\", StringComparison.Ordinal)) throw new ArgumentException("恢复发布目标不能解析到远程 UNC 卷");
        if (value.Length < 3 || !Char.IsLetter(value[0]) || value[1] != ':' || value[2] != '\\') throw new ArgumentException("恢复发布目标最终路径不是本地盘符路径");
        var volumeBuffer = new StringBuilder(32768);
        if (!GetVolumePathName(value, volumeBuffer, (uint)volumeBuffer.Capacity)) throw new IOException("无法确定恢复发布目标最终卷");
        var volumeRoot = volumeBuffer.ToString();
        var driveType = GetDriveType(volumeRoot);
        if (driveType != DRIVE_FIXED && driveType != DRIVE_REMOVABLE) throw new ArgumentException("恢复发布目标最终卷不是本地 fixed/removable 卷");
        return NormalizeAbsolutePath(volumeRoot);
    }

    private static void ReleaseHandles(IEnumerable<SafeFileHandle> handles)
    {
        if (handles == null) return;
        foreach (var handle in handles) if (handle != null) handle.Dispose();
    }

    private static FileIdentity IdentityFromInformation(BY_HANDLE_FILE_INFORMATION information)
    {
        return new FileIdentity { VolumeSerial = information.VolumeSerialNumber, FileIndex = ((ulong)information.FileIndexHigh << 32) | information.FileIndexLow, Size = ((ulong)information.FileSizeHigh << 32) | information.FileSizeLow, LastWriteTime = ((ulong)(uint)information.LastWriteTime.dwHighDateTime << 32) | (uint)information.LastWriteTime.dwLowDateTime, Directory = (information.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0, ReparsePoint = (information.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 };
    }

    private static void RejectRawDeviceOrAds(string path)
    {
        if (String.IsNullOrWhiteSpace(path)) throw new ArgumentException("路径为空");
        var value = path.Replace('/', '\\');
        if (value.StartsWith("\\\\?\\", StringComparison.OrdinalIgnoreCase) || value.StartsWith("\\\\.\\", StringComparison.OrdinalIgnoreCase) || value.StartsWith("\\??\\", StringComparison.OrdinalIgnoreCase) || value.IndexOf(':', 2) >= 0) throw new ArgumentException("不允许设备路径、扩展路径或 ADS");
    }

    private static string NormalizeAbsolutePath(string path)
    {
        if (String.IsNullOrWhiteSpace(path)) throw new ArgumentException("路径为空");
        var value = path.Replace('/', '\\');
        if (value.StartsWith("\\\\?\\UNC\\", StringComparison.OrdinalIgnoreCase)) value = "\\\\" + value.Substring(8);
        else if (value.StartsWith("\\\\?\\", StringComparison.OrdinalIgnoreCase)) value = value.Substring(4);
        var buffer = new StringBuilder(32768);
        var length = GetFullPathName(value, (uint)buffer.Capacity, buffer, IntPtr.Zero);
        if (length == 0 || length >= buffer.Capacity) throw new ArgumentException("路径无法规范化");
        var normalized = buffer.ToString();
        if (normalized.Length == 3 && Char.IsLetter(normalized[0]) && normalized[1] == ':' && normalized[2] == '\\') return Char.ToUpperInvariant(normalized[0]) + ":\\";
        return normalized.TrimEnd('\\');
    }

    private static string ParentPath(string path)
    {
        var value = NormalizeAbsolutePath(path);
        var separator = value.LastIndexOf('\\');
        if (separator < 2) throw new ArgumentException("路径缺少父目录");
        if (separator == 2 && value.Length > 3 && value[1] == ':') return value.Substring(0, 3);
        return value.Substring(0, separator);
    }

    private static string FileName(string path)
    {
        var value = NormalizeAbsolutePath(path);
        var separator = value.LastIndexOf('\\');
        return separator < 0 ? value : value.Substring(separator + 1);
    }

    private static bool SamePath(string left, string right)
    {
        return String.Equals(NormalizeAbsolutePath(left), NormalizeAbsolutePath(right), StringComparison.OrdinalIgnoreCase);
    }

    private static void RejectReparseDirectory(string path)
    {
        var identity = CaptureIdentity(path, false);
        if (!identity.Directory || identity.ReparsePoint) throw new ArgumentException("回收站祖先目录必须是真实目录且不能是重解析点");
    }

    private static FileIdentity CaptureIdentity(string path, bool allowReparse)
    {
        using (var handle = OpenPath(path, true))
        {
            BY_HANDLE_FILE_INFORMATION information;
            if (!GetFileInformationByHandle(handle, out information)) throw new IOException("无法读取回收站对象身份");
            var reparse = (information.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
            if (reparse && !allowReparse) throw new ArgumentException("回收站验证对象不能是重解析点");
            return IdentityFromInformation(information);
        }
    }

    private static SafeFileHandle OpenPath(string path, bool allowReparse, bool read = false)
    {
        var flags = FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT;
        var shareMode = read ? FILE_SHARE_READ | FILE_SHARE_DELETE : FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
        var handle = CreateFile(ToExtendedPath(path), read ? GENERIC_READ : 0, shareMode, IntPtr.Zero, OPEN_EXISTING, flags, IntPtr.Zero);
        if (handle == null || handle.IsInvalid) { if (handle != null) handle.Dispose(); throw new IOException("无法打开回收站验证对象"); }
        if (!allowReparse)
        {
            BY_HANDLE_FILE_INFORMATION information;
            if (!GetFileInformationByHandle(handle, out information)) { handle.Dispose(); throw new IOException("无法读取回收站验证对象属性"); }
            if ((information.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) { handle.Dispose(); throw new ArgumentException("回收站验证对象不能是重解析点"); }
        }
        return handle;
    }

    private static string ToExtendedPath(string path)
    {
        var value = NormalizeAbsolutePath(path);
        return value.StartsWith("\\\\", StringComparison.Ordinal) ? "\\\\?\\UNC\\" + value.Substring(2) : "\\\\?\\" + value;
    }

    private static bool SameIdentity(FileIdentity left, FileIdentity right)
    {
        return left.VolumeSerial == right.VolumeSerial && left.FileIndex == right.FileIndex && left.Size == right.Size && left.LastWriteTime == right.LastWriteTime && left.Directory == right.Directory && left.ReparsePoint == right.ReparsePoint;
    }

    private static bool SameDirectoryObjectIdentity(FileIdentity left, FileIdentity right)
    {
        return left.VolumeSerial == right.VolumeSerial && left.FileIndex == right.FileIndex && left.Directory == right.Directory && left.ReparsePoint == right.ReparsePoint;
    }

    private static Dictionary<string, string> ParseOptions(string[] args)
    {
        var options = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var index = 1; index < args.Length; index += 2)
        {
            if (!args[index].StartsWith("--") || index + 1 >= args.Length) throw new ArgumentException("无效的参数");
            options[args[index].Substring(2)] = args[index + 1];
        }
        return options;
    }

    private static string Required(Dictionary<string, string> options, string name)
    {
        string value;
        if (!options.TryGetValue(name, out value) || String.IsNullOrWhiteSpace(value)) throw new ArgumentException("缺少参数：--" + name);
        return value;
    }

    private static void WriteJson(object value)
    {
        Console.WriteLine(new JavaScriptSerializer().Serialize(value));
    }

    private static void ThrowIfFailed(int hr)
    {
        if (hr < 0) Marshal.ThrowExceptionForHR(hr);
    }

    private static void Release(object value)
    {
        if (value != null && Marshal.IsComObject(value)) Marshal.FinalReleaseComObject(value);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    private static extern int SHCreateItemFromParsingName(string path, IntPtr bindContext, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItem item);

    [DllImport("shell32.dll", PreserveSig = true)]
    private static extern int SHCreateItemFromIDList(IntPtr pidl, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItem item);

    [DllImport("shell32.dll", PreserveSig = true)]
    private static extern int SHGetIDListFromObject([MarshalAs(UnmanagedType.IUnknown)] object value, out IntPtr pidl);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SHGetPathFromIDListEx(IntPtr pidl, StringBuilder path, uint pathLength, uint flags);

    [DllImport("shell32.dll", PreserveSig = true)]
    private static extern uint ILGetSize(IntPtr pidl);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool MoveFileEx(string existingName, string newName, uint flags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string path, uint desiredAccess, uint shareMode, IntPtr securityAttributes, uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFileAttributes(string path);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateDirectory(string path, IntPtr securityAttributes);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out BY_HANDLE_FILE_INFORMATION information);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint pathLength, uint flags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetVolumePathName(string fileName, StringBuilder volumePathName, uint bufferLength);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFullPathName(string fileName, uint bufferLength, StringBuilder buffer, IntPtr filePart);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern uint GetDriveType(string rootPathName);

    [StructLayout(LayoutKind.Sequential)]
    private struct BY_HANDLE_FILE_INFORMATION
    {
        internal uint FileAttributes;
        internal System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
        internal System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
        internal System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
        internal uint VolumeSerialNumber;
        internal uint FileSizeHigh;
        internal uint FileSizeLow;
        internal uint NumberOfLinks;
        internal uint FileIndexHigh;
        internal uint FileIndexLow;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROPERTYKEY
    {
        internal Guid FormatId;
        internal uint PropertyId;
        internal PROPERTYKEY(Guid formatId, uint propertyId) { FormatId = formatId; PropertyId = propertyId; }
    }

    [ComImport, Guid("3AD05575-8857-4850-9277-11B85BDB8E09")]
    private class FileOperation { }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE")]
    private interface IShellItem
    {
        [PreserveSig] int BindToHandler(IntPtr bindContext, [MarshalAs(UnmanagedType.LPStruct)] Guid bhid, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IntPtr result);
        [PreserveSig] int GetParent([MarshalAs(UnmanagedType.Interface)] out IShellItem parent);
        [PreserveSig] int GetDisplayName(uint sigdnName, out IntPtr name);
        [PreserveSig] int GetAttributes(uint mask, out uint attributes);
        [PreserveSig] int Compare([MarshalAs(UnmanagedType.Interface)] IShellItem other, uint hint, out int order);
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("7E9FB0D3-919F-4307-AB2E-9B1860310C93")]
    private interface IShellItem2
    {
        [PreserveSig] int BindToHandler(IntPtr bindContext, [MarshalAs(UnmanagedType.LPStruct)] Guid bhid, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IntPtr result);
        [PreserveSig] int GetParent([MarshalAs(UnmanagedType.Interface)] out IShellItem parent);
        [PreserveSig] int GetDisplayName(uint sigdnName, out IntPtr name);
        [PreserveSig] int GetAttributes(uint mask, out uint attributes);
        [PreserveSig] int Compare([MarshalAs(UnmanagedType.Interface)] IShellItem other, uint hint, out int order);
        [PreserveSig] int GetPropertyStore(uint flags, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IntPtr store);
        [PreserveSig] int GetPropertyStoreWithCreateObject(uint flags, [MarshalAs(UnmanagedType.IUnknown)] object createObject, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IntPtr store);
        [PreserveSig] int GetPropertyStoreForKeys(IntPtr keys, uint keyCount, uint flags, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IntPtr store);
        [PreserveSig] int GetPropertyDescriptionList(ref PROPERTYKEY key, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IntPtr descriptionList);
        [PreserveSig] int Update(IntPtr bindContext);
        [PreserveSig] int GetProperty(ref PROPERTYKEY key, IntPtr value);
        [PreserveSig] int GetCLSID(ref PROPERTYKEY key, out Guid value);
        [PreserveSig] int GetFileTime(ref PROPERTYKEY key, out System.Runtime.InteropServices.ComTypes.FILETIME value);
        [PreserveSig] int GetInt32(ref PROPERTYKEY key, out int value);
        [PreserveSig] int GetString(ref PROPERTYKEY key, out IntPtr value);
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("947AAB5F-0A5C-4C13-B4D6-4BF7836FC9F8")]
    private interface IFileOperation
    {
        [PreserveSig] int Advise([MarshalAs(UnmanagedType.Interface)] IFileOperationProgressSink sink, out uint cookie);
        [PreserveSig] int Unadvise(uint cookie);
        [PreserveSig] int SetOperationFlags(uint flags);
        [PreserveSig] int SetProgressMessage([MarshalAs(UnmanagedType.LPWStr)] string message);
        [PreserveSig] int SetProgressDialog([MarshalAs(UnmanagedType.IUnknown)] object dialog);
        [PreserveSig] int SetProperties([MarshalAs(UnmanagedType.IUnknown)] object properties);
        [PreserveSig] int SetOwnerWindow(uint owner);
        [PreserveSig] int ApplyPropertiesToItem(IShellItem item);
        [PreserveSig] int ApplyPropertiesToItems([MarshalAs(UnmanagedType.IUnknown)] object items);
        [PreserveSig] int RenameItem(IShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string newName, IFileOperationProgressSink sink);
        [PreserveSig] int RenameItems([MarshalAs(UnmanagedType.IUnknown)] object items, [MarshalAs(UnmanagedType.LPWStr)] string newName);
        [PreserveSig] int MoveItem(IShellItem item, IShellItem destinationFolder, [MarshalAs(UnmanagedType.LPWStr)] string newName, IFileOperationProgressSink sink);
        [PreserveSig] int MoveItems([MarshalAs(UnmanagedType.IUnknown)] object items, IShellItem destinationFolder);
        [PreserveSig] int CopyItem(IShellItem item, IShellItem destinationFolder, [MarshalAs(UnmanagedType.LPWStr)] string copyName, IFileOperationProgressSink sink);
        [PreserveSig] int CopyItems([MarshalAs(UnmanagedType.IUnknown)] object items, IShellItem destinationFolder);
        [PreserveSig] int DeleteItem(IShellItem item, IFileOperationProgressSink sink);
        [PreserveSig] int DeleteItems([MarshalAs(UnmanagedType.IUnknown)] object items);
        [PreserveSig] int NewItem(IShellItem destinationFolder, uint attributes, [MarshalAs(UnmanagedType.LPWStr)] string name, [MarshalAs(UnmanagedType.LPWStr)] string templateName, IFileOperationProgressSink sink);
        [PreserveSig] int PerformOperations();
        [PreserveSig] int GetAnyOperationsAborted([MarshalAs(UnmanagedType.Bool)] out bool aborted);
    }

    [ComVisible(true), InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("04B0F1A7-9490-44BC-96E1-4296A31252E2")]
    private interface IFileOperationProgressSink
    {
        [PreserveSig] int StartOperations();
        [PreserveSig] int FinishOperations(int result);
        [PreserveSig] int PreRenameItem(uint flags, IShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string newName);
        [PreserveSig] int PostRenameItem(uint flags, IShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string newName, int result, IShellItem newItem);
        [PreserveSig] int PreMoveItem(uint flags, IShellItem item, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string newName);
        [PreserveSig] int PostMoveItem(uint flags, IShellItem item, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string newName, int result, IShellItem newItem);
        [PreserveSig] int PreCopyItem(uint flags, IShellItem item, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string newName);
        [PreserveSig] int PostCopyItem(uint flags, IShellItem item, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string newName, int result, IShellItem newItem);
        [PreserveSig] int PreDeleteItem(uint flags, IShellItem item);
        [PreserveSig] int PostDeleteItem(uint flags, IShellItem item, int result, IShellItem newItem);
        [PreserveSig] int PreNewItem(uint flags, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string newName);
        [PreserveSig] int PostNewItem(uint flags, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string newName, [MarshalAs(UnmanagedType.LPWStr)] string templateName, uint attributes, int result, IShellItem newItem);
        [PreserveSig] int UpdateProgress(uint totalWork, uint workSoFar);
        [PreserveSig] int ResetTimer();
        [PreserveSig] int PauseTimer();
        [PreserveSig] int ResumeTimer();
    }

    [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
    private sealed class ProgressSink : IFileOperationProgressSink
    {
        internal byte[] RecycledPidl;
        internal int DeleteResult;
        internal bool DeleteCompleted;
        internal IShellItem MovedItem;
        internal int MoveResult;
        internal bool MoveCompleted;
        public int StartOperations() { return 0; }
        public int FinishOperations(int result) { return 0; }
        public int PreRenameItem(uint flags, IShellItem item, string newName) { return 0; }
        public int PostRenameItem(uint flags, IShellItem item, string newName, int result, IShellItem newItem) { return 0; }
        public int PreMoveItem(uint flags, IShellItem item, IShellItem destination, string newName) { return 0; }
        public int PostMoveItem(uint flags, IShellItem item, IShellItem destination, string newName, int result, IShellItem newItem) { MoveCompleted = true; MoveResult = result; if (result >= 0 && newItem != null) MovedItem = newItem; return 0; }
        public int PreCopyItem(uint flags, IShellItem item, IShellItem destination, string newName) { return 0; }
        public int PostCopyItem(uint flags, IShellItem item, IShellItem destination, string newName, int result, IShellItem newItem) { return 0; }
        public int PreDeleteItem(uint flags, IShellItem item) { return 0; }
        public int PostDeleteItem(uint flags, IShellItem item, int result, IShellItem newItem)
        {
            DeleteCompleted = true;
            DeleteResult = result;
            if (result >= 0 && newItem != null)
            {
                IntPtr pidl;
                if (SHGetIDListFromObject(newItem, out pidl) >= 0 && pidl != IntPtr.Zero)
                {
                    try
                    {
                        var size = checked((int)ILGetSize(pidl));
                        if (size > 0 && size <= 1024 * 1024)
                        {
                            RecycledPidl = new byte[size];
                            Marshal.Copy(pidl, RecycledPidl, 0, size);
                        }
                    }
                    finally { Marshal.FreeCoTaskMem(pidl); }
                }
            }
            return 0;
        }
        public int PreNewItem(uint flags, IShellItem destination, string newName) { return 0; }
        public int PostNewItem(uint flags, IShellItem destination, string newName, string templateName, uint attributes, int result, IShellItem newItem) { return 0; }
        public int UpdateProgress(uint totalWork, uint workSoFar) { return 0; }
        public int ResetTimer() { return 0; }
        public int PauseTimer() { return 0; }
        public int ResumeTimer() { return 0; }
        internal void ReleaseMovedItem() { MovedItem = null; }
    }

    private static string Optional(Dictionary<string, string> options, string name) { string value; return options.TryGetValue(name, out value) ? value : null; }
}
