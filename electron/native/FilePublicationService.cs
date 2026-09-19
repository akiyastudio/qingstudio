using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

internal static class FilePublicationService
{
    private sealed class OwnershipConflictException : IOException { public OwnershipConflictException(string message) : base(message) {} }
    private sealed class CopyBatchItem { internal int Index; internal string Source; internal string Target; internal string IdentityValue; internal long Size; internal long LastWriteTime; internal long ChangeTime; }
    private sealed class PostCommitException : IOException {
        internal readonly string PublishedPath;
        internal readonly string IdentityValue;
        public PostCommitException(string message, string publishedPath, string identity, Exception inner) : base(message, inner) { PublishedPath = publishedPath; IdentityValue = identity; }
    }
    private const uint MOVEFILE_WRITE_THROUGH = 0x8;
    private const uint GENERIC_READ = 0x80000000;
    private const uint GENERIC_WRITE = 0x40000000;
    private const uint DELETE = 0x00010000;
    private const uint FILE_WRITE_ATTRIBUTES = 0x00000100;
    private const uint FILE_TRAVERSE = 0x00000020;
    private const uint FILE_READ_ATTRIBUTES = 0x00000080;
    private const uint FILE_SHARE_READ = 0x1;
    private const uint FILE_SHARE_WRITE = 0x2;
    private const uint FILE_SHARE_DELETE = 0x4;
    private const uint OPEN_EXISTING = 3;
    private const uint CREATE_NEW = 1;
    private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    private const uint FILE_FLAG_SEQUENTIAL_SCAN = 0x08000000;
    private const uint SYNCHRONIZE = 0x00100000;
    private const uint FILE_OPEN = 1;
    private const uint FILE_DIRECTORY_FILE = 0x1;
    private const uint FILE_SYNCHRONOUS_IO_NONALERT = 0x20;
    private const uint FILE_NON_DIRECTORY_FILE = 0x40;
    private const uint FILE_OPEN_REPARSE_POINT = 0x00200000;
    private const uint OBJ_CASE_INSENSITIVE = 0x40;
    private const int FileDispositionInfo = 4;
    private const int FileBasicInfo = 0;
    private const uint FILE_ATTRIBUTE_DIRECTORY = 0x10;
    private const uint FILE_ATTRIBUTE_READONLY = 0x1;
    private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
    private const uint INVALID_FILE_ATTRIBUTES = 0xffffffff;

    [StructLayout(LayoutKind.Sequential)] private struct FILE_DISPOSITION_INFO { [MarshalAs(UnmanagedType.Bool)] public bool DeleteFile; }
    [StructLayout(LayoutKind.Sequential)] private struct FILE_BASIC_INFO { public long CreationTime; public long LastAccessTime; public long LastWriteTime; public long ChangeTime; public uint FileAttributes; }
    [StructLayout(LayoutKind.Sequential)] private struct BY_HANDLE_FILE_INFORMATION { public uint FileAttributes; public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime; public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime; public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime; public uint VolumeSerialNumber; public uint FileSizeHigh; public uint FileSizeLow; public uint NumberOfLinks; public uint FileIndexHigh; public uint FileIndexLow; }
    [StructLayout(LayoutKind.Sequential)] private struct UNICODE_STRING { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }
    [StructLayout(LayoutKind.Sequential)] private struct OBJECT_ATTRIBUTES { public int Length; public IntPtr RootDirectory; public IntPtr ObjectName; public uint Attributes; public IntPtr SecurityDescriptor; public IntPtr SecurityQualityOfService; }
    [StructLayout(LayoutKind.Sequential)] private struct IO_STATUS_BLOCK { public IntPtr Status; public IntPtr Information; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool MoveFileEx(string existingName, string newName, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool DeleteFile(string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetFileInformationByHandle(SafeFileHandle handle, int infoClass, ref FILE_DISPOSITION_INFO info, uint size);
    [DllImport("kernel32.dll", EntryPoint = "SetFileInformationByHandle", SetLastError = true)] private static extern bool SetBasicInformationByHandle(SafeFileHandle handle, int infoClass, ref FILE_BASIC_INFO info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int infoClass, out FILE_BASIC_INFO info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out BY_HANDLE_FILE_INFORMATION info);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern uint GetFileAttributes(string name);
    [DllImport("ntdll.dll")] private static extern uint NtCreateFile(out SafeFileHandle handle, uint access, ref OBJECT_ATTRIBUTES attributes, ref IO_STATUS_BLOCK ioStatus, IntPtr allocationSize, uint fileAttributes, uint shareAccess, uint createDisposition, uint createOptions, IntPtr eaBuffer, uint eaLength);
    [DllImport("ntdll.dll")] private static extern uint RtlNtStatusToDosError(uint status);
#if PHOTOFLOW_TEST_FAULTS
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetProcessHandleCount(IntPtr process, out uint handleCount);
#endif

    private static int Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;
        if (args.Length == 1 && args[0] == "serve-moves") return ServeMoves();
        if (args.Length == 1 && args[0] == "serve-operations") return ServeOperations();
        try {
            if (args.Length < 1) throw new ArgumentException("缺少操作名称");
            var options = Parse(args);
            var result = ExecuteOperation(args[0], options);
            Write(result); return 0;
        } catch (Exception error) {
            Write(Failure(error));
            return 1;
        }
    }
    private static object ExecuteOperation(string operation, Dictionary<string, string> options)
    {
            object result;
            if (operation == "move-no-replace") result = MoveNoReplace(Required(options, "source"), Required(options, "target"));
            else if (operation == "move-no-replace-batch") result = MoveNoReplaceBatch(Required(options, "manifest"));
            else if (operation == "inspect-path-batch") result = InspectPathBatch(Required(options, "manifest"));
            else if (operation == "delete-paths-batch") result = DeletePathsBatch(Required(options, "manifest"));
            else if (operation == "compare-delete-files-batch") result = CompareDeleteFilesBatch(Required(options, "manifest"), Required(options, "manifest-sha256"), long.Parse(Required(options, "manifest-size")));
            else if (operation == "copy-files-batch") result = CopyFilesBatch(Required(options, "manifest"), Required(options, "manifest-sha256"), long.Parse(Required(options, "manifest-size")), false, options.ContainsKey("durable") && options["durable"] == "true", options.ContainsKey("control") ? Full(options["control"]) : null, options.ContainsKey("resume-path") ? Full(options["resume-path"]) : null, options.ContainsKey("resume-identity") ? options["resume-identity"] : null, options.ContainsKey("parallelism") ? int.Parse(options["parallelism"]) : 8);
            else if (operation == "copy-cut-files-batch") result = CopyFilesBatch(Required(options, "manifest"), Required(options, "manifest-sha256"), long.Parse(Required(options, "manifest-size")), true, true, options.ContainsKey("control") ? Full(options["control"]) : null, null, null, options.ContainsKey("parallelism") ? int.Parse(options["parallelism"]) : 8);
            else if (operation == "delete-directories-batch") result = DeleteDirectoriesBatch(Required(options, "manifest"), Required(options, "manifest-sha256"), long.Parse(Required(options, "manifest-size")));
            else if (operation == "commit-cross-volume-file") result = CommitCrossVolume(Required(options, "source"), Required(options, "staged"), Required(options, "target"), Required(options, "sha256"), long.Parse(Required(options, "size")), Required(options, "source-identity"));
            else if (operation == "compare-delete-file") result = CompareDelete(Required(options, "target"), Required(options, "sha256"), long.Parse(Required(options, "size")), Required(options, "identity"));
            else if (operation == "inspect-path") result = Inspect(Required(options, "path"));
            else if (operation == "commit-tree-file") result = CommitTreeFile(Required(options, "source"), Required(options, "target"), Required(options, "sha256"), long.Parse(Required(options, "size")), Required(options, "identity"));
            else if (operation == "delete-empty-directory") result = DeleteEmptyDirectory(Required(options, "source"), Required(options, "identity"));
            else throw new ArgumentException("不支持的操作：" + operation);
            return result;
    }

    private static object Failure(Exception error)
    {
            var native = error as Win32Exception;
            var code = error is OwnershipConflictException ? "PUBLISH_OWNERSHIP_CONFLICT" : error is PathTooLongException ? "ENAMETOOLONG" : error is ArgumentException ? "EINVAL" : native == null ? "FILE_PUBLICATION_FAILED" : NativeCode(native.NativeErrorCode);
            var failure = new Dictionary<string, object> { { "success", false }, { "error", error.Message }, { "code", code }, { "nativeError", native == null ? 0 : native.NativeErrorCode } };
            var committed = error as PostCommitException;
            if (committed != null) { failure["published"] = true; failure["outcomeUnknown"] = true; failure["publishedPath"] = committed.PublishedPath; failure["identity"] = committed.IdentityValue; }
            return failure;
    }
    private static int ServeOperations()
    {
        Console.InputEncoding = Encoding.UTF8;
        var serializer = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024 };
        Write(new { ready = true, protocol = "photoflow-files-v1" });
        string line;
        while ((line = Console.ReadLine()) != null) {
            string id = ""; object result;
            try {
                if (line.Length > 1024 * 1024) throw new ArgumentException("请求过大");
                var request = serializer.Deserialize<Dictionary<string, string>>(line);
                id = Required(request, "id");
                if (id.Length > 64) throw new ArgumentException("请求序号无效");
                result = ExecuteOperation(Required(request, "operation"), request);
            } catch (Exception error) { result = Failure(error); }
            Write(new { id = id, result = result });
        }
        return 0;
    }
    private static int ServeMoves()
    {
        Console.InputEncoding = Encoding.UTF8;
        var serializer = new JavaScriptSerializer { MaxJsonLength = 512 * 1024 };
        Write(new { ready = true, protocol = "photoflow-rename-v1" });
        string line;
        while ((line = Console.ReadLine()) != null) {
            string id = "";
            object result;
            try {
                if (line.Length > 512 * 1024) throw new ArgumentException("请求过大");
                var request = serializer.Deserialize<Dictionary<string, string>>(line);
                if (request == null || request.Count != 3) throw new ArgumentException("请求字段无效");
                id = Required(request, "id");
                if (id.Length > 64) throw new ArgumentException("请求序号无效");
                result = MoveNoReplace(Required(request, "source"), Required(request, "target"));
            } catch (Exception error) { result = Failure(error); }
            Write(new { id = id, result = result });
        }
        return 0;
    }

    private static object MoveNoReplace(string sourceValue, string targetValue)
    {
        var source = Full(sourceValue); var target = Full(targetValue); EnsureDistinct(source, target);
        var sourceAttributes = GetFileAttributes(source); if (sourceAttributes == INVALID_FILE_ATTRIBUTES) throw new Win32Exception(Marshal.GetLastWin32Error());
        if ((sourceAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
            using (var directoryHandle = OpenLocked(source, GENERIC_READ, true, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)) {
                var identity = Identity(directoryHandle);
                MoveNoReplaceCore(source, target);
                try { using (var targetHandle = OpenLocked(target, GENERIC_READ, true)) VerifyIdentity(targetHandle, identity, "已发布目录"); }
                catch (Exception error) { throw new PostCommitException("目录已发布，但无法完成目标身份复核", target, identity, error); }
                return new Dictionary<string, object> { { "success", true }, { "strategy", "win32-move-no-replace" }, { "identity", identity } };
            }
        }
        using (var handle = OpenLocked(source, GENERIC_READ, false, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)) {
            var identity = Identity(handle);
            MoveNoReplaceCore(source, target);
            return new Dictionary<string, object> { { "success", true }, { "strategy", "win32-move-no-replace" }, { "identity", identity } };
        }
    }
    private static object MoveNoReplaceBatch(string manifestValue)
    {
        Full(manifestValue); var manifest = Path.GetFullPath(manifestValue);
        var results = new List<Dictionary<string, object>>();
        var utf8 = new UTF8Encoding(false, true);
        var lines = File.ReadAllLines(manifest, utf8);
        for (var expectedIndex = 0; expectedIndex < lines.Length; expectedIndex++) {
            var parts = lines[expectedIndex].Split('\t');
            if (parts.Length != 4) throw new ArgumentException("批量发布清单格式无效");
            int index; if (!Int32.TryParse(parts[0], out index) || index != expectedIndex) throw new ArgumentException("批量发布清单索引无效");
            string sourceValue; string targetValue; string expectedIdentity;
            try { sourceValue = utf8.GetString(Convert.FromBase64String(parts[1])); targetValue = utf8.GetString(Convert.FromBase64String(parts[2])); expectedIdentity = utf8.GetString(Convert.FromBase64String(parts[3])); }
            catch (Exception error) { throw new ArgumentException("批量发布清单路径编码无效", error); }
            try {
                var source = Full(sourceValue); var target = Full(targetValue); EnsureDistinct(source, target);
                using (var handle = OpenLocked(source, GENERIC_READ, Directory.Exists(source), FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)) {
                    var identity = Identity(handle);
                    VerifyIdentity(handle, expectedIdentity, "批量发布源");
                    // MoveFileEx can report success for two existing hard links
                    // to one file. Match the single-item no-clobber contract.
                    if (GetFileAttributes(target) != INVALID_FILE_ATTRIBUTES) throw new Win32Exception(183, "目标文件已存在");
                    MoveNoReplaceCore(source, target);
                    try { using (var targetHandle = OpenLocked(target, GENERIC_READ, Directory.Exists(target))) VerifyIdentity(targetHandle, expectedIdentity, "批量发布目标"); }
                    catch (Exception error) { throw new PostCommitException("项目已发布，但无法完成目标身份复核", target, identity, error); }
                    results.Add(new Dictionary<string, object> { { "index", index }, { "success", true }, { "strategy", "win32-batch-move-no-replace" }, { "identity", identity } });
                }
            } catch (Exception error) {
                var native = error as Win32Exception;
                var code = error is OwnershipConflictException ? "PUBLISH_OWNERSHIP_CONFLICT" : error is PathTooLongException ? "ENAMETOOLONG" : error is ArgumentException ? "EINVAL" : native == null ? "FILE_PUBLICATION_FAILED" : NativeCode(native.NativeErrorCode);
                var failed = new Dictionary<string, object> { { "index", index }, { "success", false }, { "error", error.Message }, { "code", code }, { "nativeError", native == null ? 0 : native.NativeErrorCode } };
                var committed = error as PostCommitException;
                if (committed != null) { failed["published"] = true; failed["outcomeUnknown"] = true; failed["publishedPath"] = committed.PublishedPath; failed["identity"] = committed.IdentityValue; }
                results.Add(failed);
                break;
            }
        }
        return new Dictionary<string, object> { { "success", true }, { "results", results } };
    }
    private static object InspectPathBatch(string manifestValue)
    {
        Full(manifestValue); var manifest = Path.GetFullPath(manifestValue); var results = new List<Dictionary<string, object>>(); var utf8 = new UTF8Encoding(false, true); var lines = File.ReadAllLines(manifest, utf8);
        for (var expectedIndex = 0; expectedIndex < lines.Length; expectedIndex++) {
            var parts = lines[expectedIndex].Split('\t'); if (parts.Length != 2) throw new ArgumentException("批量检查清单格式无效");
            int index; if (!Int32.TryParse(parts[0], out index) || index != expectedIndex) throw new ArgumentException("批量检查清单索引无效");
            string value; try { value = utf8.GetString(Convert.FromBase64String(parts[1])); } catch (Exception error) { throw new ArgumentException("批量检查路径编码无效", error); }
            try {
                var requested = Full(value); var attributes = GetFileAttributes(requested); if (attributes == INVALID_FILE_ATTRIBUTES) throw new Win32Exception(Marshal.GetLastWin32Error()); var directory = (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
                using (var handle = OpenLocked(requested, directory ? 0 : GENERIC_READ, directory, directory ? FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE : FILE_SHARE_READ)) {
                    var result = new Dictionary<string, object> { { "index", index }, { "success", true }, { "identity", Identity(handle) }, { "directory", directory } };
                    if (!directory) { FILE_BASIC_INFO basic; BY_HANDLE_FILE_INFORMATION file; ReadBasicInformation(handle, out basic); if (!GetFileInformationByHandle(handle, out file)) throw new Win32Exception(Marshal.GetLastWin32Error()); result["size"] = (((long)file.FileSizeHigh << 32) | file.FileSizeLow).ToString(); result["lastWriteTime"] = basic.LastWriteTime.ToString(); result["changeTime"] = basic.ChangeTime.ToString(); }
                    results.Add(result);
                }
            } catch (Exception error) {
                var native = error as Win32Exception; var code = error is PathTooLongException ? "ENAMETOOLONG" : error is ArgumentException ? "EINVAL" : native == null ? "FILE_PUBLICATION_FAILED" : NativeCode(native.NativeErrorCode);
                results.Add(new Dictionary<string, object> { { "index", index }, { "success", false }, { "error", error.Message }, { "code", code }, { "nativeError", native == null ? 0 : native.NativeErrorCode } });
            }
        }
        return new Dictionary<string, object> { { "success", true }, { "results", results } };
    }
    private static object DeletePathsBatch(string manifestValue)
    {
        Full(manifestValue); var manifest = Path.GetFullPath(manifestValue); var results = new List<Dictionary<string, object>>(); var utf8 = new UTF8Encoding(false, true); var lines = File.ReadAllLines(manifest, utf8);
        for (var expectedIndex = 0; expectedIndex < lines.Length; expectedIndex++) {
            var parts = lines[expectedIndex].Split('\t'); if (parts.Length != 3) throw new ArgumentException("批量清理清单格式无效");
            int index; if (!Int32.TryParse(parts[0], out index) || index != expectedIndex) throw new ArgumentException("批量清理清单索引无效");
            string value; string identity; try { value = utf8.GetString(Convert.FromBase64String(parts[1])); identity = utf8.GetString(Convert.FromBase64String(parts[2])); } catch (Exception error) { throw new ArgumentException("批量清理路径编码无效", error); }
            try {
                var requested = Full(value); var attributes = GetFileAttributes(requested); if (attributes == INVALID_FILE_ATTRIBUTES) throw new Win32Exception(Marshal.GetLastWin32Error()); var directory = (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
                FILE_BASIC_INFO original; bool changed;
                using (var handle = OpenIdentityDelete(requested, identity, directory, "批量清理目标", out original, out changed)) { try { MarkDelete(handle); } catch { RestoreAttributes(handle, original, changed); throw; } }
                results.Add(new Dictionary<string, object> { { "index", index }, { "success", true }, { "deleted", true } });
            } catch (Exception error) {
                var native = error as Win32Exception; var code = error is OwnershipConflictException ? "PUBLISH_OWNERSHIP_CONFLICT" : error is PathTooLongException ? "ENAMETOOLONG" : error is ArgumentException ? "EINVAL" : native == null ? "FILE_PUBLICATION_FAILED" : NativeCode(native.NativeErrorCode);
                results.Add(new Dictionary<string, object> { { "index", index }, { "success", false }, { "error", error.Message }, { "code", code }, { "nativeError", native == null ? 0 : native.NativeErrorCode } });
            }
        }
        return new Dictionary<string, object> { { "success", true }, { "results", results } };
    }
    private static string[] ReadBoundManifest(string manifestValue, string expectedHash, long expectedSize)
    {
        if (expectedSize < 0 || expectedSize > 512 * 1024) throw new ArgumentException("批量清单大小无效"); byte[] bytes;
        using (var stream = new FileStream(Path.GetFullPath(manifestValue), FileMode.Open, FileAccess.Read, FileShare.Read)) { if (stream.Length != expectedSize) throw new OwnershipConflictException("批量清单大小已变化"); bytes = new byte[(int)expectedSize]; var offset = 0; while (offset < bytes.Length) { var read = stream.Read(bytes, offset, bytes.Length - offset); if (read <= 0) throw new EndOfStreamException(); offset += read; } }
        using (var sha = SHA256.Create()) { var actual = BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant(); if (!String.Equals(actual, expectedHash, StringComparison.OrdinalIgnoreCase)) throw new OwnershipConflictException("批量清单摘要已变化"); }
        return new UTF8Encoding(false, true).GetString(bytes).Split(new[] { "\r\n", "\n" }, StringSplitOptions.RemoveEmptyEntries);
    }
    private static object CompareDeleteFilesBatch(string manifestValue, string manifestHash, long manifestSize)
    {
        Full(manifestValue); var results = new List<Dictionary<string, object>>(); string root; Dictionary<string, string> directories; List<CompareDeleteItem> files;
        ParseDestructiveManifest(ReadBoundManifest(manifestValue, manifestHash, manifestSize), false, out root, out directories, out files);
        for (var expectedIndex = 0; expectedIndex < files.Count; expectedIndex++) {
            var item = files[expectedIndex]; var index = item.Index;
            try {
                var heldParents = OpenVerifiedParentChain(root, item.Path, directories);
                try { FILE_BASIC_INFO attributes; bool changed; using (var handle = OpenVerifiedDeleteRelative(heldParents[heldParents.Count - 1], Path.GetFileName(item.Path), item.Identity, item.Hash, item.Size, "批量补偿目标", out attributes, out changed)) { try { MarkDelete(handle); } catch (Exception error) { RestoreAttributes(handle, attributes, changed); throw new IOException("相对文件标记删除失败", error); } } }
                finally { foreach (var held in heldParents) held.Dispose(); }
                results.Add(new Dictionary<string, object> { { "index", index }, { "success", true }, { "deleted", true } });
            } catch (Exception error) {
                var native = error as Win32Exception; var code = error is OwnershipConflictException || error is InvalidDataException ? "PUBLISH_OWNERSHIP_CONFLICT" : error is PathTooLongException ? "ENAMETOOLONG" : error is ArgumentException ? "EINVAL" : native == null ? "FILE_PUBLICATION_FAILED" : NativeCode(native.NativeErrorCode);
                results.Add(new Dictionary<string, object> { { "index", index }, { "success", false }, { "deleted", false }, { "error", error.Message }, { "code", code }, { "nativeError", native == null ? 0 : native.NativeErrorCode } });
            }
        }
        return new Dictionary<string, object> { { "success", true }, { "results", results } };
    }

    private static object CopyFilesBatch(string manifestValue, string manifestHash, long manifestSize, bool deleteSource, bool durable, string controlPath = null, string resumePath = null, string resumeIdentity = null, int parallelism = 8)
    {
        var lines = ReadBoundManifest(manifestValue, manifestHash, manifestSize); var items = new List<CopyBatchItem>(); var utf8 = new UTF8Encoding(false, true);
        for (var expectedIndex = 0; expectedIndex < lines.Length; expectedIndex++) {
            var parts = lines[expectedIndex].Split('\t');
            if (parts.Length != 8 || parts[0] != "F") throw new ArgumentException("原生复制清单格式无效");
            int index; long size; long lastWriteTime; long changeTime;
            if (!Int32.TryParse(parts[1], out index) || index != expectedIndex || !Int64.TryParse(parts[5], out size) || size < 0 || !Int64.TryParse(parts[6], out lastWriteTime) || !Int64.TryParse(parts[7], out changeTime)) throw new ArgumentException("原生复制清单快照无效");
            string sourceValue; string targetValue; string identity;
            try { sourceValue = utf8.GetString(Convert.FromBase64String(parts[2])); targetValue = utf8.GetString(Convert.FromBase64String(parts[3])); identity = utf8.GetString(Convert.FromBase64String(parts[4])); }
            catch (Exception error) { throw new ArgumentException("原生复制清单路径编码无效", error); }
            items.Add(new CopyBatchItem { Index = index, Source = sourceValue, Target = targetValue, IdentityValue = identity, Size = size, LastWriteTime = lastWriteTime, ChangeTime = changeTime });
        }
        var results = new Dictionary<string, object>[items.Count]; var failed = 0;
        var control = new CopyControl(controlPath, items.Count, items.Sum(item => item.Size));
        if (resumePath != null && (deleteSource || items.Count != 1 || String.IsNullOrEmpty(resumeIdentity))) throw new ArgumentException("续传仅支持单文件复制");
        var degree = items.Count > 1 && items.All(item => item.Size <= 2L * 1024 * 1024) ? Math.Min(Math.Max(1, Math.Min(8, parallelism)), items.Count) : 1;
        Parallel.ForEach(items, new ParallelOptions { MaxDegreeOfParallelism = degree }, item => {
            if (Volatile.Read(ref failed) != 0) return;
            try {
                var result = CopyFileSinglePass(item.Source, item.Target, item.IdentityValue, item.Size, item.LastWriteTime, item.ChangeTime, deleteSource, durable, control, item.Index, resumePath, resumeIdentity); result["index"] = item.Index; results[item.Index] = result;
            } catch (Exception error) {
                var native = error as Win32Exception; var committed = error as PostCommitException;
                var code = error is OperationCanceledException ? "EOPCANCELLED" : error is OwnershipConflictException || error is InvalidDataException ? "PUBLISH_OWNERSHIP_CONFLICT" : error is PathTooLongException ? "ENAMETOOLONG" : error is ArgumentException ? "EINVAL" : native == null ? "FILE_PUBLICATION_FAILED" : NativeCode(native.NativeErrorCode);
                var failure = new Dictionary<string, object> { { "index", item.Index }, { "success", false }, { "error", committed != null && committed.InnerException != null ? error.Message + "：" + committed.InnerException.Message : error.Message }, { "code", code }, { "nativeError", native == null ? 0 : native.NativeErrorCode }, { "sourceDeleted", false } };
                if (committed != null) { failure["published"] = true; failure["publishedPath"] = committed.PublishedPath; failure["identity"] = committed.IdentityValue; }
                results[item.Index] = failure; Interlocked.Exchange(ref failed, 1);
            }
        });
        return new Dictionary<string, object> { { "success", true }, { "results", results.Where(item => item != null).ToList() } };
    }

    private sealed class CopyControl
    {
        private readonly string path;
        private readonly object gate = new object();
        private readonly long[] copiedByItem;
        private readonly long totalBytes;
        private long copiedBytes;
        private long nextCheck;
        private long nextProgress;
        private string state = "run";
        internal CopyControl(string value, int count, long total) { path = value; copiedByItem = new long[count]; totalBytes = total; }
        internal void Check(int index, long copied)
        {
            if (path == null) return;
            for (;;) {
              lock (gate) {
                var now = DateTime.UtcNow.Ticks;
                if (now >= nextCheck) {
                    nextCheck = now + TimeSpan.TicksPerMillisecond * 50;
                    if (GetFileAttributes(path) == INVALID_FILE_ATTRIBUTES) throw new OperationCanceledException("复制控制记录已移除");
                    try {
                        using (var handle = OpenLocked(path, GENERIC_READ, false, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE))
                        using (var stream = new FileStream(handle, FileAccess.Read, 64, false))
                        using (var reader = new StreamReader(stream)) {
                            var value = reader.ReadToEnd();
                            if (value == "run" || value == "pause" || value == "cancel") state = value;
                        }
                    } catch (IOException) { /* an in-progress state write is retried */ }
                }
                if (state == "cancel") throw new OperationCanceledException("文件操作已取消");
                copiedBytes += Math.Max(0, copied - copiedByItem[index]);
                copiedByItem[index] = Math.Max(copiedByItem[index], copied);
                if (now >= nextProgress) {
                    nextProgress = now + TimeSpan.TicksPerMillisecond * 100;
                    Write(new Dictionary<string, object> { { "type", "copy-progress" }, { "bytesCopied", copiedBytes }, { "totalBytes", totalBytes } });
                }
                if (state != "pause") return;
              }
              Thread.Sleep(25);
            }
        }
    }

    private static Dictionary<string, object> CopyFileSinglePass(string sourceValue, string targetValue, string expectedIdentity, long expectedSize, long expectedLastWriteTime, long expectedChangeTime, bool deleteSource, bool durable, CopyControl control, int itemIndex, string resumePath = null, string resumeIdentity = null)
    {
        var source = Full(sourceValue); var target = Full(targetValue); EnsureDistinct(source, target);
        var separator = target.LastIndexOf('\\'); if (separator <= 0 || separator + 1 >= target.Length) throw new DirectoryNotFoundException("原生剪切目标目录不存在");
        var targetDirectory = target.Substring(0, separator); var targetName = target.Substring(separator + 1);
        var temporary = resumePath ?? targetDirectory + "\\." + targetName + "." + Guid.NewGuid().ToString("N") + ".photoflow-fast-cut";
        // Full() already canonicalizes extended Win32 paths. Avoid legacy
        // System.IO.Path APIs here: they reject valid paths beyond MAX_PATH.
        if (resumePath != null && (!String.Equals(temporary.Substring(0, temporary.LastIndexOf('\\')), targetDirectory, StringComparison.OrdinalIgnoreCase) || !temporary.EndsWith(".photoflow-resumable", StringComparison.Ordinal) || String.Equals(temporary, source, StringComparison.OrdinalIgnoreCase) || String.Equals(temporary, target, StringComparison.OrdinalIgnoreCase))) throw new ArgumentException("续传暂存位置无效");
        var bufferSize = (int)Math.Min(4L * 1024 * 1024, Math.Max(4096L, expectedSize));
        var published = false; var targetIdentity = "";
        long resumedBytes = 0;
        try {
            using (var sourceHandle = OpenLocked(source, deleteSource ? GENERIC_READ | DELETE | FILE_WRITE_ATTRIBUTES : GENERIC_READ, false, FILE_SHARE_READ))
            using (var sourceStream = new FileStream(sourceHandle, FileAccess.Read, bufferSize, false)) {
                control.Check(itemIndex, 0);
                VerifyIdentity(sourceHandle, expectedIdentity, "原生剪切源文件"); FILE_BASIC_INFO sourceBasic; ReadBasicInformation(sourceHandle, out sourceBasic);
                if (sourceStream.Length != expectedSize || sourceBasic.LastWriteTime != expectedLastWriteTime || sourceBasic.ChangeTime != expectedChangeTime) throw new OwnershipConflictException("原生剪切源文件快照已变化");
                string digest;
                using (var targetHandle = resumePath == null ? CreateWritableNew(temporary) : OpenLocked(temporary, GENERIC_READ | GENERIC_WRITE | FILE_WRITE_ATTRIBUTES, false, FILE_SHARE_READ | FILE_SHARE_DELETE))
                using (var targetStream = new FileStream(targetHandle, FileAccess.ReadWrite, bufferSize, false))
                using (var sha = new SHA256Cng()) {
                    var buffer = new byte[bufferSize]; int read;
                    long copied = 0;
                    if (resumePath != null) {
                        VerifyIdentity(targetHandle, resumeIdentity, "续传暂存文件");
                        if ((GetFileAttributes(temporary) & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0 || targetStream.Length > expectedSize) throw new OwnershipConflictException("续传暂存文件类型或长度不符");
                        resumedBytes = targetStream.Length;
                        var saved = new byte[bufferSize];
                        while (copied < resumedBytes) {
                            read = sourceStream.Read(buffer, 0, (int)Math.Min(buffer.Length, resumedBytes - copied));
                            if (read == 0) throw new EndOfStreamException("续传源文件不完整");
                            var received = 0;
                            while (received < read) { var part = targetStream.Read(saved, received, read - received); if (part == 0) throw new EndOfStreamException("续传暂存文件不完整"); received += part; }
                            for (var index = 0; index < read; index++) if (buffer[index] != saved[index]) throw new OwnershipConflictException("续传前缀校验失败，原文件和暂存文件已保留");
                            sha.TransformBlock(buffer, 0, read, buffer, 0);
                            copied += read; control.Check(itemIndex, copied);
                        }
                    }
                    while ((read = sourceStream.Read(buffer, 0, buffer.Length)) > 0) {
                        targetStream.Write(buffer, 0, read); sha.TransformBlock(buffer, 0, read, buffer, 0);
                        copied += read; control.Check(itemIndex, copied);
                    }
                    control.Check(itemIndex, copied);
                    sha.TransformFinalBlock(new byte[0], 0, 0); digest = BitConverter.ToString(sha.Hash).Replace("-", "").ToLowerInvariant();
                    if (targetStream.Length != expectedSize) throw new EndOfStreamException("原生剪切写入长度不完整");
                    targetStream.Flush(durable); VerifyIdentity(sourceHandle, expectedIdentity, "原生复制源文件"); FILE_BASIC_INFO stableSource; ReadBasicInformation(sourceHandle, out stableSource);
                    if (sourceStream.Length != expectedSize || stableSource.LastWriteTime != expectedLastWriteTime || stableSource.ChangeTime != expectedChangeTime) throw new OwnershipConflictException("原生剪切源文件在复制期间发生变化");
                    if (!SetBasicInformationByHandle(targetStream.SafeFileHandle, FileBasicInfo, ref sourceBasic, (uint)Marshal.SizeOf(typeof(FILE_BASIC_INFO)))) throw new Win32Exception(Marshal.GetLastWin32Error());
                    targetIdentity = Identity(targetStream.SafeFileHandle); MoveNoReplaceBuffered(temporary, target); published = true;
                    if (deleteSource) {
                        try { using (var verifyTargetHandle = OpenLocked(target, GENERIC_READ, false, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)) { VerifyIdentity(verifyTargetHandle, targetIdentity, "原生剪切目标文件"); BY_HANDLE_FILE_INFORMATION targetInfo; if (!GetFileInformationByHandle(verifyTargetHandle, out targetInfo)) throw new Win32Exception(Marshal.GetLastWin32Error()); var targetSize = ((long)targetInfo.FileSizeHigh << 32) | targetInfo.FileSizeLow; if (targetSize != expectedSize) throw new InvalidDataException("原生剪切目标文件大小不一致"); } }
                        catch (Exception error) { throw new PostCommitException("目标已发布，但目标身份或大小复核失败", target, targetIdentity, error); }
                    }
                    if (deleteSource) {
                        var sourceChanged = false; var originalSource = sourceBasic;
                        try { if ((sourceBasic.FileAttributes & FILE_ATTRIBUTE_READONLY) != 0) { var writable = sourceBasic; writable.FileAttributes &= ~FILE_ATTRIBUTE_READONLY; if (!SetBasicInformationByHandle(sourceHandle, FileBasicInfo, ref writable, (uint)Marshal.SizeOf(typeof(FILE_BASIC_INFO)))) throw new Win32Exception(Marshal.GetLastWin32Error()); sourceChanged = true; } MarkDelete(sourceHandle); }
                        catch (Exception error) { RestoreAttributes(sourceHandle, originalSource, sourceChanged); throw new PostCommitException("目标已发布，但源文件无法删除", target, targetIdentity, error); }
                    }
                }
                return new Dictionary<string, object> { { "success", true }, { "published", true }, { "sourceDeleted", deleteSource }, { "identity", targetIdentity }, { "sha256", digest }, { "size", expectedSize }, { "resumedBytes", resumedBytes } };
            }
        } finally {
            if (resumePath == null && !published && GetFileAttributes(temporary) != INVALID_FILE_ATTRIBUTES) try { DeleteFile(temporary); } catch { }
        }
    }
    private static List<SafeFileHandle> OpenVerifiedParentChain(string root, string target, Dictionary<string, string> directories)
    {
        var prefix = root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar; if (!target.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("批量摘要清理目标超出隔离根"); var relative = target.Substring(prefix.Length); if (relative.Length == 0 || Path.IsPathRooted(relative)) throw new ArgumentException("批量摘要清理目标超出隔离根");
        var held = new List<SafeFileHandle>(); var heldPaths = new List<string>(); var volumeRoot = VolumeRoot(root); var current = volumeRoot;
        try {
            SafeFileHandle rootHandle = null;
#if PHOTOFLOW_TEST_FAULTS
            TestBeginRootHandleAudit();
#endif
            try { rootHandle = OpenLocked(volumeRoot, GENERIC_READ, true, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE); } catch (Exception error) { throw new IOException("批量清理卷根打开失败：" + volumeRoot, error); }
            try { string volumeIdentity; if (!directories.TryGetValue(volumeRoot, out volumeIdentity)) throw new OwnershipConflictException("批量清理卷根未登记"); VerifyIdentity(rootHandle, volumeIdentity, "批量清理卷根"); heldPaths.Add(volumeRoot); held.Add(rootHandle); rootHandle = null; }
            catch (OwnershipConflictException) { if (rootHandle != null) { rootHandle.Dispose(); rootHandle = null; }
#if PHOTOFLOW_TEST_FAULTS
                TestEndRootHandleAudit();
#endif
                throw; }
            finally { if (rootHandle != null) rootHandle.Dispose(); }
            var parent = Path.GetDirectoryName(target); var chainRelative = parent.Substring(volumeRoot.Length); var segments = chainRelative.Split(new[] { Path.DirectorySeparatorChar }, StringSplitOptions.RemoveEmptyEntries);
            for (var index = 0; index < segments.Length; index++) {
                current = Path.Combine(current, segments[index]); SafeFileHandle handle = null;
                try {
                    handle = OpenRelative(held[held.Count - 1], segments[index], FILE_TRAVERSE | FILE_READ_ATTRIBUTES, true, FILE_SHARE_READ | FILE_SHARE_WRITE);
                    string expected; if (!directories.TryGetValue(current, out expected)) throw new OwnershipConflictException("批量清理父链未登记"); VerifyIdentity(handle, expected, "批量清理父目录");
                    held.Add(handle); heldPaths.Add(current); handle = null;
                } catch (OwnershipConflictException) { if (handle != null) handle.Dispose();
#if PHOTOFLOW_TEST_FAULTS
                    TestRenameReleasedParent(current);
#endif
                    throw; }
                catch (Exception error) { if (handle != null) handle.Dispose(); throw new IOException("批量清理父段失败：" + segments[index] + "；" + error.Message, error); }
            }
#if PHOTOFLOW_TEST_FAULTS
            TestRenameHeldParent(heldPaths);
#endif
            return held;
        } catch { foreach (var handle in held) handle.Dispose(); throw; }
    }
    private static object DeleteDirectoriesBatch(string manifestValue, string manifestHash, long manifestSize)
    {
        string root; Dictionary<string, string> directories; List<CompareDeleteItem> targets; var results = new List<Dictionary<string, object>>();
        ParseDestructiveManifest(ReadBoundManifest(manifestValue, manifestHash, manifestSize), true, out root, out directories, out targets);
        for (var expectedIndex = 0; expectedIndex < targets.Count; expectedIndex++) { var item = targets[expectedIndex]; var index = item.Index;
            try { var held = OpenVerifiedParentChain(root, item.Path, directories); try { FILE_BASIC_INFO original; bool changed; using (var handle = OpenIdentityDeleteRelative(held[held.Count - 1], Path.GetFileName(item.Path), item.Identity, true, "批量空目录", out original, out changed)) MarkDelete(handle); } finally { foreach (var handle in held) handle.Dispose(); } results.Add(new Dictionary<string, object> { { "index", index }, { "success", true }, { "deleted", true } }); }
            catch (Exception error) { var native = error as Win32Exception; var code = error is OwnershipConflictException || error is InvalidDataException ? "PUBLISH_OWNERSHIP_CONFLICT" : native == null ? "FILE_PUBLICATION_FAILED" : NativeCode(native.NativeErrorCode); results.Add(new Dictionary<string, object> { { "index", index }, { "success", false }, { "deleted", false }, { "code", code }, { "error", error.Message } }); }
        }
        return new Dictionary<string, object> { { "success", true }, { "results", results } };
    }
    private sealed class CompareDeleteItem { internal int Index; internal string Path; internal string Identity; internal long Size; internal string Hash; }
    private static void ParseDestructiveManifest(string[] lines, bool directoriesOnly, out string root, out Dictionary<string, string> directories, out List<CompareDeleteItem> targets)
    {
        var utf8 = new UTF8Encoding(false, true); root = null; directories = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase); targets = new List<CompareDeleteItem>(); var targetPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase); var sawTarget = false;
        foreach (var line in lines) {
            var parts = line.Split('\t');
            try {
                if (parts.Length == 2 && parts[0] == "R") { if (root != null || sawTarget) throw new ArgumentException(); root = Full(utf8.GetString(Convert.FromBase64String(parts[1]))); }
                else if (parts.Length == 3 && parts[0] == "D") { if (root == null || sawTarget) throw new ArgumentException(); var path = Full(utf8.GetString(Convert.FromBase64String(parts[1]))); var identity = utf8.GetString(Convert.FromBase64String(parts[2])); if (identity.Length == 0 || !IsUnderRoot(root, path, true) || directories.ContainsKey(path)) throw new ArgumentException(); directories.Add(path, identity); }
                else if ((!directoriesOnly && parts.Length == 6 && parts[0] == "F") || (directoriesOnly && parts.Length == 4 && parts[0] == "T")) { sawTarget = true; int index; if (!Int32.TryParse(parts[1], out index) || index != targets.Count || parts[1] != index.ToString()) throw new ArgumentException(); var path = Full(utf8.GetString(Convert.FromBase64String(parts[2]))); var identity = utf8.GetString(Convert.FromBase64String(parts[3])); if (identity.Length == 0 || root == null || !IsUnderRoot(root, path, false) || !targetPaths.Add(path)) throw new ArgumentException(); var item = new CompareDeleteItem { Index = index, Path = path, Identity = identity }; if (!directoriesOnly) { long size; if (!Int64.TryParse(parts[4], out size) || size < 0 || parts[4] != size.ToString() || !IsSha256(parts[5])) throw new ArgumentException(); item.Size = size; item.Hash = parts[5].ToLowerInvariant(); } targets.Add(item); }
                else throw new ArgumentException();
            } catch (Exception error) { throw new ArgumentException("破坏性批量清单字段无效", error); }
        }
        if (root == null || !String.Equals(root, VolumeRoot(root), StringComparison.OrdinalIgnoreCase) || !directories.ContainsKey(root) || targets.Count == 0 || targets.Count > 2048) throw new ArgumentException("破坏性批量清单缺少卷根身份或项目过多");
        foreach (var target in targets) { var current = root; var parent = Path.GetDirectoryName(target.Path); foreach (var segment in parent.Substring(root.Length).Split(new[] { Path.DirectorySeparatorChar }, StringSplitOptions.RemoveEmptyEntries)) { current = Path.Combine(current, segment); if (!directories.ContainsKey(current)) throw new ArgumentException("破坏性批量清单父链未完整登记"); } }
    }
    private static bool IsUnderRoot(string root, string value, bool allowRoot) { if (String.Equals(root, value, StringComparison.OrdinalIgnoreCase)) return allowRoot; return value.StartsWith(root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase); }
    private static bool IsSha256(string value) { return value != null && value.Length == 64 && value.All(ch => (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F')); }
    private static string VolumeRoot(string value)
    {
        if (value.StartsWith("\\\\?\\UNC\\", StringComparison.OrdinalIgnoreCase)) { var serverEnd = value.IndexOf('\\', 8); var shareEnd = serverEnd < 0 ? -1 : value.IndexOf('\\', serverEnd + 1); if (serverEnd < 0 || shareEnd < 0) throw new ArgumentException("UNC 卷根无效"); return value.Substring(0, shareEnd + 1); }
        if (value.Length >= 7 && value.StartsWith("\\\\?\\", StringComparison.Ordinal) && Char.IsLetter(value[4]) && value[5] == ':' && value[6] == '\\') return value.Substring(0, 7);
        throw new ArgumentException("批量清理卷根无效");
    }
#if PHOTOFLOW_TEST_FAULTS
    private static void TestRenameHeldParent(List<string> heldPaths)
    {
        var sourceValue = Environment.GetEnvironmentVariable("PHOTOFLOW_TEST_RENAME_HELD_PARENT"); if (String.IsNullOrEmpty(sourceValue)) return; var source = Full(sourceValue); if (!heldPaths.Any(value => String.Equals(value, source, StringComparison.OrdinalIgnoreCase))) throw new InvalidOperationException("测试父目录未被持有"); var destination = Full(Environment.GetEnvironmentVariable("PHOTOFLOW_TEST_RENAME_HELD_PARENT_TO")); var marker = Environment.GetEnvironmentVariable("PHOTOFLOW_TEST_RENAME_HELD_PARENT_RESULT"); bool moved = false; int error = 0;
        var thread = new Thread(() => { moved = MoveFileEx(source, destination, 0); if (!moved) error = Marshal.GetLastWin32Error(); }); thread.Start(); thread.Join();
        if (!String.IsNullOrEmpty(marker)) File.WriteAllText(marker, moved ? "renamed" : "blocked:" + error);
    }
    private static void TestRenameReleasedParent(string current)
    {
        var sourceValue = Environment.GetEnvironmentVariable("PHOTOFLOW_TEST_RENAME_RELEASED_PARENT"); if (String.IsNullOrEmpty(sourceValue)) return; var source = Full(sourceValue); if (!String.Equals(source, current, StringComparison.OrdinalIgnoreCase)) return; var destination = Full(Environment.GetEnvironmentVariable("PHOTOFLOW_TEST_RENAME_RELEASED_PARENT_TO")); var marker = Environment.GetEnvironmentVariable("PHOTOFLOW_TEST_RENAME_RELEASED_PARENT_RESULT"); bool moved = false; int error = 0;
        var thread = new Thread(() => { moved = MoveFileEx(source, destination, 0); if (moved) { if (!MoveFileEx(destination, source, 0)) { moved = false; error = Marshal.GetLastWin32Error(); } } else error = Marshal.GetLastWin32Error(); }); thread.Start(); thread.Join();
        if (!String.IsNullOrEmpty(marker)) File.WriteAllText(marker, moved ? "released" : "blocked:" + error);
    }
    private static uint testRootHandleBaseline;
    private static bool testRootHandleAuditActive;
    private static void TestBeginRootHandleAudit()
    {
        if (testRootHandleAuditActive || String.IsNullOrEmpty(Environment.GetEnvironmentVariable("PHOTOFLOW_TEST_ROOT_HANDLE_AUDIT"))) return; if (!GetProcessHandleCount(GetCurrentProcess(), out testRootHandleBaseline)) throw new Win32Exception(Marshal.GetLastWin32Error()); testRootHandleAuditActive = true;
    }
    private static void TestEndRootHandleAudit()
    {
        if (!testRootHandleAuditActive) return; uint current; if (!GetProcessHandleCount(GetCurrentProcess(), out current)) throw new Win32Exception(Marshal.GetLastWin32Error()); var marker = Environment.GetEnvironmentVariable("PHOTOFLOW_TEST_ROOT_HANDLE_AUDIT"); File.WriteAllText(marker, current <= testRootHandleBaseline ? "stable:" + current : "leaked:" + testRootHandleBaseline + ":" + current);
    }
#endif
    private static void MoveNoReplaceCore(string source, string target)
    {
        if (!MoveFileEx(source, target, MOVEFILE_WRITE_THROUGH)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    private static void MoveNoReplaceBuffered(string source, string target)
    {
        if (!MoveFileEx(source, target, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    private static object CommitCrossVolume(string sourceValue, string stagedValue, string targetValue, string expectedHash, long expectedSize, string expectedSourceIdentity)
    {
        var source = Full(sourceValue); var staged = Full(stagedValue); var target = Full(targetValue);
        EnsureDistinct(source, target); EnsureDistinct(staged, target);
        FILE_BASIC_INFO sourceAttributes; bool sourceAttributesChanged;
        using (var sourceHandle = OpenVerifiedDelete(source, expectedSourceIdentity, expectedHash, expectedSize, "源文件", out sourceAttributes, out sourceAttributesChanged)) {
            using (var stagedHandle = OpenLocked(staged, GENERIC_READ, false, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)) {
                var stagedIdentity = Identity(stagedHandle);
                Verify(stagedHandle, expectedHash, expectedSize, "暂存文件");
                MoveNoReplaceCore(staged, target);
                try {
                    using (var targetHandle = OpenLocked(target, GENERIC_READ)) { VerifyIdentity(targetHandle, stagedIdentity, "目标文件"); Verify(targetHandle, expectedHash, expectedSize, "目标"); }
                    try { MarkDelete(sourceHandle); } catch { RestoreAttributes(sourceHandle, sourceAttributes, sourceAttributesChanged); throw; }
                } catch (Exception error) { throw new PostCommitException("目标已发布，但提交后的验证或源清理失败", target, stagedIdentity, error); }
            }
        }
        return new Dictionary<string, object> { { "success", true }, { "strategy", "win32-cross-volume-locked-commit" } };
    }

    private static object CompareDelete(string targetValue, string expectedHash, long expectedSize, string expectedIdentity)
    {
        var target = Full(targetValue);
        FILE_BASIC_INFO attributes; bool changed;
        using (var handle = OpenVerifiedDelete(target, expectedIdentity, expectedHash, expectedSize, "补偿目标", out attributes, out changed)) { try { MarkDelete(handle); } catch { RestoreAttributes(handle, attributes, changed); throw; } }
        return new Dictionary<string, object> { { "success", true }, { "deleted", true } };
    }
    private static object Inspect(string value)
    {
        var requested = Full(value); var attributes = GetFileAttributes(requested); if (attributes == INVALID_FILE_ATTRIBUTES) throw new Win32Exception(Marshal.GetLastWin32Error()); var directory = (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
        using (var handle = OpenLocked(requested, directory ? 0 : GENERIC_READ, directory, directory ? FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE : FILE_SHARE_READ)) return new Dictionary<string, object> { { "success", true }, { "identity", Identity(handle) }, { "directory", directory } };
    }
    private static object CommitTreeFile(string sourceValue, string targetValue, string hash, long size, string identity)
    {
        var source = Full(sourceValue); var target = Full(targetValue);
        using (var targetHandle = OpenLocked(target, GENERIC_READ)) {
            Verify(targetHandle, hash, size, "目标文件");
            FILE_BASIC_INFO original; bool changed;
            using (var sourceHandle = OpenVerifiedDelete(source, identity, hash, size, "源文件", out original, out changed)) { try { MarkDelete(sourceHandle); } catch { RestoreAttributes(sourceHandle, original, changed); throw; } }
        }
        return new Dictionary<string, object> { { "success", true }, { "deleted", true } };
    }
    private static object DeleteEmptyDirectory(string sourceValue, string identity)
    {
        var source = Full(sourceValue);
        using (var handle = OpenLocked(source, GENERIC_READ | DELETE, true)) {
            if (!String.Equals(Identity(handle), identity, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("源目录身份已变化");
            MarkDelete(handle);
        }
        return new Dictionary<string, object> { { "success", true }, { "deleted", true } };
    }

    private static SafeFileHandle OpenLocked(string filePath, uint access, bool directory = false, uint share = FILE_SHARE_READ)
    {
        var flags = (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0) | FILE_FLAG_OPEN_REPARSE_POINT;
        var handle = CreateFile(filePath, access, share, IntPtr.Zero, OPEN_EXISTING, flags, IntPtr.Zero);
        if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        return handle;
    }
    private static SafeFileHandle CreateWritableNew(string filePath)
    {
        var handle = CreateFile(filePath, GENERIC_READ | GENERIC_WRITE | FILE_WRITE_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_DELETE, IntPtr.Zero, CREATE_NEW, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, IntPtr.Zero);
        if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        return handle;
    }
    private static SafeFileHandle OpenRelative(SafeFileHandle parent, string name, uint access, bool directory, uint share)
    {
        if (String.IsNullOrEmpty(name) || name == "." || name == ".." || name.IndexOfAny(new[] { '\\', '/' }) >= 0) throw new ArgumentException("相对路径组件无效");
        var buffer = Marshal.StringToHGlobalUni(name); var unicodePointer = IntPtr.Zero;
        try {
            var unicode = new UNICODE_STRING { Length = checked((ushort)(name.Length * 2)), MaximumLength = checked((ushort)((name.Length + 1) * 2)), Buffer = buffer };
            unicodePointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UNICODE_STRING))); Marshal.StructureToPtr(unicode, unicodePointer, false);
            var attributes = new OBJECT_ATTRIBUTES { Length = Marshal.SizeOf(typeof(OBJECT_ATTRIBUTES)), RootDirectory = parent.DangerousGetHandle(), ObjectName = unicodePointer, Attributes = OBJ_CASE_INSENSITIVE };
            var io = new IO_STATUS_BLOCK(); SafeFileHandle handle; var options = FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT | (directory ? FILE_DIRECTORY_FILE : FILE_NON_DIRECTORY_FILE);
            var status = NtCreateFile(out handle, access | SYNCHRONIZE, ref attributes, ref io, IntPtr.Zero, 0, share, FILE_OPEN, options, IntPtr.Zero, 0);
            if (status != 0) { if (handle != null) handle.Dispose(); throw new Win32Exception((int)RtlNtStatusToDosError(status), "相对打开失败：" + name + "（NTSTATUS 0x" + status.ToString("x8") + "）"); }
            return handle;
        } finally { if (unicodePointer != IntPtr.Zero) Marshal.FreeHGlobal(unicodePointer); Marshal.FreeHGlobal(buffer); }
    }
    private static SafeFileHandle OpenVerifiedDeleteRelative(SafeFileHandle parent, string name, string expectedIdentity, string expectedHash, long expectedSize, string label, out FILE_BASIC_INFO originalAttributes, out bool attributesChanged)
    {
        originalAttributes = new FILE_BASIC_INFO(); attributesChanged = false; var handle = OpenRelative(parent, name, GENERIC_READ | DELETE, false, FILE_SHARE_READ);
        try { VerifyIdentity(handle, expectedIdentity, label); Verify(handle, expectedHash, expectedSize, label); ReadBasicInformation(handle, out originalAttributes); if ((originalAttributes.FileAttributes & FILE_ATTRIBUTE_READONLY) == 0) return handle; handle.Dispose(); handle = OpenRelative(parent, name, GENERIC_READ | DELETE | FILE_WRITE_ATTRIBUTES, false, FILE_SHARE_READ); VerifyIdentity(handle, expectedIdentity, label); Verify(handle, expectedHash, expectedSize, label); attributesChanged = ClearReadOnly(handle, out originalAttributes); return handle; }
        catch { RestoreAttributes(handle, originalAttributes, attributesChanged); handle.Dispose(); throw; }
    }
    private static SafeFileHandle OpenIdentityDeleteRelative(SafeFileHandle parent, string name, string expectedIdentity, bool directory, string label, out FILE_BASIC_INFO originalAttributes, out bool attributesChanged)
    {
        originalAttributes = new FILE_BASIC_INFO(); attributesChanged = false; var handle = OpenRelative(parent, name, GENERIC_READ | DELETE, directory, FILE_SHARE_READ);
        try { VerifyIdentity(handle, expectedIdentity, label); return handle; } catch { handle.Dispose(); throw; }
    }
    private static SafeFileHandle OpenVerifiedDelete(string filePath, string expectedIdentity, string expectedHash, long expectedSize, string label, out FILE_BASIC_INFO originalAttributes, out bool attributesChanged)
    {
        originalAttributes = new FILE_BASIC_INFO(); attributesChanged = false;
        var deletable = OpenLocked(filePath, GENERIC_READ | DELETE);
        try {
            VerifyIdentity(deletable, expectedIdentity, label); Verify(deletable, expectedHash, expectedSize, label); ReadBasicInformation(deletable, out originalAttributes);
            if ((originalAttributes.FileAttributes & FILE_ATTRIBUTE_READONLY) == 0) return deletable;
            deletable.Dispose(); deletable = OpenLocked(filePath, GENERIC_READ | DELETE | FILE_WRITE_ATTRIBUTES);
            VerifyIdentity(deletable, expectedIdentity, label); Verify(deletable, expectedHash, expectedSize, label); attributesChanged = ClearReadOnly(deletable, out originalAttributes); return deletable;
        } catch { RestoreAttributes(deletable, originalAttributes, attributesChanged); deletable.Dispose(); throw; }
    }
    private static SafeFileHandle OpenIdentityDelete(string filePath, string expectedIdentity, bool directory, string label, out FILE_BASIC_INFO originalAttributes, out bool attributesChanged)
    {
        originalAttributes = new FILE_BASIC_INFO(); attributesChanged = false; var handle = OpenLocked(filePath, GENERIC_READ | DELETE, directory);
        try { VerifyIdentity(handle, expectedIdentity, label); if (directory) return handle; ReadBasicInformation(handle, out originalAttributes); if ((originalAttributes.FileAttributes & FILE_ATTRIBUTE_READONLY) == 0) return handle; handle.Dispose(); handle = OpenLocked(filePath, GENERIC_READ | DELETE | FILE_WRITE_ATTRIBUTES, false); VerifyIdentity(handle, expectedIdentity, label); attributesChanged = ClearReadOnly(handle, out originalAttributes); return handle; }
        catch { RestoreAttributes(handle, originalAttributes, attributesChanged); handle.Dispose(); throw; }
    }
    private static string Identity(SafeFileHandle handle) { BY_HANDLE_FILE_INFORMATION info; if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error()); return info.VolumeSerialNumber.ToString("x8") + ":" + info.FileIndexHigh.ToString("x8") + ":" + info.FileIndexLow.ToString("x8"); }
    private static void VerifyIdentity(SafeFileHandle handle, string expectedIdentity, string label) { if (!String.Equals(Identity(handle), expectedIdentity, StringComparison.OrdinalIgnoreCase)) throw new OwnershipConflictException(label + "身份已变化"); }
    private static void Verify(SafeFileHandle handle, string expectedHash, long expectedSize, string label)
    {
        var stream = new FileStream(handle, FileAccess.Read, 1024 * 1024, false);
        if (stream.Length != expectedSize) throw new InvalidDataException(label + "大小与预期不一致");
        using (var sha = SHA256.Create()) {
            var actual = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
            if (!String.Equals(actual, expectedHash, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException(label + "摘要与预期不一致");
        }
        GC.SuppressFinalize(stream);
    }
    private static void MarkDelete(SafeFileHandle handle)
    {
        var info = new FILE_DISPOSITION_INFO { DeleteFile = true };
        if (!SetFileInformationByHandle(handle, FileDispositionInfo, ref info, (uint)Marshal.SizeOf(typeof(FILE_DISPOSITION_INFO)))) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    private static void ReadBasicInformation(SafeFileHandle handle, out FILE_BASIC_INFO information) { if (!GetFileInformationByHandleEx(handle, FileBasicInfo, out information, (uint)Marshal.SizeOf(typeof(FILE_BASIC_INFO)))) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    private static bool ClearReadOnly(SafeFileHandle handle, out FILE_BASIC_INFO original) { ReadBasicInformation(handle, out original); if ((original.FileAttributes & FILE_ATTRIBUTE_READONLY) == 0) return false; var writable = original; writable.FileAttributes &= ~FILE_ATTRIBUTE_READONLY; if (!SetBasicInformationByHandle(handle, FileBasicInfo, ref writable, (uint)Marshal.SizeOf(typeof(FILE_BASIC_INFO)))) throw new Win32Exception(Marshal.GetLastWin32Error()); return true; }
    private static void RestoreAttributes(SafeFileHandle handle, FILE_BASIC_INFO original, bool changed) { if (changed && handle != null && !handle.IsInvalid && !handle.IsClosed && !SetBasicInformationByHandle(handle, FileBasicInfo, ref original, (uint)Marshal.SizeOf(typeof(FILE_BASIC_INFO)))) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    private static string Full(string value)
    {
        if (String.IsNullOrWhiteSpace(value)) throw new ArgumentException("路径为空");
        var input = value.Replace('/', '\\');
        if (input.StartsWith("\\\\?\\", StringComparison.Ordinal) || input.StartsWith("\\\\.\\", StringComparison.Ordinal) || input.StartsWith("\\??\\", StringComparison.Ordinal)) throw new ArgumentException("不接受设备或扩展路径输入");
        string root; string remainder;
        if (input.Length >= 3 && Char.IsLetter(input[0]) && input[1] == ':' && input[2] == '\\') { root = input.Substring(0, 3); remainder = input.Substring(3); }
        else if (input.StartsWith("\\\\", StringComparison.Ordinal)) {
            var parts = input.Substring(2).Split(new[] { '\\' }, StringSplitOptions.None);
            if (parts.Length < 2 || parts[0].Length == 0 || parts[1].Length == 0) throw new ArgumentException("UNC 路径缺少服务器或共享名");
            ValidateSegment(parts[0]); ValidateSegment(parts[1]);
            root = "\\\\" + parts[0] + "\\" + parts[1] + "\\"; remainder = String.Join("\\", parts.Skip(2).ToArray());
        } else throw new ArgumentException("路径必须是绝对驱动器路径或 UNC 路径");
        var segments = remainder.Split(new[] { '\\' }, StringSplitOptions.RemoveEmptyEntries);
        foreach (var segment in segments) ValidateSegment(segment);
        var normalized = root + String.Join("\\", segments);
        return normalized.StartsWith("\\\\", StringComparison.Ordinal) ? "\\\\?\\UNC\\" + normalized.Substring(2) : "\\\\?\\" + normalized;
    }
    private static void ValidateSegment(string segment) { if (segment == "." || segment == "..") throw new ArgumentException("路径不能包含相对段"); if (segment.EndsWith(" ", StringComparison.Ordinal) || segment.EndsWith(".", StringComparison.Ordinal)) throw new ArgumentException("路径段不能以空格或点结尾"); if (segment.IndexOfAny(new[] { '<', '>', '"', '|', '?', '*', ':' }) >= 0 || segment.Any(ch => ch < 32)) throw new ArgumentException("路径包含非法字符"); }
    private static void EnsureDistinct(string left, string right) { if (String.Equals(left, right, StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("源和目标不能相同"); }
    private static string NativeCode(int code) { if (code == 17) return "EXDEV"; if (code == 80 || code == 183) return "EEXIST"; if (code == 2 || code == 3) return "ENOENT"; if (code == 5 || code == 32) return "EBUSY"; if (code == 123 || code == 206) return "ENAMETOOLONG"; return "WIN32_" + code; }
    private static Dictionary<string, string> Parse(string[] args) { var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase); for (var i = 1; i + 1 < args.Length; i += 2) { if (!args[i].StartsWith("--")) throw new ArgumentException("参数格式无效"); result[args[i].Substring(2)] = args[i + 1]; } return result; }
    private static string Required(Dictionary<string, string> values, string key) { string value; if (!values.TryGetValue(key, out value) || String.IsNullOrWhiteSpace(value)) throw new ArgumentException("缺少参数：" + key); return value; }
    private static void Write(object value) { Console.WriteLine(new JavaScriptSerializer().Serialize(value)); }
}
