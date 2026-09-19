using System;
using System.Collections;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class FileClipboardService
{
    private const string DropEffectFormat = "Preferred DropEffect";
    private const int RetryCount = 8;
    private const uint CF_HDROP = 15;
    private const uint FileCountIndex = 0xffffffff;
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

    [DllImport("user32.dll")]
    private static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool OpenClipboard(IntPtr owner);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool CloseClipboard();
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool EmptyClipboard();
    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr GetClipboardData(uint format);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint RegisterClipboardFormat(string format);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GlobalLock(IntPtr memory);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GlobalUnlock(IntPtr memory);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern uint DragQueryFile(IntPtr drop, uint index, StringBuilder path, uint pathLength);

    [STAThread]
    private static int Main(string[] args)
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        try
        {
            if (args.Length != 1) throw new ArgumentException("需要 write、read 或 clear-if-current 命令");
            object result;
            switch (args[0])
            {
                case "write": result = Write(ReadRequest()); break;
                case "read": result = Read(); break;
                case "clear-if-current": result = ClearIfCurrent(ReadRequest()); break;
                default: throw new ArgumentException("未知命令：" + args[0]);
            }
            Console.WriteLine(Json.Serialize(result));
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.ToString());
            Console.WriteLine(Json.Serialize(new { success = false, code = "FILE_CLIPBOARD_FAILED", error = error.Message }));
            return 1;
        }
    }

    private static Dictionary<string, object> ReadRequest()
    {
        var input = Console.In.ReadToEnd();
        if (String.IsNullOrWhiteSpace(input)) return new Dictionary<string, object>();
        return Json.Deserialize<Dictionary<string, object>>(input);
    }

    private static T Retry<T>(Func<T> action)
    {
        Exception last = null;
        for (var attempt = 0; attempt < RetryCount; attempt++)
        {
            try { return action(); }
            catch (ExternalException error)
            {
                last = error;
                if (attempt + 1 < RetryCount) Thread.Sleep(35 + attempt * 20);
            }
        }
        throw new InvalidOperationException("Windows 剪贴板正忙，请稍后重试", last);
    }

    private static string[] Sources(Dictionary<string, object> request)
    {
        object raw;
        if (!request.TryGetValue("sources", out raw) || raw == null) return new string[0];
        var values = raw as object[];
        var list = raw as ArrayList;
        if (values == null && list != null) values = list.ToArray();
        if (values == null) values = new object[0];
        return values.Select(value => Path.GetFullPath(Convert.ToString(value)))
            .Where(value => !String.IsNullOrWhiteSpace(value)).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
    }

    private static object Write(Dictionary<string, object> request)
    {
        var sources = Sources(request);
        if (sources.Length == 0) throw new ArgumentException("没有可写入剪贴板的文件");
        if (sources.Any(source => !File.Exists(source) && !Directory.Exists(source))) throw new FileNotFoundException("剪贴板源文件不存在");
        object rawOperation;
        var operation = request.TryGetValue("operation", out rawOperation) ? Convert.ToString(rawOperation) : "copy";
        if (operation != "copy" && operation != "cut") throw new ArgumentException("无效的剪贴板操作");
        Retry(() =>
        {
            var files = new StringCollection();
            files.AddRange(sources);
            var data = new DataObject();
            data.SetFileDropList(files);
            data.SetData(DropEffectFormat, false, new MemoryStream(BitConverter.GetBytes(operation == "cut" ? 2 : 1)));
            Clipboard.SetDataObject(data, true);
            return true;
        });
        var verified = (Dictionary<string, object>)Read();
        var verifiedSources = (string[])verified["sources"];
        if (!SameSources(sources, verifiedSources) || Convert.ToString(verified["operation"]) != operation)
            throw new InvalidOperationException("写入后回读验证失败");
        return new { success = true, sources = verifiedSources, operation, sequence = verified["sequence"] };
    }

    private static object Read()
    {
        Exception last = null;
        for (var attempt = 0; attempt < RetryCount; attempt++)
        {
            try
            {
                var before = GetClipboardSequenceNumber();
                var snapshot = ReadDataObject(Clipboard.GetDataObject());
                var after = GetClipboardSequenceNumber();
                if (before == after)
                    return new Dictionary<string, object> { { "success", true }, { "sources", snapshot.Item1 }, { "operation", snapshot.Item2 }, { "sequence", after } };
                last = new ExternalException("读取期间剪贴板内容发生变化");
            }
            catch (ExternalException error) { last = error; }
            if (attempt + 1 < RetryCount) Thread.Sleep(35 + attempt * 20);
        }
        throw new InvalidOperationException("无法取得一致的 Windows 剪贴板快照", last);
    }

    private static Tuple<string[], string> ReadDataObject(IDataObject data)
    {
        var files = new string[0];
        var operation = "copy";
        if (data != null)
        {
            if (data.GetDataPresent(DataFormats.FileDrop, false))
            {
                var dropped = data.GetData(DataFormats.FileDrop, false) as string[];
                if (dropped != null) files = dropped.Select(Path.GetFullPath).ToArray();
            }
            if (data.GetDataPresent(DropEffectFormat, false))
            {
                var effect = ReadEffect(data.GetData(DropEffectFormat, false));
                if ((effect & 2) == 2) operation = "cut";
            }
        }
        return Tuple.Create(files, operation);
    }

    private static int ReadEffect(object value)
    {
        var stream = value as Stream;
        if (stream != null)
        {
            stream.Position = 0;
            var bytes = new byte[4];
            return stream.Read(bytes, 0, bytes.Length) > 0 ? BitConverter.ToInt32(bytes, 0) : 0;
        }
        var raw = value as byte[];
        return raw != null && raw.Length >= 4 ? BitConverter.ToInt32(raw, 0) : 0;
    }

    private static object ClearIfCurrent(Dictionary<string, object> request)
    {
        object rawSequence;
        var expectedSequence = request.TryGetValue("sequence", out rawSequence) ? Convert.ToUInt32(rawSequence) : 0;
        var expectedSources = Sources(request);
        return Retry<object>(() =>
        {
            if (!OpenClipboard(IntPtr.Zero)) throw new ExternalException("无法锁定 Windows 剪贴板", Marshal.GetLastWin32Error());
            try
            {
                var sequence = GetClipboardSequenceNumber();
                var snapshot = ReadOpenClipboard();
                var matches = sequence == GetClipboardSequenceNumber() && snapshot.Item2 == "cut" && SameSources(expectedSources, snapshot.Item1);
                matches = matches && sequence == expectedSequence;
                if (matches && !EmptyClipboard()) throw new ExternalException("无法清空 Windows 剪贴板", Marshal.GetLastWin32Error());
                return new { success = true, cleared = matches, sequence = GetClipboardSequenceNumber(), sources = matches ? new string[0] : snapshot.Item1, operation = matches ? "copy" : snapshot.Item2 };
            }
            finally { CloseClipboard(); }
        });
    }

    private static Tuple<string[], string> ReadOpenClipboard()
    {
        var files = new List<string>();
        var dropHandle = GetClipboardData(CF_HDROP);
        if (dropHandle != IntPtr.Zero)
        {
            var dropPointer = GlobalLock(dropHandle);
            if (dropPointer == IntPtr.Zero) throw new ExternalException("无法锁定剪贴板文件列表", Marshal.GetLastWin32Error());
            try
            {
                var count = DragQueryFile(dropHandle, FileCountIndex, null, 0);
                for (uint index = 0; index < count; index++)
                {
                    var length = DragQueryFile(dropHandle, index, null, 0);
                    var value = new StringBuilder(checked((int)length + 1));
                    if (DragQueryFile(dropHandle, index, value, (uint)value.Capacity) == 0) throw new ExternalException("无法读取剪贴板文件路径");
                    files.Add(Path.GetFullPath(value.ToString()));
                }
            }
            finally { GlobalUnlock(dropHandle); }
        }
        var operation = "copy";
        var effectFormat = RegisterClipboardFormat(DropEffectFormat);
        if (effectFormat == 0) throw new ExternalException("无法注册剪贴板拖放格式", Marshal.GetLastWin32Error());
        var effectHandle = GetClipboardData(effectFormat);
        if (effectHandle != IntPtr.Zero)
        {
            var effectPointer = GlobalLock(effectHandle);
            if (effectPointer == IntPtr.Zero) throw new ExternalException("无法锁定剪贴板拖放效果", Marshal.GetLastWin32Error());
            try { if ((Marshal.ReadInt32(effectPointer) & 2) == 2) operation = "cut"; }
            finally { GlobalUnlock(effectHandle); }
        }
        return Tuple.Create(files.ToArray(), operation);
    }

    private static bool SameSources(IEnumerable<string> left, IEnumerable<string> right)
    {
        var first = left.Select(Path.GetFullPath).OrderBy(value => value, StringComparer.OrdinalIgnoreCase).ToArray();
        var second = right.Select(Path.GetFullPath).OrderBy(value => value, StringComparer.OrdinalIgnoreCase).ToArray();
        return first.Length == second.Length && first.SequenceEqual(second, StringComparer.OrdinalIgnoreCase);
    }

}
