using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;

internal static class ShellThumbnailCache
{
    private const int MaximumRequestCharacters = 64 * 1024;
    private const string StagingDirectoryName = ".photoflow-thumbnail-staging";
    [StructLayout(LayoutKind.Sequential)]
    private struct NativeSize
    {
        public int Width;
        public int Height;
    }

    [Flags]
    private enum ShellImageFlags
    {
        ThumbnailOnly = 0x00000008,
        InCacheOnly = 0x00000010
    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b")]
    private interface IShellItemImageFactory
    {
        [PreserveSig]
        int GetImage(NativeSize size, ShellImageFlags flags, out IntPtr bitmapHandle);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    private static extern void SHCreateItemFromParsingName(
        [MarshalAs(UnmanagedType.LPWStr)] string path,
        IntPtr bindContext,
        ref Guid interfaceId,
        [MarshalAs(UnmanagedType.Interface)] out IShellItemImageFactory imageFactory);

    [DllImport("gdi32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DeleteObject(IntPtr objectHandle);

    private static string Decode(string value)
    {
        return Encoding.UTF8.GetString(Convert.FromBase64String(value));
    }

    private static string Encode(string value)
    {
        return Convert.ToBase64String(Encoding.UTF8.GetBytes(value ?? String.Empty));
    }

    private static void AssertTargetIsNotReparsePoint(string path)
    {
        if (File.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            throw new IOException("Thumbnail target cannot be a reparse point");
    }

    private static void SaveJpeg(string sourcePath, string targetPath, int requestedSize, bool cacheOnly)
    {
        targetPath = Path.GetFullPath(targetPath);
        AssertTargetIsNotReparsePoint(targetPath);
        var interfaceId = typeof(IShellItemImageFactory).GUID;
        IShellItemImageFactory factory = null;
        IntPtr bitmapHandle = IntPtr.Zero;

        try
        {
            SHCreateItemFromParsingName(sourcePath, IntPtr.Zero, ref interfaceId, out factory);
            var size = Math.Max(160, Math.Min(1600, requestedSize));
            var flags = ShellImageFlags.ThumbnailOnly;
            if (cacheOnly) flags |= ShellImageFlags.InCacheOnly;
            var result = factory.GetImage(
                new NativeSize { Width = size, Height = size },
                flags,
                out bitmapHandle);
            if (result < 0 || bitmapHandle == IntPtr.Zero)
                Marshal.ThrowExceptionForHR(result);

            var directory = Path.GetDirectoryName(targetPath);
            if (!String.IsNullOrWhiteSpace(directory)) Directory.CreateDirectory(directory);
            var stagingDirectory = Path.Combine(directory, StagingDirectoryName);
            Directory.CreateDirectory(stagingDirectory);
            if ((File.GetAttributes(stagingDirectory) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("Thumbnail staging directory cannot be a reparse point");
            foreach (var stalePath in Directory.EnumerateFiles(stagingDirectory, "*.tmp"))
            {
                try
                {
                    var attributes = File.GetAttributes(stalePath);
                    if ((attributes & FileAttributes.ReparsePoint) == 0 && File.GetLastWriteTimeUtc(stalePath) < DateTime.UtcNow.AddDays(-1))
                        File.Delete(stalePath);
                }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
            var temporaryPath = Path.Combine(stagingDirectory, Guid.NewGuid().ToString("N") + ".tmp");
            var ownsTemporaryPath = false;

            try
            {
                using (var bitmap = Image.FromHbitmap(bitmapHandle))
                {
                    var encoder = ImageCodecInfo.GetImageEncoders().First(item => item.FormatID == ImageFormat.Jpeg.Guid);
                    using (var parameters = new EncoderParameters(1))
                    {
                        parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 82L);
                        using (var temporaryStream = new FileStream(temporaryPath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                        {
                            ownsTemporaryPath = true;
                            bitmap.Save(temporaryStream, encoder, parameters);
                            temporaryStream.Flush(true);
                        }
                    }
                }

                if (File.Exists(targetPath)) File.Replace(temporaryPath, targetPath, null);
                else File.Move(temporaryPath, targetPath);
                ownsTemporaryPath = false;
            }
            finally
            {
                if (ownsTemporaryPath && File.Exists(temporaryPath)) File.Delete(temporaryPath);
            }
        }
        finally
        {
            if (bitmapHandle != IntPtr.Zero) DeleteObject(bitmapHandle);
            if (factory != null && Marshal.IsComObject(factory)) Marshal.FinalReleaseComObject(factory);
        }
    }

    [STAThread]
    private static void Main()
    {
        Console.InputEncoding = Encoding.UTF8;
        Console.OutputEncoding = Encoding.UTF8;
        string line;
        while ((line = Console.ReadLine()) != null)
        {
            var fields = line.Split('\t');
            var requestId = fields.Length > 0 ? fields[0] : String.Empty;
            if (line.Length > MaximumRequestCharacters || (fields.Length != 4 && fields.Length != 5))
            {
                Console.WriteLine(requestId + "\t0\t" + Encode("Protocol error: expected 4 or 5 tab-separated fields"));
                Console.Out.Flush();
                continue;
            }
            try
            {
                var requestedSize = Int32.Parse(fields[1]);
                if (requestedSize <= 0 || requestedSize > 16384)
                    throw new FormatException("Protocol error: requested size is outside the supported range");
                var cacheOnly = fields.Length == 4 || fields[4] != "generate";
                SaveJpeg(Decode(fields[2]), Decode(fields[3]), requestedSize, cacheOnly);
                Console.WriteLine(requestId + "\t1\t");
            }
            catch (Exception error)
            {
                // A cache miss is expected and intentionally stays on stdout so
                // the Node client can fall back without treating it as a crash.
                Console.WriteLine(requestId + "\t0\t" + Encode(error.ToString()));
            }
            Console.Out.Flush();
        }
    }
}
